// ============================================================================
// Agent Pack Manager — install / update / uninstall Packs from GitHub.
//
// A Pack is a git-cloned directory under ~/.leitbild/packs/<packId>/ with a
// required strict pack.json plus declared contribution directories. descriptor.id
// is canonical and must match the directory; it prefixes registered tools and
// skills to eliminate cross-Pack name collisions.
//
// Canonical Pack id resolution has one source of truth: pack.json descriptor.id.
//
// install_pack source forms:
//   - bare name `X`     → resolved against the registry (see registry.ts).
//                         No more "default org" guess — if X isn't in the
//                         registry, the call errors out.
//   - "user/repo"       → github.com/user/repo.git
//   - full URL          → cloned as-is (https://, ssh, file://, ...)
//
// Install flow: clone to a temp dir, read the manifest, resolve the canonical
// packId, then move the temp dir to the final path. This means the FINAL
// directory name always matches the canonical packId — so scanner-derived
// basename == registered tool/skill prefix == registry name. One source of
// truth, no prefix-stripping shims downstream.
//
// All shell-outs go through `Bun.$` tagged-template form so arguments are
// quoted correctly — never string-concatenated.
// ============================================================================

import type { ToolRegistry } from '../core/types/tool.ts'
import type { SkillStore } from '../skills/loader.ts'
import { loadPack } from './loader.ts'
import { readManifest } from './manifest.ts'
import { scanPacks } from './scanner.ts'
import { resolvePackLoadOrder } from './catalog.ts'
import { invalidateRegistryCache } from './registry.ts'
import { formatShellError } from '../core/redact.ts'
import { getBundledPack } from './bundled.ts'
import { createSerialiseChain, type SerialiseChain } from '../core/serialise-chain.ts'
import { stat, mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { $ } from 'bun'
import type { PackManifest } from './types.ts'
import type { AgentPackCatalog } from './agent-pack-catalog.ts'

// Pack ids are directory names and use the same safe token grammar.
const VALID_PACK_ID = /^[a-zA-Z0-9_-]+$/
const stripPackPrefix = (value: string): string => value.replace(/^leitbild-pack-/, '')

// B2: per-Pack serialisation. Concurrent install/update/uninstall on
// the SAME packId would otherwise race on `<ns>.prev`, the rename slot,
// and the registry teardown order. Different Packs install in
// parallel — chains are independent.
//
// Map cleanup happens on successful uninstall (delete the entry once the
// pack is gone). Without that, every install/uninstall cycle leaks an
// entry. Test-seam reset clears the map.
const packChains = new Map<string, SerialiseChain>()
const chainFor = (ns: string): SerialiseChain => {
  let c = packChains.get(ns)
  if (!c) { c = createSerialiseChain(); packChains.set(ns, c) }
  return c
}
export const __resetPackChains = (): void => { packChains.clear() }

type RefreshAllFn = () => Promise<void>

// Callback the host wires up to broadcast a system note to every
// room with AI agents whenever a pack's tools change. Without this, an
// agent that previously logged "tool unavailable" before a fix went in keeps
// its polluted chat history and pattern-matches against it on next turn,
// even though the tool now exists. The system note in-history breaks the
// pattern.
export type NotifyPacksChanged = (info: {
  readonly action: 'installed' | 'updated' | 'uninstalled'
  readonly packId: string
  readonly tools: ReadonlyArray<string>
  readonly skills: ReadonlyArray<string>
}) => void

export interface PackManagerResult {
  readonly success: boolean
  readonly data?: unknown
  readonly error?: string
}

export interface PackManager {
  readonly install: (source: string) => Promise<PackManagerResult>
  readonly update: (packId: string) => Promise<PackManagerResult>
  readonly uninstall: (packId: string) => Promise<PackManagerResult>
  readonly list: () => Promise<PackManagerResult>
  readonly listAvailable: () => Promise<PackManagerResult>
}

export interface PackManagerDeps {
  readonly mutationsEnabled: boolean
  readonly packsDir: string
  readonly toolRegistry: ToolRegistry
  readonly skillStore: SkillStore
  readonly catalog: AgentPackCatalog
  readonly refreshAllAgentTools: RefreshAllFn
  readonly notifyPacksChanged: NotifyPacksChanged
  // Removes the Pack from live Room Pack Sets and queues the same mutation
  // for unloaded Workspace snapshots before runtime contributions disappear.
  readonly scrubActivePacks: (packId: string) =>
    Promise<ReadonlyArray<{ roomId: string; activePacks: ReadonlyArray<string> }>>
    | ReadonlyArray<{ roomId: string; activePacks: ReadonlyArray<string> }>
  // Re-scan <pack>/geodata/*.geojson after lifecycle changes.
  readonly refreshPackGeodata: () => Promise<void>
  // Shared Script catalog refresh. Pack scripts are Deployment
  // contributions, while active Script runs remain per Workspace.
  readonly refreshPackScripts: () => Promise<void>
}

const refreshPackCatalogs = async (deps: PackManagerDeps): Promise<void> => {
  const refreshers = [deps.refreshPackGeodata, deps.refreshPackScripts]
  const results = await Promise.allSettled(refreshers.map(refresh => refresh()))
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more Pack contribution catalogs failed to refresh')
  }
}

