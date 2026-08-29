// ============================================================================
// Bootstrap — Startup logic for direct execution.
//
// Builds the shared runtime, the WorkspaceRuntimeRegistry, the WS manager, the
// janitor, and either the HTTP+WS server or the headless MCP stdio server.
//
// Multi-tenant: WorkspaceRuntimeRegistry holds N per-cookie systems. Each one is
// lazy-loaded on first request, evicted after SAMSINN_IDLE_MS (default
// 30 min), and persisted at $SAMSINN_HOME/Workspaces/<id>/snapshot.json.
// Shared runtime: provider router, gateways, ProviderKeys, MCP tools.
//
// === Construction order (matters; do not reshuffle without thinking) ===
//
//   1. DeploymentRuntime  — provider router, gateways, shared registry/store.
//   2. MCP tools      — register into deployment.sharedToolRegistry once.
//   3. Process tools  — pure / network / codegen tools registered once
//                       into shared (gated by SAMSINN_ENABLE_*).
//   4. WorkspaceRuntimeRegistry — onWorkspaceRuntimeCreated hook closes over wsManager (set in 5).
//   5. wsManager      — assigned BEFORE any registry.getOrLoad runs, so
//                       the hook always sees a defined value. Failure to
//                       respect this is how 5d73a8e happened: any cookie-
//                       bound Workspace whose onWorkspaceRuntimeCreated fired with
//                       wsManager undefined silently skipped wireWorkspaceRuntimeEvents.
//   6. Pack admin     — install/update/uninstall_pack registered last
//                       because they need the cross-Workspace refresh
//                       callback that walks `registry.list()`.
//   7. Boot system    — getOrLoad seeds the first cookieless visitor.
//                       wsManager already exists; onWorkspaceRuntimeCreated wires it.
//   8. Janitor + timers + HTTP server.
//
// Single wiring path: every Workspace (boot AND cookie-bound) gets its
// broadcasts wired by the same onWorkspaceRuntimeCreated hook. There is NO rescue
// branch elsewhere in this file. If you find yourself reaching for one,
// the lifecycle invariant above is broken — fix it there.
// ============================================================================

import { createWorkspaceRuntimeRegistry } from './core/workspaces/runtime-registry.ts'
import { DEFAULTS } from './core/types/constants.ts'
import { registerAllMCPServers } from './integrations/mcp/client.ts'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadExternalTools } from './tools/loader.ts'
import { loadSkills } from './skills/loader.ts'
import { loadAllPacks } from './packs/loader.ts'
import { createPolicyStore } from './llm/llm-policy-store.ts'
import { asAIAgent } from './agents/shared.ts'
import { warmProviderModels } from './llm/providers-setup.ts'
import { parseLogConfigFromEnv } from './logging/config.ts'
import { sharedPaths, workspacePaths } from './core/paths.ts'
import { appendPendingScrub } from './core/storage/snapshot.ts'
import { createToolRegistry } from './core/tool-registry.ts'
import { wireWorkspaceRuntimeEvents } from './api/wire-workspace-runtime-events.ts'
import { wireAgentTracking } from './api/agent-tracking.ts'
import { validateBootstrap } from './boot/validate.ts'
import { buildProviderStack, summariseProviders } from './boot/provider-stack.ts'
import { createWSManager } from './api/ws-handler.ts'
// Process-wide tool factories. Anything that doesn't bind to a per-Workspace
// Deployment-scoped tools register into deployment.sharedToolRegistry once at boot, not per
// Workspace — see registerSharedTools below.
import {
  createPassTool, createGetTimeTool, createTestToolTool, createListSkillsTool,
  createWebTools, createWriteSkillTool, createWriteToolTool, createPackTools,
  createGeoLookupTool, createGeoAddTool, createGeoRemoveTool, createGeoListCategoriesTool, createGeoListFeaturesTool,
} from './tools/built-in/index.ts'
import { runGeodataMigrationOnce } from './geo/migrate.ts'
import { createLocalWorkspaceDirectory } from './core/workspaces/directory.ts'
import { newWorkspaceId, type WorkspaceId } from '@samsinn-leitbild/platform-contracts'
import type { WorkspaceAdmin } from './api/routes/types.ts'

const DRAIN_TIMEOUT_MS = 5_000

