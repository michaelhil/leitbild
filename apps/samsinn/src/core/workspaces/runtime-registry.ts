// ============================================================================
// WorkspaceRuntimeRegistry — per-tenant RoomDirectory lifecycle keyed by Workspace ID.
//
// One process holds many Workspaces; each is a SamsinnWorkspaceRuntime bound to its own
// snapshot file. The registry lazy-loads from disk on first request,
// keeps the SamsinnWorkspaceRuntime in memory while active, and evicts idle ones after
// SAMSINN_IDLE_MS (default 30 min) by flushing snapshot + dropping the
// in-memory reference. Subsequent requests lazy-reload from disk.
//
// Concurrency contract:
//   - `pendingLoads` dedupes concurrent first-time loads of the same id.
//   - In-map entries can be in `state: 'active' | 'evicting'`.
//     New requests during eviction await the eviction completion, then
//     load fresh from disk.
//   - All maps are mutated only on the event loop thread (single-threaded
//     JS); no locks needed. The discipline is: never `await` between a
//     state read and a state write that depends on it.
//
// Public surface:
//   getOrLoad(id)           — single source of truth; touches lastTouchedAt
//   evictOne(id)            — graceful: drain → flush → drop. Idempotent.
//   evictIdle(now, idleMs)  — periodic sweep
//   resetWorkspaceState(id)       — wipe state, return new id (for /api/system/reset)
//   exists(id)              — disk OR memory
//   list()                  — readonly meta for admin
//   shutdown()              — flush all + clear
//
// What lives outside the registry's concern:
//   - Snapshot path resolution (uses workspacePaths from core/paths.ts)
//   - Per-Workspace event-callback wiring (wireWorkspaceRuntimeEvents)
//   - Janitor (Workspace-cleanup.ts) — operates on disk only
//
// === buildWorkspaceRuntime ordering (subtle; was the source of 5d73a8e) ===
// Inside buildWorkspaceRuntime(id):
//   1. createSamsinnWorkspaceRuntime(...)           — new in-memory SamsinnWorkspaceRuntime, no events wired.
//   2. loadSnapshot + restoreFromSnapshot  — agents rehydrated.
//   3. buildAutoSaver              — debounced snapshot writer.
//   4. opts.onWorkspaceRuntimeCreated(...)   — caller's wiring runs HERE.
//   5. seedWorkspace(system) (if no snapshot)  — Cafe + Aiden + You.
//   6. return { system, autoSaver }
// THEN in getOrLoad:
//   7. map.set(id, entry)          — registry knows about the system.
//
// Steps 4 runs BEFORE step 7. Inside the hook, `registry.autoSaverFor(id)`
// returns null (the entry isn't in the map yet) and `tryGetLive(id)` returns
// undefined. Anything the hook needs that depends on per-id state must be
// passed in directly — that's why onWorkspaceRuntimeCreated takes (system, id, autoSaver)
// as arguments, not just (system, id). Resist any refactor that moves
// "look up the saver from the registry" into the hook.
// ============================================================================

import type { SamsinnWorkspaceRuntime } from '../../main.ts'
import type { DeploymentRuntime } from '../deployment-runtime.ts'
import { createSamsinnWorkspaceRuntime } from '../../main.ts'
import {
  loadSnapshot, restoreFromSnapshot, createAutoSaver, type AutoSaver,
} from '../storage/snapshot.ts'
import { workspacePaths, isValidWorkspaceId, sharedPaths } from '../paths.ts'
import { readdir, rename, rm, stat } from 'node:fs/promises'
import { asAIAgent } from '../../agents/shared.ts'
import { seedWorkspace } from './seed-workspace.ts'
import type { WorkspaceId } from '@samsinn-leitbild/platform-contracts'

// --- Defaults & env ---