// --- URL resolution ---
//
// resolveSource handles URL + user/repo forms. Bare names are resolved
// separately via the registry — see resolveBareName below. Splitting the two
// keeps URL parsing synchronous (no I/O) and forces the bare-name path to
// surface a clear error when the registry has no match.

interface ResolvedUrl {
  readonly url: string
  readonly sourceLabel: string   // basename used as the install fallback
}

const basenameFromUrl = (url: string): string => {
  const withoutGit = url.replace(/\.git\/?$/, '').replace(/\/+$/, '')
  const parts = withoutGit.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

const resolveSource = (source: string): ResolvedUrl | { error: string } => {
  const s = source.trim()
  if (!s) return { error: 'source is required' }

  // Full URL (anything with a scheme or @ for ssh).
  if (/^(https?:|ssh:|git:|file:)/i.test(s) || s.includes('@')) {
    const base = basenameFromUrl(s)
    if (!base) return { error: `Cannot derive a name from URL "${s}" — pass an explicit \`name\`` }
    return { url: s, sourceLabel: base }
  }

  // user/repo shorthand.
  if (s.includes('/')) {
    const parts = s.split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { error: `Invalid shorthand "${s}" — expected "user/repo"` }
    }
    return { url: `https://github.com/${parts[0]}/${parts[1]}.git`, sourceLabel: parts[1] }
  }

  // Bare names are not handled here — see resolveBareName.
  return { error: `Bare-name resolution requires the registry; got "${s}". Use \`user/repo\` or a full URL, or call list_available_packs to see what's available.` }
}

// Look up a bare name in the configured registry. Match by canonical name
// (registry already strips `leitbild-pack-` from repo names, see registry.ts)
// OR by the full repo basename — both forms are accepted so an agent that
// remembers either spelling resolves the same pack.
const resolveBareName = async (catalog: AgentPackCatalog, bareName: string): Promise<ResolvedUrl | { error: string }> => {
  if (!VALID_PACK_ID.test(bareName)) {
    return { error: `Invalid pack name "${bareName}" — use letters, digits, underscores, hyphens` }
  }
  let available
  try {
    available = await catalog.listAvailable()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { error: `Could not consult pack registry: ${reason}` }
  }
  const match = available.find(
    p => p.name === bareName || stripPackPrefix(p.name) === bareName,
  )
  if (!match) {
    return { error: `No pack named "${bareName}" in the registry. Configured sources: LEITBILD_PACK_SOURCES env. Use \`user/repo\` or a full URL to install from elsewhere.` }
  }
  return { url: `${match.repoUrl}.git`, sourceLabel: stripPackPrefix(match.name) }
}

