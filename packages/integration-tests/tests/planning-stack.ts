// A real Host with the real World and Planning Modules. World serves its own planning facts query, and
// Planning runs on the real solver (lane S's Worker pool) and checker (lane K). Agents is either the real Module
// (for search over its catalogue) or a Module answering empty catalogues, since its workspace tools run
// in-process against Host either way.
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  moduleRegistrationSchema, planningFactsOutputSchema, workspaceDefinitionCatalogSchema, workspaceIdSchema,
  type WorkspaceId, type WorkspaceRoomScope,
} from '@leitbild/contracts'
import { createServer as createWorldServer } from '../../../apps/world/src/core/api/server.ts'
import { createWorldModuleState } from '../../../apps/world/src/core/workspaces/module-state.ts'
import { simulationRunIdSchema } from '../../../apps/world/src/core/model/ids.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../../../apps/world/src/core/workspaces/runtime-registry.ts'
import { createWorldApplicationAssembly } from '../../../apps/world/src/app-assembly.ts'
import { scenarioAuthoringCatalogFor } from '../../../apps/world/src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../../../apps/world/src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../../../apps/world/src/core/scenarios/runtime-resolver.ts'
import { createDirectRoutingAdapter } from '../../../apps/world/src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../../../apps/world/src/scenarios/definitions.ts'
import { builtinFeaturedScenarioDefinitions } from '../../../apps/world/src/scenarios/featured.ts'
import { handleAgentsModuleApi } from '../../../apps/agents/src/api/workspace-module-api.ts'
import { createDeploymentRuntime } from '../../../apps/agents/src/core/deployment-runtime.ts'
import { createAgentsModuleState } from '../../../apps/agents/src/core/workspaces/module-state.ts'
import { createWorkspaceRuntimeRegistry as createAgentsWorkspaceRuntimeRegistry, type WorkspaceRuntimeRegistry } from '../../../apps/agents/src/core/workspaces/runtime-registry.ts'
import { createWorkspaceCapabilityTools } from '../../../apps/agents/src/tools/built-in/workspace-capability-tools.ts'
import { createWorkspaceHost } from '../../../apps/leitbild/src/host.ts'
import { createModuleGateway } from '../../../apps/leitbild/src/module-gateway.ts'
import { createWorkspaceHostServer } from '../../../apps/leitbild/src/server.ts'
import { createWorkspaceStore } from '../../../apps/leitbild/src/store.ts'
import { createPlanningServer } from '../../../apps/planning/src/server.ts'
import { createPlanningOperations } from '../../../apps/planning/src/api/operations.ts'
import { createPlanDefinitions } from '../../../apps/planning/src/definitions/index.ts'
import { createPlanStore } from '../../../apps/planning/src/plan/store.ts'
import { createPlanningHostClient } from '../../../apps/planning/src/host-client.ts'
import { createRealSolver } from '../../../apps/planning/src/api/wiring.ts'
import { createSolverPool } from '../../../apps/planning/src/solve/pool.ts'