export const bootstrap = async (): Promise<void> => {
  const headless = process.argv.includes('--headless')
  const ephemeral = process.env.SAMSINN_EPHEMERAL === '1'

  if (headless) {
    const stderrLog = (...args: unknown[]) => console.error(...args)
    console.log = stderrLog
    console.info = stderrLog
  }

  // === Provider stack ===
  // All the wiring (config → keys → setup → DeploymentRuntime) lives in one
  // place: src/boot/provider-stack.ts. That's where the bug class fixed
  // in commits f04e61e / d0c1f73 / 3729e50 surfaced; isolating the order
  // keeps the contract obvious.
  const { providerConfig, deployment } = await buildProviderStack()
  const workspaceDirectory = createLocalWorkspaceDirectory({
    path: sharedPaths.workspaceDirectory(),
    defaultDisplayName: 'Samsinn Workspace',
  })
  const providerSetup = deployment.providerSetup

  // Load LLM policy (system default fallback chain). Persisted at
  // ~/.samsinn/llm-policy.json; UI edits via Settings → Providers take
  // effect at request time without restart. Bootstrapped from
  // SAMSINN_DEFAULT_MODEL_FALLBACK env on first run if file is missing.
  const envChainRaw = (process.env.SAMSINN_DEFAULT_MODEL_FALLBACK ?? '').trim()
  const envChain = envChainRaw ? envChainRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined
  const { store: llmPolicyStore, warnings: policyWarnings } = await createPolicyStore({
    path: sharedPaths.llmPolicy(),
    ...(envChain && envChain.length > 0 ? { envChain } : {}),
  })
  for (const w of policyWarnings) console.warn(`[llm-policy] ${w}`)
  deployment.llmPolicyStore = llmPolicyStore

  const pkg = await Bun.file(`${import.meta.dir}/../package.json`).json() as { version: string }
  console.log(`Samsinn v${pkg.version}${headless ? ' (headless)' : ''}`)
  if (ephemeral) console.log('[bootstrap] ephemeral mode — snapshot disabled')
  console.log(summariseProviders(providerConfig))

  // === Boot logging template ===
  // Each per-Workspace system applies this in its onWorkspaceRuntimeCreated hook.
  const bootLogConfig = parseLogConfigFromEnv()

  // === MCP tools — load once at boot ===
  // Each MCP server is a stdio child process. We register the Tool[]
  // definitions directly into deployment.sharedToolRegistry so every per-Workspace
  // overlay can resolve them; the underlying connection is deployment. Also kept
  // on deployment.mcpTools as a list for any consumer that needs the raw set.
  const mcpConfigPath = `${import.meta.dir}/../mcp-servers.json`
  let mcpDisconnect = async (): Promise<void> => {}
  if (existsSync(mcpConfigPath)) {
    const tempRegistry = createToolRegistry()
    const result = await registerAllMCPServers(tempRegistry, await Bun.file(mcpConfigPath).json())
    deployment.mcpTools.push(...tempRegistry.list())
    for (const tool of tempRegistry.list()) {
      try { deployment.sharedToolRegistry.register(tool) } catch { /* duplicate ignored */ }
    }
    mcpDisconnect = result.disconnect
  }

  // === One-shot filesystem migration (idempotent via sentinel) ===
  // Moves drop-in dirs into the synthetic 'local' pack so the layout
  // matches every other pack. Tarball-backed; refuses to clobber if
  // both old and new locations already have content. See migrate-local-
  // pack.ts.
  {
    const { migrateLocalPack } = await import('./core/migrate-local-pack.ts')
    const result = await migrateLocalPack(sharedPaths.root())
    if (result.status === 'migrated') {
      const summary = (result.moved ?? []).map(m => `${m.dir}=${m.count}`).join(' ')
      console.log(`[migrate] moved drop-ins → packs/local/ (${summary}); backup: ${result.backupPath}`)
    } else if (result.status === 'failed') {
      console.error(`[migrate] failed: ${result.reason}`)
      console.error('[migrate] samsinn will continue with whatever paths sharedPaths.* now resolves to. Resolve manually then restart.')
    }
    // 'skipped' is the steady-state — silent.
  }

  // === Process-wide tool/skill/pack scan — once, into shared ===
  // Single FS scan: external tools, free-standing skills (cwd + samsinn-home),
  // and packs all register into the SHARED registry/store. Per-Workspace
  // Systems wrap this in an overlay (see createSamsinnWorkspaceRuntime in main.ts).
  // Replaces the old per-Workspace loaders that ran inside onWorkspaceRuntimeCreated
  // and re-scanned everything for every cookie that hit the server.
  await loadExternalTools(deployment.sharedToolRegistry)
  await loadSkills(resolve(process.cwd(), 'skills'), deployment.sharedSkillStore, deployment.sharedToolRegistry)
  await loadSkills(sharedPaths.skills(), deployment.sharedSkillStore, deployment.sharedToolRegistry)
  await loadAllPacks(sharedPaths.packs(), deployment.sharedToolRegistry, deployment.sharedSkillStore)

  // Bundled packs — compiled into the binary. Each pack's tools register
  // with kind:'pack-bundled' + pack:<namespace> so per-room activation
  // (room.activePacks) actually gates them. The packs themselves are
  // declared in src/packs/bundled.ts (the BUNDLED_PACKS table — single
  // source of truth for namespace, system flag, default-active flag).
  //
  // Bundled-pack tools are exempt from the `<pack>_<tool>` registry-key
  // prefix convention that filesystem packs follow (loadToolDirectory
  // applies the prefix; we don't go through it here). When pwr-ops
  // graduates to a filesystem registry pack (samsinn-packs/pwr-ops),
  // tool names will need a rename pass at that migration point.
  {
    const { BUNDLED_DEMO_TOOLS } = await import('./packs/synthetic-demos/tools/index.ts')
    for (const tool of BUNDLED_DEMO_TOOLS) {
      deployment.sharedToolRegistry.registerWithSource(tool, { kind: 'pack-bundled', pack: 'demos', displayName: tool.name })
    }
    const { PWR_OPS_TOOLS } = await import('./packs/pwr-ops/index.ts')
    for (const tool of PWR_OPS_TOOLS) {
      deployment.sharedToolRegistry.registerWithSource(tool, { kind: 'pack-bundled', pack: 'pwr-ops', displayName: tool.name })
    }
  }

  // Pack-bundled geodata: scan ~/.samsinn/packs/<ns>/geodata/*.geojson and
  // load into the in-memory pack-source cache. Features are tagged
  // source='pack', pack=<ns> so the room-aware filter can gate them per
  // activePacks. Failures per-pack are logged but don't abort boot —
  // bad geodata in one pack shouldn't sink samsinn.
  {
    const { refreshPackGeodata } = await import('./geo/pack-source.ts')
    const packGeoState = await refreshPackGeodata(sharedPaths.packs())
    if (packGeoState.perPackFeatureCounts.size > 0) {
      const counts = [...packGeoState.perPackFeatureCounts.entries()]
        .map(([ns, n]) => `${ns}=${n}`)
        .join(' ')
      console.log(`[geo/pack] loaded: ${counts}`)
    }
    for (const e of packGeoState.errors) {
      console.warn(`[geo/pack] ${e.pack}/${e.file}: ${e.reason}`)
    }
  }

  // Bundled example scripts are loaded read-only from examples/scripts/ via
  // ScriptStore's extraSourceDirs (wired in main.ts). Nothing is copied into
  // $SAMSINN_HOME/scripts/ — that directory holds user-authored scripts only.
  //
  // One-shot migration for installs that ran the OLD seeder (which copied
  // bundled examples into $SAMSINN_HOME/scripts/). For each bundled example,
  // if the user-dir copy is byte-identical to the bundled one, delete it (it
  // was a seed, not an edit). If contents differ, leave it alone — the user
  // edited it; the ScriptStore's collision detection will throw at boot with
  // both paths and the user can rename or delete the stale one. Sidecar from
  // the old seeder is removed unconditionally.
  try {
    const { rm, readFile, readdir } = await import('node:fs/promises')
    const userScriptsDir = sharedPaths.scripts()
    const bundledDir = resolve(process.cwd(), 'examples', 'scripts')
    const sidecar = resolve(userScriptsDir, '.seeded.json')
    if (existsSync(sidecar)) await rm(sidecar, { force: true })
    let bundledNames: string[] = []
    try { bundledNames = (await readdir(bundledDir)).filter(n => n.endsWith('.md')) } catch { /* no bundled */ }
    let removed = 0
    for (const name of bundledNames) {
      const userPath = resolve(userScriptsDir, name)
      if (!existsSync(userPath)) continue
      try {
        const [a, b] = await Promise.all([readFile(userPath, 'utf-8'), readFile(resolve(bundledDir, name), 'utf-8')])
        if (a === b) { await rm(userPath, { force: true }); removed++ }
      } catch { /* read failure → leave alone */ }
    }
    if (removed > 0) console.log(`[scripts] migration: removed ${removed} stale seeded copies (byte-identical to bundled)`)
  } catch { /* best-effort */ }

  // === Process-wide built-in tools (no per-Workspace state) ===
  // Anything that doesn't bind to a per-Workspace RoomDirectory registers ONCE here.
  // RoomDirectory-bound tools (room ops, artifacts, post_to_room, …) stay in
  // createSamsinnWorkspaceRuntime and live in the per-Workspace overlay.
  const isDeployMode = !!(process.env.SAMSINN_TOKEN && process.env.SAMSINN_TOKEN.length > 0)
  const flag = (name: string, defaultOn: boolean): boolean => {
    const v = process.env[name]
    if (v === '1') return true
    if (v === '0') return false
    return defaultOn
  }
  const networkToolsEnabled = flag('SAMSINN_ENABLE_NETWORK_TOOLS', !isDeployMode)
  // codegenEnabled gates write_skill + write_tool only — agents writing
  // arbitrary TypeScript into ~/.samsinn/. Default-off in deploy mode is
  // the right call there.
  const codegenEnabled = flag('SAMSINN_ENABLE_CODEGEN', !isDeployMode)
  // packsEnabled gates install/update/uninstall/list_packs and
  // list_available_packs — installing a vetted GitHub pack is a different
  // threat profile (you trust the pack's source) than an agent producing
  // arbitrary TS. Default-on everywhere; operator can flip to 0 to lock
  // the runtime to whatever is on disk at boot.
  const packsEnabled = flag('SAMSINN_ENABLE_PACKS', true)

  deployment.sharedToolRegistry.register(createPassTool())
  deployment.sharedToolRegistry.register(createGetTimeTool())
  deployment.sharedToolRegistry.register(createTestToolTool(deployment.sharedToolRegistry))
  deployment.sharedToolRegistry.register(createListSkillsTool(deployment.sharedSkillStore))
  // Geo: one-shot migration of any pre-registry layout, then register the
  // shared geodata tools. The migration is idempotent — subsequent boots
  // see the registry file and do nothing.
  await runGeodataMigrationOnce()
  // Forward-bound resolver: registry is created later in this function,
  // but createGeoLookupTool is constructed now. We hand the tool a closure
  // that will read from `registry` at call time — by which point it's been
  // assigned (the closure can't fire before bootstrap completes since the
  // tool registry isn't reachable until that happens).
  const getRoomActivePacksForGeo = (roomId: string): ReadonlyArray<string> | undefined => {
    for (const meta of registry.list()) {
      const sys = registry.tryGetLive(meta.id)
      if (!sys) continue
      const room = sys.rooms.getRoom(roomId)
      if (room) return room.getActivePacks()
    }
    return undefined
  }
  deployment.sharedToolRegistry.register(createGeoLookupTool({ getActivePacks: getRoomActivePacksForGeo }))
  deployment.sharedToolRegistry.register(createGeoAddTool())
  deployment.sharedToolRegistry.register(createGeoRemoveTool())
  deployment.sharedToolRegistry.register(createGeoListCategoriesTool())
  deployment.sharedToolRegistry.register(createGeoListFeaturesTool())
  // Leitbild agent tools (V2.A) — visible to all rooms, but each requires
  // the caller's agent to have a leitbildBinding in its config (otherwise
  // returns an explanatory error). Tool execution looks up the binding via
  // the closure below at call time; team is finalized by then.
  {
    const { createLeitbildTools } = await import('./integrations/leitbild/tools.ts')
    const getLeitbildBinding = (agentId: string) => {
      for (const meta of registry.list()) {
        const sys = registry.tryGetLive(meta.id)
        if (!sys) continue
        const agent = sys.team.getAgent(agentId)
        if (!agent || agent.kind !== 'ai') continue
        const cfg = (agent as { getConfig?: () => { leitbildBinding?: import('./core/types/agent.ts').LeitbildAgentBinding } }).getConfig?.()
        if (cfg?.leitbildBinding) return cfg.leitbildBinding
      }
      return undefined
    }
    // Audit Finding 2.1.3: getScope returns the cookie-bound Workspace id
    // that owns the agent, so the underlying LeitbildClient pool is keyed
    // per-tenant — two tenants binding to the same Leitbild deployment
    // get isolated WS connections + manifest caches.
    const getLeitbildScope = (agentId: string): WorkspaceId | undefined => {
      return registry.workspaceForAgent(agentId)
    }
    for (const tool of createLeitbildTools({ getBinding: getLeitbildBinding, getScope: getLeitbildScope })) {
      deployment.sharedToolRegistry.register(tool)
    }
    // V2.B: command tool (operator role only — enforced at execution time
    // inside the tool, not at registration time). Same lookup for binding,
    // plus a name resolver so the actor/client slug is human-readable.
    const { createLeitbildCommandTools } = await import('./integrations/leitbild/command-tools.ts')
    const getAgentName = (agentId: string): string | undefined => {
      for (const meta of registry.list()) {
        const sys = registry.tryGetLive(meta.id)
        if (!sys) continue
        const agent = sys.team.getAgent(agentId)
        if (agent) return agent.name
      }
      return undefined
    }
    for (const tool of createLeitbildCommandTools({ getBinding: getLeitbildBinding, getAgentName, getScope: getLeitbildScope })) {
      deployment.sharedToolRegistry.register(tool)
    }
    // V3 (this commit): lb_screenshot agent tool. Requires a connected
    // browser session — broadcasts via wsManager.broadcastToWorkspace,
    // first responder wins. See src/integrations/leitbild/screenshot-tool.ts.
    const { createLeitbildScreenshotTool } = await import('./integrations/leitbild/screenshot-tool.ts')
    const screenshotTool = createLeitbildScreenshotTool({
      broadcastToWorkspace: (id, msg) => wsManager.broadcastToWorkspace(id, msg),
      getScope: getLeitbildScope,
      getRoomByName: (roomName: string) => {
        // ctx.roomId in tool execution is set to the trigger room ID
        // (see ai-agent.ts callContext), but our agent tools tend to be
        // called with the ROOM NAME. Lookup by name → first matching
        // live system's room.
        for (const meta of registry.list()) {
          const sys = registry.tryGetLive(meta.id)
          if (!sys) continue
          const room = sys.rooms.getRoom(roomName)
          if (room) return room
        }
        return undefined
      },
    })
    deployment.sharedToolRegistry.register(screenshotTool)
  }
  // Wikis used to be a fetched-content subsystem. As of commit N, packs
  // declare wiki URLs as metadata only (pack.json `wikis: [{ name, url }]`)
  // and samsinn never fetches them — they're external links surfaced in
  // the pack panel. Operators view + edit on GitHub Pages directly.

  // Geodata: pack-bundled categories load via refreshPackGeodata above.
  // The historical samsinn-geodata GitHub discovery + warm cache were
  // retired in commit Q — packs are now the only distribution mechanism
  // for non-user geodata.

  if (networkToolsEnabled) {
    deployment.sharedToolRegistry.registerAll(createWebTools({
      tavilyApiKey: process.env.TAVILY_API_KEY,
      braveApiKey: process.env.BRAVE_API_KEY,
      googleApiKey: process.env.GOOGLE_CSE_API_KEY,
      googleCseId: process.env.GOOGLE_CSE_ID,
    }))
  }
  if (codegenEnabled) {
    // write_skill writes a SKILL.md file and registers into the shared store —
    // visible across Workspaces immediately. write_tool / pack admin land
    // below, after `registry` exists (they need cross-Workspace refresh).
    deployment.sharedToolRegistry.register(createWriteSkillTool(deployment.sharedSkillStore, sharedPaths.skills()))
  }

  // === Per-agent wiring on spawn/remove ===
  // Implementation lives in src/api/agent-tracking.ts so the regression test
  // (src/api/agent-state-wiring.test.ts) exercises the SAME code that runs
  // in production. Do not duplicate the wrapper logic here.

  // === WorkspaceRuntimeRegistry ===
  // The onWorkspaceRuntimeCreated hook closes over `wsManager` (assigned right after
  // createWorkspaceRuntimeRegistry returns, before any `registry.getOrLoad()` call).
  // The hook always sees a defined value. In headless mode the wsManager is
  // constructed but never accepts upgrades — no WS clients connect.
  // Definite-assignment assertion (`!`) is fine: the assignment site below
  // runs synchronously before any registry consumer code.
  let wsManager!: ReturnType<typeof createWSManager>

  // Leitbild mirror service — created eagerly so the onWorkspaceRuntimeCreated hook
  // can call restoreAll(system.rooms) for any room with persisted
  // leitbildMirror config. Without this, restored mirrors stay dormant
  // until a human hits the mirror endpoint (lazy reattach).
  const { createMirrorService } = await import('./integrations/leitbild/mirror-service.ts')
  const leitbildMirror = createMirrorService({ limitMetrics: deployment.limitMetrics })

  // === WorkspaceRuntimeRegistry ===
  const registry = createWorkspaceRuntimeRegistry({
    deployment,
    // Lazy validateBootstrap: fires once on the first successful getOrLoad.
    // Replaces the boot-time call against a throwaway boot system. Contract
    // still runs before any traffic actually reaches a System; we just
    // don't materialize an empty Workspace dir for the privilege.
    // The wsManager closure is safe because (a) the let-with-assertion
    // pattern guarantees it's set before any getOrLoad runs, and (b) the
    // onWorkspaceRuntimeCreated hook below calls wireWorkspaceRuntimeEvents synchronously,
    // so by the time onFirstLoad fires the wired-state is already true.
    onFirstLoad: (system, id) => validateBootstrap(system, {
      isWsWired: () => wsManager.isWired(id),
    }),
    onWorkspaceRuntimeCreated: async (system, id, autoSaver) => {
      // No per-Workspace FS scans: external tools, skills, packs and MCP
      // tools all live in deployment.sharedToolRegistry (populated above before
      // the registry was built). Per-Workspace toolRegistry is a thin overlay
      // that adds Workspace-bound built-ins on top. See main.ts createSamsinnWorkspaceRuntime.
      // Configure logging from env template.
      try {
        await system.logging.configure(bootLogConfig)
      } catch (err) {
        console.error(`[logging] failed to apply boot config: ${err instanceof Error ? err.message : String(err)}`)
      }
      // Track agents for provider-event routing. Walk existing agents from
      // any snapshot restore; wrap spawn/remove for new ones.
      for (const agent of system.team.listAgents()) {
        registry.attachAgent(agent.id, id)
      }
      wireAgentTracking(system, id, {
        attach: registry.attachAgent,
        detach: registry.detachAgent,
        subscribeAgentState: wsManager.subscribeAgentState,
        unsubscribeAgentState: wsManager.unsubscribeAgentState,
      })
      // (Default-room fallback removed — seedFreshInstance below handles
      // the empty-Workspace case with a properly-themed 'demo' room and a
      // Helper agent. The old `general` fallback always created a room
      // BEFORE seed ran, so seed's `if rooms.length > 0 return` check
      // would short-circuit and Helper never spawned.)
      // Wire WS broadcasts + autosave. wsManager is guaranteed assigned
      // by the time any getOrLoad runs (see the `let wsManager!:` block
      // above). autoSaver is passed in directly because the registry map
      // entry isn't set until buildWorkspaceRuntime returns.
      wireWorkspaceRuntimeEvents(system, wsManager, autoSaver, id)
      // Reattach any Leitbild mirrors whose room config was restored from
      // snapshot. Without this, mirrors stay dormant until the lazy
      // reattach-on-GET fires (which requires a human or agent hitting
      // the endpoint). Fire-and-forget; mirror.attach handles its own
      // errors by posting a [mirror error] system message.
      void leitbildMirror.restoreAll(system.rooms, id)
    },
    onWorkspaceRuntimeEvicted: (system, id) => {
      // Close WS sessions for this Workspace — they hold dangling references.
      for (const [token, sess] of [...wsManager.sessions]) {
        if (sess.workspaceId !== id) continue
        const ws = wsManager.wsConnections.get(token) as { close?: (code: number, reason?: string) => void } | undefined
        try { ws?.close?.(1001, 'Workspace evicted') } catch { /* ignore */ }
        wsManager.sessions.delete(token)
        wsManager.wsConnections.delete(token)
      }
      // Detach all agents from the reverse index AND drop their state
      // subscriptions. Without the unsubscribeAgentState call, stateUnsubs
      // keeps entries bound to dead agent.state closures from this evicted
      // System; on lazy-reload the snapshot restores agents with the SAME
      // IDs but FRESH state objects, the idempotent guard in
      // subscribeAgentState silently skips re-subscription, and the
      // restored agents' notifyState() calls fire to nowhere — no
      // 'generating' broadcast, no thinking indicator, no streaming
      // visible in the UI even though chunks broadcast fine. Entire bug
      // class is invisible to smoke-streaming.ts because that script
      // exercises in-memory wired Workspaces, not evict-reload cycles.
      for (const a of system.team.listAgents()) {
        registry.detachAgent(a.id)
        wsManager.unsubscribeAgentState(a.id)
      }
    },
  })

  // === Cross-Workspace refresh + pack-change notification ===
  // Tool changes (install_pack, write_tool) need to propagate to every live
  // Workspace, not just the one whose agent triggered the change. The shared
  // toolRegistry is already updated; what we still need is to rebuild each
  // agent's frozen tool-executor and tool-definitions snapshot.
  const crossWorkspaceRefreshAllAgentTools = async (): Promise<void> => {
    for (const meta of registry.list()) {
      const sys = registry.tryGetLive(meta.id)
      if (!sys) continue
      try { await sys.refreshAllAgentTools() } catch (err) {
        console.error(`[refresh] Workspace ${meta.id}:`, err instanceof Error ? err.message : String(err))
      }
    }
  }

  // Drop a [admin] system note into every room with at least one AI agent
  // across every active Workspace. Without this an agent's chat history
  // keeps "tool unavailable" replies from before the install — Gemini and
  // others pattern-match against past output and keep claiming the tool
  // doesn't exist even with the right toolDefinitions in the request.
  const crossWorkspaceNotifyPacksChanged = (info: {
    readonly action: 'installed' | 'updated' | 'uninstalled'
    readonly namespace: string
    readonly tools: ReadonlyArray<string>
    readonly skills: ReadonlyArray<string>
  }): void => {
    const note = info.action === 'uninstalled'
      ? `[admin] Pack "${info.namespace}" was uninstalled. ${info.tools.length} tools and ${info.skills.length} skills are no longer available.`
      : `[admin] Pack "${info.namespace}" was ${info.action}. Tools available now: ${info.tools.join(', ') || '(none)'}. Skills: ${info.skills.join(', ') || '(none)'}. Disregard any earlier message claiming these were unavailable.`
    for (const meta of registry.list()) {
      const sys = registry.tryGetLive(meta.id)
      if (!sys) continue
      for (const room of sys.rooms.listAllRooms()) {
        const hasAi = sys.team.listByKind('ai').some(a =>
          sys.rooms.getRoomsForAgent(a.id).some(r => r.profile.id === room.id),
        )
        if (!hasAi) continue
        try {
          sys.routeMessage({ rooms: [room.id] }, {
            senderId: 'system', senderName: 'system',
            content: note, type: 'system',
          })
        } catch { /* ignore — best-effort */ }
      }
    }
  }

  // Now that registry exists, finish wiring shared tools that needed it.
  // Two independent gates: codegenEnabled covers write_tool (arbitrary TS
  // on disk); packsEnabled covers vetted GitHub pack management.
  if (codegenEnabled) {
    deployment.sharedToolRegistry.register(createWriteToolTool(
      deployment.sharedToolRegistry, deployment.sharedSkillStore, crossWorkspaceRefreshAllAgentTools,
    ))
  }
  if (packsEnabled) {
    // Cross-Workspace scrub: when a pack is uninstalled, remove its
    // namespace from every room.activePacks across every live Workspace,
    // and broadcast pack_activation_changed per affected room. Returns
    // the audit list so the uninstall response can include it.
    const crossWorkspaceScrubActivePacks = async (
      packNamespace: string,
    ): Promise<{ roomId: string; activePacks: ReadonlyArray<string> }[]> => {
      const out: { roomId: string; activePacks: ReadonlyArray<string> }[] = []
      const dirtyWorkspaces = new Set<WorkspaceId>()
      for (const meta of registry.list()) {
        const sys = registry.tryGetLive(meta.id)
        if (!sys) continue
        for (const profile of sys.rooms.listAllRooms()) {
          const room = sys.rooms.getRoom(profile.id)
          if (!room) continue
          const before = room.getActivePacks()
          if (!before.includes(packNamespace)) continue
          const after = before.filter(p => p !== packNamespace)
          room.setActivePacks(after)
          out.push({ roomId: profile.id, activePacks: after })
          dirtyWorkspaces.add(meta.id)
          // Per-room WS event so any open packs panel re-renders. Best-
          // effort — broadcast layer may not be wired in tests / MCP-only.
          try {
            wsManager?.broadcastToWorkspace(meta.id, {
              type: 'pack_activation_changed', roomId: profile.id, activePacks: after,
            })
          } catch { /* ignore */ }
        }
      }
      // M5: force-flush every affected Workspace's auto-saver. The default
      // 5s debounce window is long enough that a server crash within it
      // would lose the scrub mutation, and the next boot's snapshot would
      // restore the deleted pack into room.activePacks. Fire-and-forget
      // is fine — the in-memory state is already authoritative for the
      // uninstall response; the flush is just durability.
      for (const id of dirtyWorkspaces) {
        const saver = registry.autoSaverFor(id)
        if (!saver) continue
        saver.flush().catch(err => {
          console.error(`[packs] post-scrub snapshot flush failed for ${id}:`, err)
        })
      }
      // M1: append a pendingScrub to every evicted Workspace's snapshot so
      // the scrub applies on its next reload. Without this, an evicted
      // Workspace reloaded post-uninstall restores the deleted pack as
      // active, and a later same-namespace install would auto-activate
      // without operator opt-in.
      //
      // B3 (round 3): awaited via Promise.all so the uninstall response
      // only returns once every evicted Workspace's snapshot is durable on
      // disk. Adds ~5-20ms × max(N) latency where N is evicted-Workspace
      // count — bounded by deploy size.
      const scheduledAt = new Date().toISOString()
      const scrubPromises: Promise<unknown>[] = []
      for (const meta of registry.list()) {
        if (registry.tryGetLive(meta.id)) continue  // handled by live loop above
        const snapshotPath = workspacePaths(meta.id).snapshot
        scrubPromises.push(
          appendPendingScrub(snapshotPath, { namespace: packNamespace, scheduledAt })
            .then(result => {
              if (!result.applied && result.reason && result.reason !== 'no snapshot file' && result.reason !== 'already queued') {
                console.warn(`[packs] could not queue scrub for evicted Workspace ${meta.id}: ${result.reason}`)
              }
            })
            .catch(err => {
              console.error(`[packs] appendPendingScrub failed for ${meta.id}:`, err)
            }),
        )
      }
      await Promise.all(scrubPromises)
      return out
    }

    // Re-scan pack geodata after install/update/uninstall so new
    // <pack>/geodata/*.geojson contents surface in geo_lookup + the
    // overview UI without a server restart.
    const refreshPackGeodataAfterMutation = async (): Promise<void> => {
      const { refreshPackGeodata } = await import('./geo/pack-source.ts')
      await refreshPackGeodata(sharedPaths.packs())
    }

    // Cross-Workspace auto-activate: when a new pack installs, add its
    // namespace to every room.activePacks across every live Workspace.
    // Mirrors crossWorkspaceScrubActivePacks but adds (not removes). Per-
    // room opt-out via the panel toggle still works.
    const crossWorkspaceAutoActivatePack = async (
      packNamespace: string,
    ): Promise<{ roomId: string; activePacks: ReadonlyArray<string> }[]> => {
      const out: { roomId: string; activePacks: ReadonlyArray<string> }[] = []
      const dirtyWorkspaces = new Set<WorkspaceId>()
      for (const meta of registry.list()) {
        const sys = registry.tryGetLive(meta.id)
        if (!sys) continue
        for (const profile of sys.rooms.listAllRooms()) {
          const room = sys.rooms.getRoom(profile.id)
          if (!room) continue
          const before = room.getActivePacks()
          if (before.includes(packNamespace)) continue   // already active in this room
          const after = [...before, packNamespace]
          room.setActivePacks(after)
          out.push({ roomId: profile.id, activePacks: after })
          dirtyWorkspaces.add(meta.id)
          try {
            wsManager?.broadcastToWorkspace(meta.id, {
              type: 'pack_activation_changed', roomId: profile.id, activePacks: after,
            })
          } catch { /* ignore */ }
        }
      }
      // Force-flush every affected Workspace's auto-saver so a crash within
      // the 5s debounce doesn't lose the activation. Same pattern as
      // crossWorkspaceScrubActivePacks.
      for (const id of dirtyWorkspaces) {
        const saver = registry.autoSaverFor(id)
        if (!saver) continue
        saver.flush().catch(err => {
          console.error(`[packs] post-auto-activate snapshot flush failed for ${id}:`, err)
        })
      }
      return out
    }

    deployment.sharedToolRegistry.registerAll(createPackTools({
      packsDir: sharedPaths.packs(),
      toolRegistry: deployment.sharedToolRegistry,
      skillStore: deployment.sharedSkillStore,
      refreshAllAgentTools: crossWorkspaceRefreshAllAgentTools,
      notifyPacksChanged: crossWorkspaceNotifyPacksChanged,
      scrubActivePacks: crossWorkspaceScrubActivePacks,
      autoActivateInAllRooms: crossWorkspaceAutoActivatePack,
      refreshPackGeodata: refreshPackGeodataAfterMutation,
    }))
  }

  // === wsManager — assigned NOW (before any registry.getOrLoad runs) ===
  // wsManager is registry-aware: buildSnapshot and subscribeAgentState
  // resolve the live System per workspaceId rather than closing over a
  // single boot system. State subscriptions broadcast scoped to the
  // originating Workspace via broadcastToWorkspace.
  // Order matters: this assignment MUST happen before the first getOrLoad,
  // otherwise the onWorkspaceRuntimeCreated hook would observe `wsManager` undefined
  // and silently skip wireWorkspaceRuntimeEvents — that was the source of a long
  // latent bug fixed in commit 5d73a8e. Pre-assigning wsManager keeps the
  // hook's wiring path single, with no rescue branch elsewhere.
  wsManager = createWSManager({
    getRuntime: (id) => registry.tryGetLive(id),
    limitMetrics: deployment.limitMetrics,
  })

  // Wire the per-provider monitor heartbeat to the live WS-client count.
  // While at least one client is connected the heartbeats run on their
  // adaptive cadence; with zero clients the heartbeats become no-ops and
  // an idle Samsinn (no open tab) consumes zero requests. Providers were
  // built before WSManager existed, so this is a post-construction wire-up.
  for (const monitor of Object.values(providerSetup.monitors)) {
    monitor.setIsActive(() => wsManager.sessionCount() > 0)
  }

  // === Provider routing event dispatcher (registry-aware) ===
  deployment.setProviderEventDispatcher((event) => {
    if (!event.agentId) return   // events without an agentId can't be routed
    const workspaceId = registry.workspaceForAgent(event.agentId)
    if (!workspaceId) return      // late event for evicted/removed agent
    // tryGetLive returns the in-memory system if it's currently active;
    // does NOT trigger a lazy-load (we don't want a late provider event
    // to resurrect an evicted Workspace just to dispatch one event).
    const sys = registry.tryGetLive(workspaceId)
    if (!sys) return
    try { sys.dispatchProviderEvent(event) } catch { /* drop */ }
  })

  // === Boot the appropriate runtime ===
  if (headless) {
    // Headless: fresh Workspace per process boot. No janitor or eviction.
    const headlessId = newWorkspaceId()
    const system = await registry.getOrLoad(headlessId)

    // wsManager not used in headless mode; create a stub so wireWorkspaceRuntimeEvents
    // (called inside onWorkspaceRuntimeCreated) ran with `wsManager === undefined`
    // and skipped wiring. That's intentional — there are no WS clients in
    // headless. Provider events dispatch through the shared listener
    // anyway; agent.dispatchProviderEvent still proxies to MCP if configured.

    // Warm provider model caches (best-effort).
    const warmResults = await warmProviderModels(providerSetup.gateways)
    for (const [name, result] of Object.entries(warmResults)) {
      if (result.status === 'ok') console.log(`  ${name}: ${result.count} models available`)
      else console.warn(`  ${name}: warm-up failed — ${result.message}`)
    }

    // Single contract check — every wiring invariant a bug has uncovered
    // gets a line in src/boot/validate.ts. Throwing here fails the boot
    // loud and clear instead of running with broken wiring.
    validateBootstrap(system)

    const { createMCPServer, wireEventNotifications, startMCPServerStdio } = await import('./integrations/mcp/server.ts')
    const mcpServer = createMCPServer(system, pkg.version)
    wireEventNotifications(system, mcpServer)
    await startMCPServerStdio(mcpServer)
    console.log('MCP server running on stdio')

    // Headless graceful shutdown.
    const shutdown = async (): Promise<void> => {
      const timeout = new Promise<void>(res => setTimeout(res, DRAIN_TIMEOUT_MS))
      const aiAgents = system.team.listAgents().flatMap(a => { const ai = asAIAgent(a); return ai ? [ai] : [] })
      await Promise.all(aiAgents.map(a => Promise.race([a.whenIdle(), timeout])))
      if (!ephemeral) {
        try { await registry.shutdown() } catch (err) { console.error('shutdown flush:', err) }
      }
      try { await system.logging.configure({ enabled: false }) } catch { /* noop */ }
      await mcpDisconnect()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    return
  }

  // === HTTP mode ===
  // No boot system. The first cookieless visitor (or a cookie-bound one)
  // creates their Workspace lazily via the HTTP path. validateBootstrap
  // runs on that first getOrLoad via onFirstLoad above. This eliminates
  // the boot-orphan Workspace dir that watch-mode reloads used to mint on
  // every restart — see commit log for the empty-Workspace-accumulation fix.

  // Warm provider model caches. Awaited synchronously: B3 of the audit
  // requires that warm complete BEFORE we accept traffic, so the router's
  // catalog filter has real data to work with (no optimistic-include).
  const warmResults = await warmProviderModels(providerSetup.gateways)
  for (const [name, result] of Object.entries(warmResults)) {
    if (result.status === 'ok') console.log(`  ${name}: ${result.count} models available`)
    else console.warn(`  ${name}: warm-up failed — ${result.message}`)
  }

  // Tool surface log — sourced from the shared registry (process-wide).
  // Per-Workspace overlays (Room/Team-bound built-ins) aren't included; those
  // are uniform across Workspaces anyway.
  console.log(`Tools: ${deployment.sharedToolRegistry.list().map(t => t.name).join(', ')}`)

  // Activation summary — operator-visible verification that the pack
  // surface is what they expect. Counts fan out from the shared registry:
  //   - 'core' tools: kind='built-in'
  //   - 'local' tools: kind='external'
  //   - per-pack tools: kind='pack-bundled', grouped by source.pack
  // Skills counted similarly via the shared skill store.
  // A new room with empty activePacks sees only core + local. The numbers
  // here are upper bounds per pack — the per-room filter applies the
  // 'core'/'local' implicit-active rule on top.
  {
    const entries = deployment.sharedToolRegistry.listEntries()
    const skillEntries = deployment.sharedSkillStore.list()
    const counts = new Map<string, { tools: number; skills: number }>()
    const bump = (pack: string, kind: 'tools' | 'skills'): void => {
      const slot = counts.get(pack) ?? { tools: 0, skills: 0 }
      slot[kind]++
      counts.set(pack, slot)
    }
    for (const e of entries) {
      switch (e.source.kind) {
        case 'built-in':       bump('core', 'tools'); break
        case 'external':       bump('local', 'tools'); break
        case 'pack-bundled':   bump(e.source.pack ?? 'local', 'tools'); break
        case 'skill-bundled':  bump(e.source.pack ?? 'local', 'tools'); break
      }
    }
    for (const s of skillEntries) bump(s.pack ?? 'local', 'skills')
    const ordered: ReadonlyArray<readonly [string, { tools: number; skills: number }]> = [
      ['core',  counts.get('core')  ?? { tools: 0, skills: 0 }],
      ['local', counts.get('local') ?? { tools: 0, skills: 0 }],
      ...[...counts.entries()].filter(([k]) => k !== 'core' && k !== 'local').sort((a, b) => a[0].localeCompare(b[0])),
    ]
    const fmt = ordered.map(([ns, c]) => `${ns}=${c.tools}t/${c.skills}s`).join(' ')
    console.log(`[packs] activation surface: ${fmt}  (per-room: room.activePacks ⊕ core+local)`)
  }

  // === Explicit trash cleanup + idle runtime eviction ===
  let evictionSweepRunning = false
  const runEvictionSweep = async (): Promise<void> => {
    if (evictionSweepRunning) {
      console.warn('[registry] idle eviction sweep skipped because the previous sweep is still running')
      return
    }
    evictionSweepRunning = true
    try {
      const evicted = await registry.evictIdle()
      if (evicted > 0) console.log(`[registry] idle eviction sweep removed ${evicted} Workspace(s)`)
    } catch (err) {
      console.error(`[registry] evictIdle: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      evictionSweepRunning = false
    }
  }
  const evictTimer = setInterval(() => { void runEvictionSweep() }, 60_000)

  // Stale-session sweep — every hour, drop sessions whose WS has been
  // closed for >7d and remove the inactive human agent from its team.
  // Without this, every disconnected user accumulates forever until the
  // Workspace is evicted.
  const sessionSweepTimer = setInterval(() => {
    try { wsManager?.sweepStaleSessions() } catch (err) {
      console.error(`[ws] sweepStaleSessions: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, 60 * 60 * 1000)

  // === Per-Workspace reset ===
  // Trashes the cookie's Workspace dir; the same id persists. Browser
  // reconnects → registry creates fresh empty RoomDirectory under the same id.
  const resetWorkspace = async (req: Request) => {
    const { getWorkspaceId } = await import('./api/workspace-cookie.ts')
    const id = getWorkspaceId(req)
    if (!id) return { ok: false as const, reason: 'no Workspace cookie' }
    try {
      await registry.resetWorkspaceState(id)
      return { ok: true as const, workspaceId: id }
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  // === Per-Workspace evict ===
  // Drops the cookie's System from memory; the on-disk snapshot is
  // untouched, so the next request lazy-reloads via restoreFromSnapshot.
  // Used by the post-deploy streaming probe to exercise the
  // evict→reload boundary that hid the unsubscribeAgentState bug.
  const evictWorkspace = async (req: Request) => {
    const { getWorkspaceId } = await import('./api/workspace-cookie.ts')
    const id = getWorkspaceId(req)
    if (!id) return { ok: false as const, reason: 'no Workspace cookie' }
    try {
      await registry.evictOne(id)
      return { ok: true as const, workspaceId: id }
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  // === Workspace administration ===
  const { buildWorkspaceCookie } = await import('./api/workspace-cookie.ts')
  const workspacesAdmin: WorkspaceAdmin = {
    list: async () => {
      const [records, stored] = await Promise.all([workspaceDirectory.list(), registry.listOnDisk()])
      const storedById = new Map(stored.map(entry => [entry.id, entry]))
      const liveIds = new Set(registry.list().map(meta => meta.id))
      return records.map(record => {
        const moduleState = storedById.get(record.id)
        return {
          id: record.id,
          displayName: record.displayName,
          snapshotMtimeMs: moduleState?.snapshotMtimeMs ?? 0,
          snapshotSizeBytes: moduleState?.snapshotSizeBytes ?? 0,
          isLive: liveIds.has(record.id),
        }
      })
    },
    create: async (displayName = 'Samsinn Workspace') => {
      const id = newWorkspaceId()
      await workspaceDirectory.ensure({ id, displayName })
      return { id }
    },
    buildSwitchCookie: (id, req) => buildWorkspaceCookie(id, req),
  }

  // === Diagnostics capability ===
  // Read-only health snapshot. Walks the registry + wsManager state to
  // expose per-Workspace broadcast wiring + last-broadcast timestamps. The
  // signal that catches the silent-skip class of bug we just fixed: an
  // active Workspace with zero broadcasts under live traffic is wrong.
  const diagnostics = {
    snapshot: () => ({
      workspaces: registry.list().map(meta => {
        const sys = registry.tryGetLive(meta.id)
        const aiAgents = sys?.team.listByKind('ai') ?? []
        return {
          id: meta.id,
          wired: wsManager.isWired(meta.id),
          agentCount: aiAgents.length,
          generatingAgentCount: aiAgents.filter(agent => agent.state.get() === 'generating').length,
          lastBroadcastAt: wsManager.lastBroadcastAt(meta.id),
        }
      }),
      wsSessions: wsManager.sessionCount(),
      configuredIdleMs: registry.idleMs(),
      maxLoadedWorkspaces: registry.maxLoadedWorkspaces(),
    }),
  }

  // === HTTP + WS server ===
  // CSS bootstrap: build dist.css if missing or stale BEFORE the server
  // starts listening. Makes the server self-sufficient regardless of how
  // it was launched (bun run dev, bun --watch, prod systemd, preview tool,
  // fresh checkout). The runtime fallback banner in server.ts stays as
  // defense in depth for "dist.css deleted while server is running."
  {
    const { ensureCssBuilt } = await import('./api/ensure-css-built.ts')
    const uiPath = `${import.meta.dir}/ui`
    await ensureCssBuilt({ uiPath })
  }
  const { createServer } = await import('./api/server.ts')
  createServer({
    registry,
    workspaceDirectory,
    wsManager,
    port: parseInt(process.env.PORT ?? String(DEFAULTS.port), 10),
    resetWorkspace,
    evictWorkspace,
    workspaces: workspacesAdmin,
    diagnostics,
    leitbildMirror,
  })

  // === Graceful shutdown ===
  const shutdown = async (): Promise<void> => {
    console.log('Shutting down, saving snapshots...')
    clearInterval(evictTimer)
    clearInterval(sessionSweepTimer)
    if (!ephemeral) {
      try { await registry.shutdown() } catch (err) { console.error('Failed to flush snapshots:', err) }
    }
    // Disable logging on every still-live Workspace. Process exit would close
    // the JSONL sinks anyway, but explicit configure({enabled:false}) lets
    // each Workspace flush a clean shutdown line first.
    for (const meta of registry.list()) {
      const sys = registry.tryGetLive(meta.id)
      if (sys) try { await sys.logging.configure({ enabled: false }) } catch { /* noop */ }
    }
    await mcpDisconnect()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
