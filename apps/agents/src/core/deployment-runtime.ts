// ============================================================================
// DeploymentRuntime — resources shared safely across multiple Workspaces.
// Built once at boot and reused by every createAgentsWorkspaceRuntime call to avoid
// duplicating provider gateways, API-quota state, and the LLM router.
//
// What's shared:
//   - ProviderRouter (llm) — failover logic + per-provider cooldown map.
//     Shared on purpose: API-quota cost is per Deployment, not per Workspace.
//   - Ollama gateway + raw + ollamaUrls — single ps poll, single keep-alive
//     state, single URL list editable from any Workspace UI.
//   - ProviderKeys + gateways — runtime key edits visible everywhere.
//   - ProviderConfig — boot-time decision (order, single-Ollama mode, …).
//   - sharedToolRegistry — external tools, skill-bundled tools, pack-owned
//     tools, MCP tools, write_skill / write_tool / install_pack et al.
//     Single FS scan at boot, no per-Workspace reload thrash. Pack installed
//     in one Workspace is immediately available to another Workspace.
//   - sharedSkillStore — every loaded skill (pack and free-standing). Each
//     Workspace reads from the same store; install/uninstall mutate one place.
//   - sharedScriptStore — one deployment catalog for authored, bundled, and
//     Pack-owned script definitions. Script runs remain per Workspace.
//
// What stays per-Workspace (built fresh by createAgentsWorkspaceRuntime):
//   - RoomDirectory (rooms, agents, artifacts, messages, members, mute/pause)
//   - Team
//   - Tool-registry OVERLAY — Room/Team-bound built-ins (createListRoomsTool,
//     createAddArtifactTool, etc.) layered above sharedToolRegistry.
//   - Logging sink
//   - Summary scheduler
//   - All event-callback late-binding slots
// ============================================================================

import type { ProviderConfig } from '../llm/providers-config.ts'
import type { ProviderSetupResult } from '../llm/providers-setup.ts'
import type { ProviderKeys } from '../llm/provider-keys.ts'
import type { Tool, ToolRegistry } from '../core/types/tool.ts'
import type { ProviderRoutingEvent } from '../llm/router.ts'
import type { SkillStore } from '../skills/loader.ts'
import { parseProviderConfig } from '../llm/providers-config.ts'
import { buildProvidersFromConfig } from '../llm/providers-setup.ts'
import { createProviderKeys } from '../llm/provider-keys.ts'
import { mergeWithEnv, type ProviderPolicyStore } from '../llm/providers-store.ts'
import { DEFAULT_MODEL_FALLBACK } from '../llm/models/catalog.ts'
import { createToolRegistry } from './tool-registry.ts'
import { createSkillStore } from '../skills/loader.ts'
import { createLimitMetrics, type LimitMetrics } from './limit-metrics.ts'
import { createScriptStore, type ScriptStore } from './scripts/script-store.ts'
import { sharedPaths } from './paths.ts'
import { scanPackSubdirs } from '../packs/scanner.ts'
import { join } from 'node:path'

export interface DeploymentRuntime {
  readonly providerConfig: ProviderConfig
  readonly providerKeys: ProviderKeys
  readonly providerSetup: ProviderSetupResult
  // MCP-backed tools loaded ONCE per process at boot (each MCP server is
  // a stdio child process; we do not want one child per Workspace).
  // Each Workspace runtime registers these definitions into its
  // own ToolRegistry — the underlying connection is shared.
  // Mutable list so bootstrap can populate after construction.
  mcpTools: Tool[]
  // Provider routing events fan out via a single listener on the shared
  // router. The dispatcher is set once by the WorkspaceRuntimeRegistry, which has
  // the agentId → workspaceId reverse index. Default: noop.
  setProviderEventDispatcher: (fn: (event: ProviderRoutingEvent) => void) => void
  // Process-global counters for cap/limit hits. Read-only API; the only
  // mutator is the inc() method on the metrics object itself.
  readonly limitMetrics: LimitMetrics
  // Shared tool registry — populated at boot by bootstrap.ts (external tools,
  // skill-bundled tools, pack-owned tools, MCP tools) and subsequently
  // mutated only by install/uninstall_pack and write_skill/write_tool. Per-
  // Workspace runtimes wrap this in an overlay (createOverlayToolRegistry).
  readonly sharedToolRegistry: ToolRegistry
  // Shared skill store — populated alongside sharedToolRegistry. Each
  // Workspace reads from the same store, so installing a Pack makes its
  // skills available to other Workspaces without reloading them.
  readonly sharedSkillStore: SkillStore
  // Scripts are authored/installed at Deployment scope. One shared catalog
  // prevents per-Workspace filesystem scans and stale cross-Workspace views;
  // Script runs themselves remain strictly per Workspace.
  readonly sharedScriptStore: ScriptStore
  // Cross-provider behavior. Production injects the providers.json-backed
  // implementation; focused runtimes use an isolated in-memory store.
  readonly providerPolicy: ProviderPolicyStore
}