const DEFAULT_IDLE_MS = 30 * 60_000   // 30 min
const DEFAULT_DRAIN_MS = 5_000
// The production service has a 2 GiB cgroup cap. A seeded Workspace currently
// costs roughly 1 MiB, so 128 leaves ample room for shared provider/catalog/UI
// state and transient generation spikes while still supporting far more
// concurrent rooms than the sandbox normally sees.
const DEFAULT_MAX_LOADED_WORKSPACES = 128

const idleMsFromEnv = (): number => {
  const v = process.env.SAMSINN_IDLE_MS
  if (!v) return DEFAULT_IDLE_MS
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_MS
}

const maxLoadedWorkspacesFromEnv = (): number => {
  const v = process.env.SAMSINN_MAX_LOADED_WORKSPACES
  if (!v) return DEFAULT_MAX_LOADED_WORKSPACES
  const n = Number(v)
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_LOADED_WORKSPACES
}

// --- Types ---

export interface WorkspaceRuntimeMeta {
  readonly id: WorkspaceId
  readonly lastTouchedAt: number
  readonly state: 'active' | 'evicting'
}

export interface WorkspaceModuleOnDisk {
  readonly id: WorkspaceId
  readonly snapshotMtimeMs: number   // 0 if snapshot file is missing
  readonly snapshotSizeBytes: number // 0 if snapshot file is missing
}

interface WorkspaceRuntimeEntry {
  readonly system: SamsinnWorkspaceRuntime
  readonly autoSaver: AutoSaver
  readonly onIdle: () => Promise<void>          // hook called by registry on evict
  lastTouchedAt: number
  state: 'active' | 'evicting'
  evictionPromise?: Promise<void>               // present iff state='evicting'
}

export interface WorkspaceRuntimeRegistryOptions {
  readonly deployment: DeploymentRuntime
  readonly idleMs?: number                      // override default 30 min
  readonly drainMs?: number                     // override default 5s
  readonly maxLoadedWorkspaces?: number          // hard LRU safety bound
  // Hook called immediately after a fresh SamsinnWorkspaceRuntime is constructed (either
  // first load or post-eviction reload). Bootstrap wires WS broadcasts here.
  // The autoSaver is passed in directly because the registry's map entry
  // isn't set until AFTER this hook returns — so registry.autoSaverFor(id)
  // would return null inside the hook. Subtle and was the source of a
  // long-running bug where streaming events never reached cookie-bound
  // Workspaces.
  //
  // The hook is awaited. It MUST complete (wireAgentTracking +
  // wireWorkspaceRuntimeEvents installed) before seedWorkspace runs — otherwise
  // the seeded AI bypasses the spawn-wrapper and never gets per-agent
  // hooks (state subscription, attachAgent). Returning Promise<void> is
  // mandatory for any hook that does async work.
  readonly onWorkspaceRuntimeCreated?: (runtime: SamsinnWorkspaceRuntime, id: WorkspaceId, autoSaver: AutoSaver) => Promise<void> | void
  // Hook called immediately before a SamsinnWorkspaceRuntime is dropped from memory.
  // Bootstrap removes the WS callback wiring here.
  readonly onWorkspaceRuntimeEvicted?: (runtime: SamsinnWorkspaceRuntime, id: WorkspaceId) => void
  // Fires exactly once, after the first successful getOrLoad in this
  // process. Replaces the boot-time validateBootstrap call: the contract
  // check still runs before any traffic actually reaches a SamsinnWorkspaceRuntime, but
  // we don't materialize a throwaway boot Workspace just to validate.
  // Receives the Workspace id so contract checks can verify per-Workspace
  // wiring (e.g. wsManager.isWired(id)).
  readonly onFirstLoad?: (runtime: SamsinnWorkspaceRuntime, id: WorkspaceId) => void
}