const temporary = async (cleanup: Array<() => Promise<void> | void>, name: string) => {
  const dir = await mkdtemp(join(tmpdir(), `planning-stack-${name}-`))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** The shipped World catalogue, assembled as World's index.ts does, with straight-line routing. */
const startWorld = async (cleanup: Array<() => Promise<void> | void>) => {
  const dataDir = await temporary(cleanup, 'world')
  const uiDir = await temporary(cleanup, 'world-ui')
  const routing = createDirectRoutingAdapter()
  const assembly = createWorldApplicationAssembly({ routing })
  const workspaces = createWorldWorkspaceRuntimeRegistry({
    dataDir, moduleState: createWorldModuleState({ dataDir }),
    // Runs stay loaded for the whole test, so runEvents reads the journal a long journey started with: an idle
    // Run is otherwise closed after its delay, and a journey of several Generates outlasts it.
    idleRuntimeCloseDelayMs: -1,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
    scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
    runtimeAdapters: assembly.runtimeAdapters,
  })
  const server = createWorldServer({ workspaces, featuredDefinitions: builtinFeaturedScenarioDefinitions, bindHost: '127.0.0.1', port: 0, uiDistPath: uiDir, mapArtifacts: { rootDir: join(dataDir, 'maps') } })
  cleanup.push(async () => { await server.stop(); await workspaces.shutdown() })
  return { port: server.port, workspaces }
}

/** The real Agents Module, or one that answers its lifecycle and empty catalogues. */
const startAgents = async (cleanup: Array<() => Promise<void> | void>, real: boolean, hostUrl: () => string) => {
  if (!real) {
    const manifest = { module: { id: 'agents', title: 'Agents' }, endpoints: {
      workspace: '/internal/workspaces/{workspaceId}', definitions: '/internal/workspaces/{workspaceId}/definitions',
      resources: '/internal/workspaces/{workspaceId}/resources', capabilities: '/internal/workspaces/{workspaceId}/capabilities',
      invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke', featuredDefinitions: '/internal/featured-definitions', activity: '/internal/activity',
    } }
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/.well-known/workspace-module') return Response.json(manifest)
      if (url.pathname === '/internal/featured-definitions') return Response.json({ definitions: [], listed: [] })
      if (url.pathname === '/internal/activity') return Response.json({ workspaces: [] })
      const match = url.pathname.match(/^\/internal\/workspaces\/([^/]+)(?:\/(definitions|resources|capabilities))?$/)
      if (!match) return new Response('Not found', { status: 404 })
      if (match[2] === undefined) return request.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ workspaceId: match[1], moduleId: 'agents' }, { status: 201 })
      return Response.json({ [match[2]]: [] })
    } })
    cleanup.push(() => server.stop(true))
    return { port: server.port, attach: () => {} }
  }
  const leitbildHome = await temporary(cleanup, 'agents')
  const saved = { home: process.env.LEITBILD_HOME, provider: process.env.PROVIDER, seed: process.env.LEITBILD_SEED_WORKSPACE }
  process.env.LEITBILD_HOME = leitbildHome
  process.env.PROVIDER = 'ollama'
  delete process.env.LEITBILD_SEED_WORKSPACE
  let registry: WorkspaceRuntimeRegistry | undefined
  const state = createAgentsModuleState()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (!registry) return Response.json({ error: { code: 'runtime_unavailable' } }, { status: 503 })
    return await handleAgentsModuleApi(request, new URL(request.url), { state, registry }) ?? new Response('Not found', { status: 404 })
  } })
  cleanup.push(async () => {
    await registry?.shutdown()
    server.stop(true)
    for (const [key, value] of [['LEITBILD_HOME', saved.home], ['PROVIDER', saved.provider], ['LEITBILD_SEED_WORKSPACE', saved.seed]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  return { port: server.port, attach: () => { registry = createAgentsWorkspaceRuntimeRegistry({ deployment: createDeploymentRuntime(), moduleState: state, workspaceHostUrl: hostUrl(), idleMs: 1_000_000 }) } }
}

export const createPlanningStack = async (options: { readonly realAgents?: boolean } = {}) => {
  const cleanup: Array<() => Promise<void> | void> = []
  let hostUrl = ''
  const world = await startWorld(cleanup)
  const agents = await startAgents(cleanup, options.realAgents ?? false, () => hostUrl)

  const planningHome = await temporary(cleanup, 'plans')
  const store = createPlanStore(planningHome)
  const definitions = createPlanDefinitions()
  // Planning reads World through Host as index.ts does; Host's address is known once it listens.
  // This one process holds World, Host, Agents and Planning, so its RSS is far above Planning's own; the
  // pool's 220 MB guard (meant for the Planning unit alone) would stop every solve at once.
  const pool = createSolverPool({ rssLimitMb: 4_000 })
  cleanup.push(() => pool.shutdown())
  const operations = createPlanningOperations({
    store, definitions, solver: createRealSolver(pool),
    world: {
      read: async (access, run, input, signal) => planningFactsOutputSchema.parse(await createPlanningHostClient({ hostUrl }).call(access, 'world.simulation-run.planning-facts', { resource: run, input }, signal)),
      runSource: (run, signal) => createPlanningHostClient({ hostUrl }).runSource(run, signal),
    },
  })
  const planning = createPlanningServer({ operations, definitions, store, port: 0, uiDistPath: planningHome })
  cleanup.push(() => planning.stop(true))

  const workspaceStore = createWorkspaceStore(':memory:')
  cleanup.push(() => workspaceStore.close())
  const registration = (moduleId: string, port: number | undefined) => moduleRegistrationSchema.parse({ moduleId, internalBaseUrl: `http://127.0.0.1:${port}`, manifestPath: '/.well-known/workspace-module' })
  const host = createWorkspaceHost({ store: workspaceStore, modules: createModuleGateway({ registrations: [registration('world', world.port), registration('agents', agents.port), registration('planning', planning.port)] }) })
  const hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port: 0 })
  cleanup.push(() => hostServer.stop(true))
  hostUrl = `http://127.0.0.1:${hostServer.port}`
  agents.attach()

  const created = await fetch(`${hostUrl}/api/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Planning' }) })
  const workspaceId: WorkspaceId = workspaceIdSchema.parse(((await created.json()) as { workspace: { id: string } }).workspace.id)

  /** Starts a Definition through Host's normal launch, as a person does from the Workspace page. */
  const start = async (type: string, id: string, capabilityId: string): Promise<string> => {
    const catalog = workspaceDefinitionCatalogSchema.parse(await (await fetch(`${hostUrl}/api/workspaces/${workspaceId}/definitions`)).json())
    const definition = catalog.definitions.find(entry => entry.ref.type === type && entry.ref.id === id)!
    const response = await fetch(`${hostUrl}/api/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition: { ...definition.ref, revisionId: definition.currentRevisionId }, input: {} }),
    })
    if (!response.ok) throw new Error(`${id} did not start: ${await response.text()}`)
    const body = await response.json() as { result: { id?: string }; createdResources?: Array<{ id: string }> }
    return body.createdResources?.[0]?.id ?? body.result.id!
  }

  const scopes = new Map<string, WorkspaceRoomScope>()
  const tools = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: hostUrl, getRoomScope: roomId => scopes.get(roomId) })
  const tool = (name: string) => tools.find(entry => entry.name === name)!
  /** A Room with Workspace scope, as a new conversation would be. */
  const room = (roomId: string) => {
    scopes.set(roomId, { kind: 'workspace' })
    const context = { callerId: `assistant-${roomId}`, callerName: 'Assistant', roomId }
    return {
      explore: (params: Record<string, unknown>) => tool('workspace_explore').execute(params, context),
      call: (params: Record<string, unknown>) => tool('workspace_call').execute(params, context),
    }
  }
  return {
    hostUrl, worldUrl: `http://127.0.0.1:${world.port}`, workspaceId, store, room, start,
    /** How many events World's own journal holds for a Run of this Workspace. */
    runEvents: (runId: string): number => world.workspaces.getLoaded(workspaceId)!.simulationRuns.get(simulationRunIdSchema.parse(runId))!.events().length,
    close: async () => { for (const step of cleanup.reverse()) await step() },
  }
}