export interface CreateDeploymentRuntimeOptions {
  readonly providerConfig?: ProviderConfig
  // TEST-ONLY: inject a pre-built setup. Production code goes through
  // src/boot/provider-stack.ts
  // which constructs the setup once and passes it here together with
  // matching providerKeys. If you find yourself adding `providerSetup`
  // outside a test, you are creating a second assembly path. The wiring
  // contract is enforced by:
  //   - src/boot/validate.ts (checks providerKeys is on the System)
  //   - src/boot/bootstrap-e2e.test.ts (end-to-end boot path)
  readonly providerSetup?: ProviderSetupResult
  // Optional pre-built metrics handle. Bootstrap supplies one so the same
  // object can be passed to buildProvidersFromConfig before DeploymentRuntime
  // exists. Tests/headless paths omit and we lazy-create.
  readonly limitMetrics?: LimitMetrics
  // Optional pre-built provider keys store. Bootstrap supplies this so the
  // SAME ProviderKeys object flows into both `buildProvidersFromConfig`
  // (used by bootstrap to wire limitMetrics into adapters) AND DeploymentRuntime.
  // Without this, bootstrap built providerSetup with NO providerKeys → router
  // had `isProviderEnabled = undefined` → every provider (including keyless
  // anthropic) was tried on every request → Helper got `[pass] LLM error:
  // anthropic auth error 401` on leitbild.app.
  readonly providerKeys?: ProviderKeys
  readonly providerPolicy?: ProviderPolicyStore
}

export const createDeploymentRuntime = (
  opts: CreateDeploymentRuntimeOptions = {},
): DeploymentRuntime => {
  const providerConfig = opts.providerConfig ?? parseProviderConfig()

  // Mutable runtime registry of API keys. Boot-time keys (env or stored)
  // are seeded from providerConfig.cloud; later UI edits flow through here
  // without restart.
  const providerKeys = opts.providerKeys ?? createProviderKeys(
    mergeWithEnv({ version: 1, providers: {} }, { env: {} as Record<string, string | undefined> }),
  )
  // Only seed from cloud config when we constructed the keys here. If the
  // caller supplied them, they've already been populated.
  if (!opts.providerKeys) {
    for (const [name, cc] of Object.entries(providerConfig.cloud)) {
      if (cc?.apiKey) providerKeys.set(name, cc.apiKey)
    }
  }

  const providerSetup =
    opts.providerSetup ?? buildProvidersFromConfig(providerConfig, { providerKeys })

  // Single listener on the shared router. The registered dispatcher
  // (set by WorkspaceRuntimeRegistry) routes events to the correct per-Workspace
  // subscriber via the agentId reverse index.
  let dispatcher: (event: ProviderRoutingEvent) => void = () => { /* noop */ }
  providerSetup.router.onRoutingEvent((event) => {
    try { dispatcher(event) } catch (err) {
      console.error(`[provider-event] dispatch threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  const mcpTools: Tool[] = []
  const limitMetrics = opts.limitMetrics ?? createLimitMetrics()
  // Empty at construction — bootstrap.ts populates with external tools,
  // skills (which register their bundled tools), packs, MCP tools, and the
  // codegen/pack admin tools. createAgentsWorkspaceRuntime then wraps this in an overlay.
  const sharedToolRegistry = createToolRegistry()
  const sharedSkillStore = createSkillStore()
  const sharedScriptStore = createScriptStore({
    baseDir: sharedPaths.scripts(),
    extraSourceDirs: [join(import.meta.dir, '../../examples/scripts')],
    resolvePackDirs: () => scanPackSubdirs(sharedPaths.packs(), 'scripts'),
  })
  void sharedScriptStore.reload().catch(error => {
    console.error(`[scripts] initial reload failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  let modelFallback = [...DEFAULT_MODEL_FALLBACK]
  return {
    providerConfig,
    providerKeys,
    providerSetup,
    mcpTools,
    setProviderEventDispatcher: (fn) => { dispatcher = fn },
    limitMetrics,
    sharedToolRegistry,
    sharedSkillStore,
    sharedScriptStore,
    providerPolicy: opts.providerPolicy ?? {
      getModelFallback: () => modelFallback,
      setModelFallback: async (chain) => { modelFallback = chain ? [...chain] : [] },
    },
  }
}