export interface WorkspaceRuntimeRegistry {
  readonly getOrLoad: (id: WorkspaceId) => Promise<SamsinnWorkspaceRuntime>
  readonly evictOne: (id: WorkspaceId) => Promise<void>
  readonly evictIdle: (now?: number) => Promise<number>
  // Delete the Workspace module's on-disk state and drop it from memory. The same id
  // is preserved — browser keeps its cookie, next request lazy-creates a
  // fresh empty RoomDirectory under the same id.
  readonly resetWorkspaceState: (id: WorkspaceId) => Promise<void>
  readonly exists: (id: WorkspaceId) => Promise<boolean>
  readonly list: () => ReadonlyArray<WorkspaceRuntimeMeta>
  // Enumerate every valid Workspace directory under SAMSINN_HOME/workspaces,
  // returning snapshot mtime + size. Includes Workspaces not currently in
  // memory. Used by the Workspaces UI.
  readonly listOnDisk: () => Promise<ReadonlyArray<WorkspaceModuleOnDisk>>
  readonly shutdown: () => Promise<void>
  // For tests + boundary handlers that need to know the configured timer.
  readonly idleMs: () => number
  readonly maxLoadedWorkspaces: () => number
  // Boundary access to the in-memory autosaver for an active Workspace.
  // wireWorkspaceRuntimeEvents needs it to schedule saves from broadcast callbacks.
  // Returns null if the Workspace is not currently in memory.
  readonly autoSaverFor: (id: WorkspaceId) => AutoSaver | null
  // In-memory only lookup. Returns the live SamsinnWorkspaceRuntime for `id` if it is
  // currently loaded and active (not evicting), else undefined.
  //
  // SILENTLY returns undefined for evicted/unloaded Workspaces. Every
  // existing caller depends on this — late provider events drop, WS
  // snapshot building closes the socket with 4001, cross-Workspace fan-
  // outs skip the missing Workspace. If you need a hard error or you
  // need to materialize the system, use `getOrLoad` instead. Adding a
  // call site that quietly skips when the answer should be "load this"
  // is how silent-skip bugs hide — see CLAUDE.md "no silent skips on
  // optional dependencies."
  readonly tryGetLive: (id: WorkspaceId) => SamsinnWorkspaceRuntime | undefined
  // Agent → Workspace reverse index for provider routing events. Bootstrap
  // wires shared.setProviderEventDispatcher to use this.
  readonly attachAgent: (agentId: string, workspaceId: WorkspaceId) => void
  readonly detachAgent: (agentId: string) => void
  readonly workspaceForAgent: (agentId: string) => WorkspaceId | undefined
}

// ============================================================================