const installPack = (deps: PackManagerDeps) => async (rawSource: string): Promise<PackManagerResult> => {
    if (!deps.mutationsEnabled) return { success: false, error: 'Pack mutations are disabled for this deployment' }
    const source = rawSource.trim()
    if (!source) return { success: false, error: 'source is required' }

    // `core` is reserved for built-in functionality; leitbild-core is a
    // read-only audit mirror, not an installable Pack.
    if (/(^|[/:])leitbild-core(\.git)?\/?$/i.test(source)) {
      return {
        success: false,
        error: '"core" is reserved for built-in functionality and cannot be installed as a Pack. The leitbild-core mirror exists for audit only.',
      }
    }

    const isBareName =
      !source.includes('/') &&
      !/^(https?:|ssh:|git:|file:)/i.test(source) &&
      !source.includes('@')
    if (isBareName && source === 'core') {
      return {
        success: false,
        error: '"core" is reserved for built-in functionality and cannot be installed as a Pack.',
      }
    }
    const resolved = isBareName ? await resolveBareName(deps.catalog, source) : resolveSource(source)
    if ('error' in resolved) return { success: false, error: resolved.error }

    // Ensure parent exists, then clone into a *temp* dir under packsDir so
    // we can read the manifest BEFORE picking the final destination.
    await $`mkdir -p ${deps.packsDir}`.quiet().nothrow()
    let tempDir: string
    try {
      tempDir = await mkdtemp(join(deps.packsDir, '.tmp-install-'))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { success: false, error: `Could not create temp dir for install: ${reason}` }
    }

    // C2: log cleanup failures rather than swallow. tempDirs that fail to rm
    // accumulate under packsDir as `.tmp-install-XXXXXX` (scanPacks skips
    // dotfiles, so they don't load as packs but waste disk). Surface so an
    // operator notices.
    const cleanup = async () => {
      try { await rm(tempDir, { recursive: true, force: true }) }
      catch (err) { console.warn(`[packs] failed to clean tempDir ${tempDir}:`, err) }
    }

    const clone = await $`git clone --depth 1 ${resolved.url} ${tempDir}`.quiet().nothrow()
    if (clone.exitCode !== 0) {
      await cleanup()
      return { success: false, error: `git clone failed: ${formatShellError(clone, 'git clone')}` }
    }

    let manifest: PackManifest
    try {
      manifest = await readManifest(tempDir)
    } catch (error) {
      await cleanup()
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    const packId = manifest.descriptor.id
    if (packId === 'core' || getBundledPack(packId) !== undefined) {
      await cleanup()
      return { success: false, error: `"${packId}" is reserved for built-in functionality and cannot be installed as a Pack` }
    }

    // B2: serialise the post-packId-resolution work for this packId.
    // Two concurrent installs of the same pack can't interleave the
    // stat/rename/loadPack sequence; the second waits for the first to
    // complete and then either sees "already installed" or proceeds cleanly
    // if the first rolled back.
    const finalPath = join(deps.packsDir, packId)
    return chainFor(packId).run(async () => {
      try {
        const s = await stat(finalPath)
        if (s.isDirectory()) {
          await cleanup()
          return { success: false, error: `Pack "${packId}" is already installed — use update_pack to refresh or uninstall_pack first` }
        }
      } catch { /* not present — proceed */ }

      try {
        await rename(tempDir, finalPath)
      } catch (err) {
        await cleanup()
        const reason = err instanceof Error ? err.message : String(err)
        return { success: false, error: `Could not move installed pack into place: ${reason}` }
      }

      try {
        resolvePackLoadOrder(await scanPacks(deps.packsDir))
      } catch (error) {
        try { await rm(finalPath, { recursive: true, force: true }) } catch { /* cleanup failure is surfaced by the original error */ }
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }

      const result = await loadPack(
        { id: packId, dirPath: finalPath, manifest },
        deps.toolRegistry,
        deps.skillStore,
      )

    // Transactional contract: if ANY tool or skill failed to load, roll back
    // everything (unregister anything that did register, remove the pack
    // directory) and return a typed failure. The agent must not be able to
    // see `success: true` while only half the pack's capabilities exist —
    // that is exactly the inconsistent-state bug that left agents claiming
    // Pack tools they didn't have.
    if (result.errors.length > 0) {
      deps.toolRegistry.unregisterByPack(packId)
      deps.skillStore.removeByPack(packId)
      try { await rm(finalPath, { recursive: true, force: true }) } catch { /* best-effort */ }
      return {
        success: false,
        error: `Pack "${packId}" failed to install cleanly — rolled back. ${result.errors.length} error(s):\n  • ${result.errors.join('\n  • ')}`,
      }
    }

    try { await deps.refreshAllAgentTools() } catch (err) {
      console.error(`[packs] refreshAllAgentTools failed after install "${packId}":`, err)
    }
    try { await refreshPackCatalogs(deps) }
    catch (err) { console.error('[packs] contribution catalog refresh failed:', err) }
    await deps.catalog.reload()
    deps.notifyPacksChanged({
      action: 'installed', packId: packId,
      tools: result.tools, skills: result.skills,
    })

      // C3: drop the registry cache so the next /api/packs/registry GET shows
      // this pack with `installed: true` instead of waiting up to 5 min.
      invalidateRegistryCache()

      return {
        success: true,
        data: {
          id: packId,
          url: resolved.url,
          tools: result.tools,
          skills: result.skills,
          manifest,
        },
      }
    })
}

const updatePack = (deps: PackManagerDeps) => async (rawPackId: string): Promise<PackManagerResult> => {
    if (!deps.mutationsEnabled) return { success: false, error: 'Pack mutations are disabled for this deployment' }
    const packId = rawPackId.trim()
    if (!VALID_PACK_ID.test(packId)) return { success: false, error: `Invalid pack name "${packId}"` }

    // B2: serialise per packId so concurrent update_pack calls on the
    // same pack don't race on `.prev` cp + git pull.
    return chainFor(packId).run(async () => {
    const dirPath = join(deps.packsDir, packId)
    const prevPath = `${dirPath}.prev`
    try {
      const s = await stat(dirPath)
      if (!s.isDirectory()) return { success: false, error: `Pack "${packId}" is not installed` }
    } catch {
      return { success: false, error: `Pack "${packId}" is not installed` }
    }

    let catalogBeforeUpdate
    try {
      catalogBeforeUpdate = await scanPacks(deps.packsDir)
      resolvePackLoadOrder(catalogBeforeUpdate)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }

    // Real rollback contract: copy current pack to <ns>.prev BEFORE any
    // mutation. If anything fails (pull, manifest, loadPack), restore from
    // .prev so the operator never loses a working install. install_pack
    // already gets this for free (no prior state); update_pack used to
    // rm -rf on partial failure, which destroyed the working version
    // because of one bad tool in the new revision.
    //
    // Existing .prev sibling means a prior update crashed mid-rollback —
    // refuse rather than clobber the recovery copy.
    try {
      const s = await stat(prevPath)
      if (s) {
        return {
          success: false,
          error: `Pack "${packId}" has an orphan .prev sibling at ${prevPath} from a prior failed update. Inspect + remove it before retrying update_pack.`,
        }
      }
    } catch { /* not present — proceed */ }

    const cp = await $`cp -R ${dirPath} ${prevPath}`.quiet().nothrow()
    if (cp.exitCode !== 0) {
      // Original is untouched; just surface the failure.
      try { await rm(prevPath, { recursive: true, force: true }) } catch { /* clean partial cp */ }
      return { success: false, error: `Could not snapshot pack for rollback: ${formatShellError(cp, 'cp -R')}` }
    }

    // Helper: restore from .prev. Re-runs loadPack against the restored
    // directory so tool + skill registries return to the prior state.
    // Narrow window (sub-ms): between the unregister-by-pack call and
    // the post-restore loadPack, an in-flight agent eval could observe
    // the pack as empty. Acceptable — alternative is a per-pack mutex
    // primitive that the rest of the registry doesn't have today.
    const restoreFromPrev = async (): Promise<string | null> => {
      deps.toolRegistry.unregisterByPack(packId)
      deps.skillStore.removeByPack(packId)
      try { await rm(dirPath, { recursive: true, force: true }) } catch { /* might be partial */ }
      try {
        await rename(prevPath, dirPath)
      } catch (err) {
        return `Restore failed during rename(.prev → pack): ${err instanceof Error ? err.message : String(err)}. Manual recovery: mv ${prevPath} ${dirPath}.`
      }
      const restoredManifest = await readManifest(dirPath)
      const restored = await loadPack(
        { id: packId, dirPath, manifest: restoredManifest },
        deps.toolRegistry,
        deps.skillStore,
      )
      if (restored.errors.length > 0) {
        return `Restore loadPack reported errors (pack on disk but registry partial): ${restored.errors.join('; ')}`
      }
      return null
    }

    const pull = await $`git -C ${dirPath} pull --ff-only`.quiet().nothrow()
    if (pull.exitCode !== 0) {
      // No registry mutation yet; just drop .prev and surface error.
      try { await rm(prevPath, { recursive: true, force: true }) } catch { /* best-effort */ }
      return { success: false, error: `git pull failed: ${formatShellError(pull, 'git pull')}` }
    }

    let manifest: PackManifest
    try {
      manifest = await readManifest(dirPath)
      if (manifest.descriptor.id !== packId) {
        throw new Error(`updated descriptor.id ${manifest.descriptor.id} does not match installed Pack id ${packId}`)
      }
      resolvePackLoadOrder(catalogBeforeUpdate.map(pack =>
        pack.id === packId ? { id: packId, dirPath, manifest } : pack,
      ))
    } catch (error) {
      const restoreErr = await restoreFromPrev()
      const reason = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        error: `Pack "${packId}" has an invalid update and was rolled back: ${reason}${restoreErr ? ` (rollback also failed: ${restoreErr})` : ''}`,
      }
    }

    // The candidate manifest and dependency graph are valid. Replace the
    // runtime contributions only after those read-only checks complete.
    deps.toolRegistry.unregisterByPack(packId)
    deps.skillStore.removeByPack(packId)

    const result = await loadPack(
      { id: packId, dirPath, manifest },
      deps.toolRegistry,
      deps.skillStore,
    )

    // Transactional contract: if any errors, restore from .prev so the
    // operator's working install survives a bad upstream commit. activePacks
    // is untouched (we never scrubbed) so rooms reactivate cleanly.
    if (result.errors.length > 0) {
      const restoreErr = await restoreFromPrev()
      const restoreNote = restoreErr ? ` (rollback also failed: ${restoreErr})` : ' — rolled back to previous version.'
      return {
        success: false,
        error: `Pack "${packId}" failed to update cleanly${restoreNote} ${result.errors.length} error(s):\n  • ${result.errors.join('\n  • ')}`,
      }
    }

    // Success: drop the .prev snapshot.
    try { await rm(prevPath, { recursive: true, force: true }) }
    catch (err) { console.warn(`[packs] failed to clean .prev snapshot for "${packId}":`, err) }

    try { await deps.refreshAllAgentTools() } catch (err) {
      console.error(`[packs] refreshAllAgentTools failed after update "${packId}":`, err)
    }
    try { await refreshPackCatalogs(deps) }
    catch (err) { console.error('[packs] contribution catalog refresh failed:', err) }
    await deps.catalog.reload()
    deps.notifyPacksChanged({
      action: 'updated', packId: packId,
      tools: result.tools, skills: result.skills,
    })

    return {
      success: true,
      data: {
        id: packId,
        tools: result.tools,
        skills: result.skills,
        manifest,
        stdout: pull.stdout.toString().trim(),
      },
    }
    })  // chainFor.run
}