export const createWorkspaceRuntimeRegistry = (opts: WorkspaceRuntimeRegistryOptions): WorkspaceRuntimeRegistry => {
  const idleMs = opts.idleMs ?? idleMsFromEnv()
  const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS
  const maxLoadedWorkspaces = opts.maxLoadedWorkspaces ?? maxLoadedWorkspacesFromEnv()
  if (!Number.isSafeInteger(maxLoadedWorkspaces) || maxLoadedWorkspaces <= 0) {
    throw new Error(`[registry] maxLoadedWorkspaces must be a positive integer; got ${String(maxLoadedWorkspaces)}`)
  }
  const map = new Map<WorkspaceId, WorkspaceRuntimeEntry>()
  const pendingLoads = new Map<WorkspaceId, Promise<SamsinnWorkspaceRuntime>>()
  // Reverse index for provider event routing. Populated when an agent
  // is spawned in an Workspace; cleared on agent removal or Workspace evict.
  const agentWorkspaceMap = new Map<string, WorkspaceId>()

  // --- Internals ---

  // A5: two-phase drain.
  //   Phase 1 — race natural idle vs drainMs timeout. Most evals finish well
  //   under the limit; this is the happy path.
  //   Phase 2 — anything still generating (slow LLM, network hang) gets
  //   cancelled. cancelGeneration aborts the AbortController and clears the
  //   active flag synchronously; whenIdle resolves on the next microtask.
  //   A short final wait (100ms) converges. Without this, an agent stuck in
  //   eval would have its result land in the now-evicted system as a ghost
  //   message on next reload.
  const drainAgents = async (system: SamsinnWorkspaceRuntime): Promise<void> => {
    const timeout = new Promise<void>(res => setTimeout(res, drainMs))
    const aiAgents = system.team.listAgents()
      .flatMap(a => { const ai = asAIAgent(a); return ai ? [ai] : [] })
    await Promise.all(aiAgents.map(a => Promise.race([a.whenIdle(), timeout])))
    // Cancel anything still generating after the timeout.
    let cancelled = 0
    for (const a of aiAgents) {
      if (a.state.get() === 'generating') {
        a.cancelGeneration()
        cancelled++
      }
    }
    if (cancelled > 0) {
      const finalTimeout = new Promise<void>(res => setTimeout(res, 100))
      await Promise.all(aiAgents.map(a => Promise.race([a.whenIdle(), finalTimeout])))
    }
  }

  // Build the per-Workspace autosaver. Callback wiring (which schedules
  // save on each mutation) lives in src/api/wire-workspace-runtime-events.ts, which
  // gets the saver via autoSaverFor(id). The onWorkspaceRuntimeCreated hook calls
  // wireWorkspaceRuntimeEvents — that's the single source of save scheduling.
  const buildAutoSaver = (_system: SamsinnWorkspaceRuntime, snapshotPath: string): AutoSaver =>
    createAutoSaver(_system, snapshotPath)

  // Build a fresh SamsinnWorkspaceRuntime for `id`, restoring from snapshot if present.
  // Note: we DO NOT mkdir here. The Workspace dir is created lazily by
  // saveSnapshot's own mkdir(recursive) on the first real autosave write.
  //
  // Drive-by traffic (bots, monitoring probes, anonymous home-page hits)
  // is now stopped one layer up: server.ts serves static paths before
  // getOrLoad runs, and handleAPI rejects cookieless /api/* with 401.
  // So this factory is reached only when there's a deliberate session
  // signal (the UI opening /ws, or an explicit /api call from a cookie
  // holder). Stale cookies for purged ids are soft-expired by server.ts
  // before they reach getOrLoad.
  const buildWorkspaceRuntime = async (id: WorkspaceId): Promise<{ system: SamsinnWorkspaceRuntime; autoSaver: AutoSaver }> => {
    const paths = workspacePaths(id)
    const system = createSamsinnWorkspaceRuntime({
      deployment: opts.deployment,
      workspaceLabel: id,
      vectorsFile: paths.vectors,
    })

    // Restore snapshot if file exists. Corrupt snapshots get renamed
    // aside so the next save doesn't silently overwrite recoverable data.
    const snapshot = await loadSnapshot(paths.snapshot)
    if (snapshot) {
      try {
        await restoreFromSnapshot(system, snapshot)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error(`[registry] restore failed for ${id}: ${reason}`)
        // Move bad file aside, continue with an empty Workspace runtime.
        const aside = `${paths.snapshot}.corrupt.${Date.now()}.json`
        try { await rename(paths.snapshot, aside) } catch { /* ignore */ }
      }
    }

    const autoSaver = buildAutoSaver(system, paths.snapshot)

    // Notify the registry's caller (e.g. WS broadcast wiring). autoSaver
    // is passed explicitly because the map entry isn't installed until
    // buildWorkspaceRuntime returns; an autoSaverFor(id) lookup inside the hook
    // would return null.
    //
    // AWAITED on purpose: the hook installs wireAgentTracking (the spawn
    // wrapper that installs per-agent state subscriptions, provider-event
    // attach, etc.) and wireWorkspaceRuntimeEvents (the system-wide WS broadcast
    // subscribers). seedWorkspace below calls system.spawnAIAgent — if it
    // ran before the wrapper was installed, the seeded agent would bypass
    // per-agent wiring (no thinking indicator, no state broadcasts, no
    // provider-event scoping). The hook is async because of logging.configure;
    // without await, the first await inside the hook releases a microtask
    // and seedWorkspace races ahead.
    await opts.onWorkspaceRuntimeCreated?.(system, id, autoSaver)

    // First-run seeding: when no snapshot existed, or when an older/broken
    // boot left an explicitly empty snapshot, spawn Cafe + Aiden + You.
    // An empty snapshot is equivalent to a fresh Workspace: it contains no
    // user state to preserve, and otherwise permanently suppresses the seed
    // on every reload. Skipped when SAMSINN_SEED_EXAMPLE=0 (legacy env).
    const snapshotIsEmpty = snapshot !== null
      && snapshot.rooms.length === 0
      && snapshot.agents.length === 0
      && snapshot.humans.length === 0
    if ((!snapshot || snapshotIsEmpty) && process.env.SAMSINN_SEED_EXAMPLE !== '0') {
      try {
        await seedWorkspace(system)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error(`[registry] seedWorkspace threw (continuing with empty RoomDirectory): ${reason}`)
      }
      // Persist the seed so a refresh keeps it (without waiting for the
      // autosaver's debounce). Best-effort — autosaver will retry on its
      // own schedule if this throws.
      try { await autoSaver.flush() } catch { /* autosaver will retry */ }
    }

    return { system, autoSaver }
  }

  // --- Public API ---

  let firstLoadFired = false
  const fireFirstLoadOnce = (system: SamsinnWorkspaceRuntime, id: WorkspaceId): void => {
    if (firstLoadFired) return
    firstLoadFired = true
    try { opts.onFirstLoad?.(system, id) } catch (err) {
      // Re-throw — the onFirstLoad contract check is meant to crash boot
      // when wiring is broken. Suppressing it would resurrect the silent-
      // skip class of bug the contract guards.
      firstLoadFired = false
      throw err
    }
  }

  const evictForCapacity = async (): Promise<number> => {
    const excess = map.size - maxLoadedWorkspaces + 1
    if (excess <= 0) return 0
    const targets = [...map.entries()]
      .filter(([, entry]) => entry.state === 'active')
      .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt)
      .slice(0, excess)
      .map(([id]) => id)
    await Promise.all(targets.map(evictOne))
    return targets.length
  }

  // Cold loads build independently, then serialize only the capacity check
  // and map insertion. Without this short queue, two completed loads can both
  // observe one free slot and push the registry past its configured bound.
  let capacityMutation = Promise.resolve()
  const installLoadedEntry = async (id: WorkspaceId, entry: WorkspaceRuntimeEntry): Promise<number> => {
    let evicted = 0
    const operation = capacityMutation.then(async () => {
      evicted = await evictForCapacity()
      map.set(id, entry)
    })
    capacityMutation = operation.then(() => undefined, () => undefined)
    await operation
    return evicted
  }

  const getOrLoad = async (id: WorkspaceId): Promise<SamsinnWorkspaceRuntime> => {
    if (!isValidWorkspaceId(id)) {
      throw new Error(`[registry] invalid Workspace id: ${id}`)
    }

    // Fast path: in-map and not evicting.
    const existing = map.get(id)
    if (existing && existing.state === 'active') {
      existing.lastTouchedAt = Date.now()
      fireFirstLoadOnce(existing.system, id)
      return existing.system
    }

    // Mid-eviction: wait for it to complete, then re-enter for a fresh load.
    if (existing && existing.state === 'evicting' && existing.evictionPromise) {
      await existing.evictionPromise
      return getOrLoad(id)
    }

    // Pending first-load by another caller: await same promise.
    const pending = pendingLoads.get(id)
    if (pending) return pending

    // Cold path: register the pending promise, do the work, transfer to map.
    const loadPromise = (async (): Promise<SamsinnWorkspaceRuntime> => {
      try {
        const { system, autoSaver } = await buildWorkspaceRuntime(id)
        const entry: WorkspaceRuntimeEntry = {
          system,
          autoSaver,
          lastTouchedAt: Date.now(),
          state: 'active',
          onIdle: async () => { /* set later if needed */ },
        }
        const evicted = await installLoadedEntry(id, entry)
        if (evicted > 0) {
          console.warn(`[registry] capacity ${maxLoadedWorkspaces} reached; evicted ${evicted} least-recently-used Workspace(s)`)
        }
        fireFirstLoadOnce(system, id)
        return system
      } finally {
        pendingLoads.delete(id)
      }
    })()
    pendingLoads.set(id, loadPromise)
    return loadPromise
  }

  // Idempotent: calling evictOne twice (or while another caller is also
  // evicting) returns the same in-flight promise.
  const evictOne = async (id: WorkspaceId): Promise<void> => {
    const entry = map.get(id)
    if (!entry) return
    if (entry.state === 'evicting' && entry.evictionPromise) {
      return entry.evictionPromise
    }

    const evictionPromise = (async (): Promise<void> => {
      await drainAgents(entry.system).catch(err => {
        console.error(`[registry] evict ${id} drain failed (continuing): ${err instanceof Error ? err.message : String(err)}`)
      })

      // Bounded-retry flush. Originally this was a single try/catch that
      // dropped the entry from memory regardless — meaning a failed save
      // (disk full, perm flip) silently lost recent state on next load.
      // Retry with backoff; only force-evict (with ERROR log noting the
      // data-loss risk) if every attempt fails.
      const backoffMs = [5_000, 15_000, 60_000]
      let lastErr: unknown = null
      let flushed = false
      for (let attempt = 0; attempt < backoffMs.length; attempt++) {
        try {
          await entry.autoSaver.flush()
          flushed = true
          break
        } catch (err) {
          lastErr = err
          opts.deployment.limitMetrics.inc('evictionFlushRetries')
          const reason = err instanceof Error ? err.message : String(err)
          console.error(`[registry] evict ${id} flush attempt ${attempt + 1}/${backoffMs.length} failed: ${reason}`)
          if (attempt < backoffMs.length - 1) {
            await new Promise(resolve => setTimeout(resolve, backoffMs[attempt]))
          }
        }
      }
      if (!flushed) {
        opts.deployment.limitMetrics.inc('evictionForceEvicts')
        const reason = lastErr instanceof Error ? lastErr.message : String(lastErr)
        console.error(`[registry] evict ${id}: flush exhausted retries — FORCING EVICTION; recent state may be lost. last error: ${reason}`)
      }

      try { opts.onWorkspaceRuntimeEvicted?.(entry.system, id) } catch (err) {
        console.error(`[registry] evict ${id} hook threw: ${err instanceof Error ? err.message : String(err)}`)
      }
      entry.autoSaver.dispose()
      // Stop the per-Workspace schedulers' setIntervals. Without this, the
      // timer closures pin the entire SamsinnWorkspaceRuntime (RoomDirectory + agents + history) and
      // keep firing every tick on an evicted Workspace — memory leak +
      // wasted CPU proportional to (evicted-with-active-schedulers) ×
      // tick frequency. autoSaver.dispose handles its own debounce timer;
      // these handle theirs.
      try { entry.system.triggerScheduler.stop() } catch (err) {
        console.error(`[registry] evict ${id} triggerScheduler.stop threw: ${err instanceof Error ? err.message : String(err)}`)
      }
      try { entry.system.summaryScheduler.dispose() } catch (err) {
        console.error(`[registry] evict ${id} summaryScheduler.dispose threw: ${err instanceof Error ? err.message : String(err)}`)
      }
      // Stop any active script runs. Less leak risk than the scheduler
      // intervals (no setInterval pinning the SamsinnWorkspaceRuntime), but in-flight LLM
      // whisper calls + bounded setTimeouts keep the closure alive briefly;
      // explicit stop releases queue chains and any spawned cast that
      // wasn't already drained. Best-effort — eviction proceeds regardless.
      try {
        for (const run of entry.system.scriptRunner.listRuns()) {
          void entry.system.scriptRunner.stop(run.roomId).catch(() => { /* best-effort */ })
        }
      } catch (err) {
        console.error(`[registry] evict ${id} scriptRunner cleanup threw: ${err instanceof Error ? err.message : String(err)}`)
      }
      map.delete(id)
    })()

    entry.state = 'evicting'
    entry.evictionPromise = evictionPromise
    return evictionPromise
  }

  const evictIdle = async (now: number = Date.now()): Promise<number> => {
    const targets: WorkspaceId[] = []
    for (const [id, entry] of map) {
      if (entry.state === 'active' && now - entry.lastTouchedAt > idleMs) {
        targets.push(id)
      }
    }
    await Promise.all(targets.map(evictOne))
    return targets.length
  }

  const resetWorkspaceState = async (id: WorkspaceId): Promise<void> => {
    if (!isValidWorkspaceId(id)) {
      throw new Error(`[registry] invalid Workspace id: ${id}`)
    }
    // Drain + drop from memory.
    if (map.has(id)) await evictOne(id)
    // Reset is intentionally destructive. Snapshot compatibility is a clean
    // break and this architecture pass does not retain migration/archive data.
    const paths = workspacePaths(id)
    await rm(paths.root, { recursive: true, force: true })
    // Same id is preserved. Browser cookie unchanged. Next request →
    // registry.getOrLoad(id) → no in-memory + no disk → fresh RoomDirectory.
  }

  const exists = async (id: WorkspaceId): Promise<boolean> => {
    if (!isValidWorkspaceId(id)) return false
    if (map.has(id)) return true
    try {
      await stat(workspacePaths(id).snapshot)
      return true
    } catch {
      return false
    }
  }

  const list = (): ReadonlyArray<WorkspaceRuntimeMeta> =>
    [...map.entries()].map(([id, e]) => ({
      id,
      lastTouchedAt: e.lastTouchedAt,
      state: e.state,
    }))

  const listOnDisk = async (): Promise<ReadonlyArray<WorkspaceModuleOnDisk>> => {
    const root = sharedPaths.workspacesRoot()
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      return []   // root doesn't exist yet — first boot
    }
    const out: WorkspaceModuleOnDisk[] = []
    for (const name of entries) {
      // Skip anything that is not a canonical Workspace id.
      if (!isValidWorkspaceId(name)) continue
      let mtimeMs = 0
      let sizeBytes = 0
      try {
        const st = await stat(workspacePaths(name).snapshot)
        mtimeMs = st.mtimeMs
        sizeBytes = st.size
      } catch {
        // No snapshot yet (just-created Workspace) — directory exists, file doesn't.
      }
      out.push({ id: name, snapshotMtimeMs: mtimeMs, snapshotSizeBytes: sizeBytes })
    }
    return out
  }

  // Final flush of every active Workspace. Called from the SIGINT/SIGTERM
  // handler in bootstrap.ts (replaces the single-system flush).
  const shutdown = async (): Promise<void> => {
    const ids = [...map.keys()]
    await Promise.all(ids.map(evictOne))
  }

  const autoSaverFor = (id: WorkspaceId): AutoSaver | null => {
    const entry = map.get(id)
    return entry ? entry.autoSaver : null
  }

  const attachAgent = (agentId: string, workspaceId: WorkspaceId): void => {
    agentWorkspaceMap.set(agentId, workspaceId)
  }
  const detachAgent = (agentId: string): void => {
    agentWorkspaceMap.delete(agentId)
  }
  const workspaceForAgent = (agentId: string): WorkspaceId | undefined =>
    agentWorkspaceMap.get(agentId)

  const tryGetLive = (id: WorkspaceId): SamsinnWorkspaceRuntime | undefined => {
    const entry = map.get(id)
    if (!entry || entry.state !== 'active') return undefined
    return entry.system
  }

  return {
    getOrLoad,
    evictOne,
    evictIdle,
    resetWorkspaceState,
    exists,
    list,
    listOnDisk,
    shutdown,
    idleMs: () => idleMs,
    maxLoadedWorkspaces: () => maxLoadedWorkspaces,
    autoSaverFor,
    tryGetLive,
    attachAgent,
    detachAgent,
    workspaceForAgent,
  }
}