const uninstallPack = (deps: PackManagerDeps) => async (rawPackId: string): Promise<PackManagerResult> => {
    if (!deps.mutationsEnabled) return { success: false, error: 'Pack mutations are disabled for this deployment' }
    const packId = rawPackId.trim()
    if (!VALID_PACK_ID.test(packId)) return { success: false, error: `Invalid pack name "${packId}"` }

    // B2: serialise per packId so concurrent uninstall + install / update
    // on the same packId can't interleave.
    return chainFor(packId).run(async () => {
    const dirPath = join(deps.packsDir, packId)
    try {
      const s = await stat(dirPath)
      if (!s.isDirectory()) return { success: false, error: `Pack "${packId}" is not installed` }
    } catch {
      return { success: false, error: `Pack "${packId}" is not installed` }
    }

    try {
      const packs = await scanPacks(deps.packsDir)
      const dependents = packs.filter(pack =>
        pack.id !== packId
        && pack.manifest.descriptor.dependencies.some(dependency => dependency.id === packId),
      )
      if (dependents.length > 0) {
        return {
          success: false,
          error: `Pack "${packId}" is required by: ${dependents.map(pack => pack.id).sort().join(', ')}`,
        }
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }

    // Step 1: scrub activePacks across every room before tearing down the
    // registry. Order matters — once tools/skills are unregistered, an
    // agent eval against an active room with a stale activePacks entry
    // would see the pack's resolved-to-empty surface and behave oddly.
    // Scrubbing first means rooms transition cleanly from "active with
    // tools" to "no longer active" with no intermediate broken state.
    const scrubbed = await deps.scrubActivePacks(packId)

    // Step 2: registry teardown. unregisterByPack returns the keys that
    // were removed so we can report and audit. Both are synchronous so
    // there's no half-state window between them.
    const removedTools = deps.toolRegistry.unregisterByPack(packId)
    const removedSkills = deps.skillStore.removeByPack(packId)

    // Step 3: refresh agent surfaces so live evals see the new state on
    // their next call. refreshTools is idempotent; an error here means
    // some agent's tool list is stale until next spawn — log loudly,
    // don't fail the uninstall (the registry teardown already succeeded
    // and rolling back would leave a worse partial state).
    try { await deps.refreshAllAgentTools() } catch (err) {
      console.error(`[packs] refreshAllAgentTools failed after uninstall "${packId}":`, err)
    }
    // Step 4: remove the Pack before refreshing filesystem-derived catalogs.
    // If this fails the runtime state is consistent (registry
    // is clean, rooms are scrubbed, agents refreshed) but the directory
    // lingers — operator can rm by hand. Surface as a partial success so
    // the caller knows manual cleanup is needed.
    const rm = await $`rm -rf ${dirPath}`.quiet().nothrow()
    if (rm.exitCode !== 0) {
      return {
        success: false,
        error: `Unregistered from runtime + scrubbed ${scrubbed.length} room(s), but failed to delete directory: ${formatShellError(rm, 'rm -rf')}`,
      }
    }
    await deps.catalog.reload()
    await refreshPackCatalogs(deps)

    // Step 5: notify after every deployment catalog reflects removal.
    deps.notifyPacksChanged({
      action: 'uninstalled', packId: packId,
      tools: removedTools, skills: removedSkills,
    })

    // C3: drop the registry cache so the next /api/packs/registry GET shows
    // this pack with `installed: false` instead of waiting up to 5 min.
    invalidateRegistryCache()

    // B2: cleanup the per-Pack chain entry now that the pack is gone.
    // Without this, every install/uninstall cycle leaks a chain.
    packChains.delete(packId)

    return {
      success: true,
      data: {
        id: packId,
        removedTools,
        removedSkills,
        // Diagnostic: which rooms were scrubbed and what their new
        // activePacks lists look like. Useful for auditing + the WS
        // broadcast layer that needs to fan out per-room events.
        scrubbedRooms: scrubbed,
      },
    }
    })  // chainFor.run
}

const listPacks = (deps: PackManagerDeps) => async (): Promise<PackManagerResult> =>
  ({ success: true, data: deps.catalog.list() })

const listAvailablePacks = (deps: PackManagerDeps) => async (): Promise<PackManagerResult> => {
  try {
    return { success: true, data: await deps.catalog.listAvailable() }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { success: false, error: `registry fetch failed: ${reason}` }
  }
}

export const createPackManager = (deps: PackManagerDeps): PackManager => ({
  install: installPack(deps),
  update: updatePack(deps),
  uninstall: uninstallPack(deps),
  list: listPacks(deps),
  listAvailable: listAvailablePacks(deps),
})
