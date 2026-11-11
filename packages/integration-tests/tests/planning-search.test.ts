// Search-phrase ranking (design 9 row 5): the real workspace_explore over the combined catalogue of the real
// World (two Runs: the Supply run and a cooling-chain plant), the real Agents and the real Planning Modules,
// with maint's frozen phrasings (R/maint/phrasings.md, sha256 ca09915d...). P1-P20 gate at >= 18 of 20 with
// the expected operation in the top 3; A1-A4 are reported, not gated.
//
// Until lane W lands, World does not publish world.simulation-run.planning-facts; a proxy adds lane W's
// descriptor (planning-stack.ts) to World's catalogue and Runs. Once World publishes it, this test fails
// at the guard below: delete the proxy additions and use World's own descriptor.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { moduleRegistrationSchema, workspaceDefinitionCatalogSchema, workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'
import { createServer as createWorldServer } from '../../../apps/world/src/core/api/server.ts'
import { createWorldModuleState } from '../../../apps/world/src/core/workspaces/module-state.ts'
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
import { createCheckerDouble, createSolverDouble } from '../../../apps/planning/src/api/fixtures/doubles.ts'
import { planningFactsDescriptor } from './planning-stack.ts'

const phrasingsFile = new URL('./fixtures/planning-phrasings.md', import.meta.url)
const frozen = 'ca09915dcd9a9cedb782d7e5f6cf641e0eb43c5f71bf0551607ff606692542b1'
const text = await Bun.file(phrasingsFile).text()

/** Rows of maint's tables: scored rows name one expected operation, ambiguous rows a set. */
const rows = text.split('\n').filter(line => /^\| [PA]\d+ \|/.test(line)).map(line => {
  const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
  const id = cells[0]!
  const phrase = id.startsWith('P') ? cells[2]! : cells[1]!
  const expected = [...(id.startsWith('P') ? cells[3]! : cells[2]!).matchAll(/`([a-z][a-z0-9.-]+)`/g)].map(match => match[1]!)
  return { id, phrase, expected }
})

const cleanup: Array<() => Promise<void> | void> = []
let explore: (query: string) => Promise<string[]>

beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'planning-search-world-'))
  const uiDir = await mkdtemp(join(tmpdir(), 'planning-search-ui-'))
  const planningHome = await mkdtemp(join(tmpdir(), 'planning-search-plans-'))
  const leitbildHome = await mkdtemp(join(tmpdir(), 'planning-search-agents-'))
  const saved = { home: process.env.LEITBILD_HOME, provider: process.env.PROVIDER, seed: process.env.LEITBILD_SEED_WORKSPACE }
  process.env.LEITBILD_HOME = leitbildHome
  process.env.PROVIDER = 'ollama'
  delete process.env.LEITBILD_SEED_WORKSPACE
  cleanup.push(async () => {
    for (const [key, value] of [['LEITBILD_HOME', saved.home], ['PROVIDER', saved.provider], ['LEITBILD_SEED_WORKSPACE', saved.seed]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const dir of [dataDir, uiDir, planningHome, leitbildHome]) await rm(dir, { recursive: true, force: true })
  })

  const routing = createDirectRoutingAdapter()
  const worldAssembly = createWorldApplicationAssembly({ routing })
  const worldRegistry = createWorldWorkspaceRuntimeRegistry({
    dataDir, moduleState: createWorldModuleState({ dataDir }),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: worldAssembly.packs }),
    scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, worldAssembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(worldAssembly.packs),
    runtimeAdapters: worldAssembly.runtimeAdapters,
  })
  const worldServer = createWorldServer({ workspaces: worldRegistry, featuredDefinitions: builtinFeaturedScenarioDefinitions, bindHost: '127.0.0.1', port: 0, uiDistPath: uiDir, mapArtifacts: { rootDir: join(dataDir, 'maps') } })
  cleanup.push(() => worldServer.stop())
  // Lane W's descriptor on World's catalogue and Runs, until World publishes its own.
  const worldProxy = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const forwarded = await fetch(`http://127.0.0.1:${worldServer.port}${url.pathname}${url.search}`, {
        method: request.method, headers: request.headers, ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
      })
      if (request.method !== 'GET' || !/\/internal\/workspaces\/[^/]+\/(capabilities|resources)$/.test(url.pathname)) return forwarded
      const body = await forwarded.json() as { capabilities?: Array<{ id: string }>; resources?: Array<{ ref: { type: string }; capabilityIds: string[] }> }
      if (body.capabilities?.some(capability => capability.id === planningFactsDescriptor.id)) throw new Error('World publishes planning-facts now: remove the lane W double from planning-search.test.ts')
      if (body.capabilities) body.capabilities.push(planningFactsDescriptor as never)
      for (const resource of body.resources ?? []) if (resource.ref.type === 'world.simulation-run') resource.capabilityIds.push(planningFactsDescriptor.id)
      return Response.json(body, { status: forwarded.status })
    },
  })
  cleanup.push(() => worldProxy.stop(true))

  let agentsRegistry: WorkspaceRuntimeRegistry | undefined
  const agentsState = createAgentsModuleState()
  const agentsServer = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (!agentsRegistry) return Response.json({ error: { code: 'runtime_unavailable' } }, { status: 503 })
      return await handleAgentsModuleApi(request, new URL(request.url), { state: agentsState, registry: agentsRegistry }) ?? new Response('Not found', { status: 404 })
    },
  })
  cleanup.push(async () => { await agentsRegistry?.shutdown(); agentsServer.stop(true) })

  const store = createPlanStore(planningHome)
  const definitions = createPlanDefinitions()
  const operations = createPlanningOperations({
    store, definitions, solver: createSolverDouble(), checker: createCheckerDouble(),
    world: { read: async () => { throw new Error('the search test reads no World facts') } },
  })
  const planningServer = createPlanningServer({ operations, definitions, store, port: 0, uiDistPath: planningHome })
  cleanup.push(() => planningServer.stop(true))

  const workspaceStore = createWorkspaceStore(':memory:')
  cleanup.push(() => workspaceStore.close())
  const registration = (moduleId: string, port: number | undefined) => moduleRegistrationSchema.parse({ moduleId, internalBaseUrl: `http://127.0.0.1:${port}`, manifestPath: '/.well-known/workspace-module' })
  const host = createWorkspaceHost({ store: workspaceStore, modules: createModuleGateway({ registrations: [registration('world', worldProxy.port), registration('agents', agentsServer.port), registration('planning', planningServer.port)] }) })
  const hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port: 0 })
  cleanup.push(() => hostServer.stop(true))
  const hostUrl = `http://127.0.0.1:${hostServer.port}`

  const deployment = createDeploymentRuntime()
  agentsRegistry = createAgentsWorkspaceRuntimeRegistry({ deployment, moduleState: agentsState, workspaceHostUrl: hostUrl, idleMs: 1_000_000 })

  const created = await fetch(`${hostUrl}/api/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Planning search' }) })
  const workspaceId: WorkspaceId = workspaceIdSchema.parse(((await created.json()) as { workspace: { id: string } }).workspace.id)
  const definitionCatalog = workspaceDefinitionCatalogSchema.parse(await (await fetch(`${hostUrl}/api/workspaces/${workspaceId}/definitions`)).json())
  const start = async (type: string, id: string, capabilityId: string) => {
    const definition = definitionCatalog.definitions.find(entry => entry.ref.type === type && entry.ref.id === id)!
    const response = await fetch(`${hostUrl}/api/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition: { ...definition.ref, revisionId: definition.currentRevisionId }, input: {} }),
    })
    if (!response.ok) throw new Error(`${id} did not start: ${await response.text()}`)
  }
  await start('world.scenario', 'supply-run', 'world.scenario.start')
  await start('world.scenario', 'halden-rhr-cooling-chain', 'world.scenario.start')
  await start('planning.plan-definition', 'train-a-work-week', 'planning.plan.create')

  const tools = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: hostUrl, getRoomScope: () => ({ kind: 'workspace' }) })
  const workspaceExplore = tools.find(tool => tool.name === 'workspace_explore')!
  explore = async query => {
    const answer = await workspaceExplore.execute({ view: 'operations', queries: [query], limit: 3 }, { callerId: 'assistant', callerName: 'Assistant', roomId: 'room' }) as { success: boolean; data: { operations: Array<{ operationId: string }> } }
    if (!answer.success) throw new Error(`workspace_explore failed: ${JSON.stringify(answer)}`)
    return answer.data.operations.map(operation => operation.operationId)
  }
}, 120_000)

afterAll(async () => { for (const step of cleanup.reverse()) await step() })

test('the phrasings are maint\'s frozen file', async () => {
  expect(createHash('sha256').update(new Uint8Array(await Bun.file(phrasingsFile).arrayBuffer())).digest('hex')).toBe(frozen)
  expect(rows.filter(row => row.id.startsWith('P')).map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, index) => `P${index + 1}`))
  expect(rows.filter(row => row.id.startsWith('A')).map(row => row.id)).toEqual(['A1', 'A2', 'A3', 'A4'])
})

test('at least 18 of P1-P20 rank the expected operation in the top 3; A1-A4 are reported', async () => {
  const scored = [] as Array<{ id: string; hit: boolean; top: string[] }>
  for (const row of rows.filter(entry => entry.id.startsWith('P'))) {
    const top = await explore(row.phrase)
    scored.push({ id: row.id, hit: top.includes(row.expected[0]!), top })
  }
  const reported = [] as Array<{ id: string; hit: boolean; top: string[] }>
  for (const row of rows.filter(entry => entry.id.startsWith('A'))) {
    const top = await explore(row.phrase)
    reported.push({ id: row.id, hit: top.some(id => row.expected.includes(id)), top })
  }
  console.log(`Search ranking: ${scored.filter(entry => entry.hit).length}/20 scored; ambiguous ${reported.filter(entry => entry.hit).length}/4 within an acceptable set`)
  for (const entry of [...scored, ...reported]) console.log(`${entry.hit ? 'hit ' : 'MISS'} ${entry.id}: ${entry.top.join(', ')}`)
  expect(scored.filter(entry => entry.hit).length).toBeGreaterThanOrEqual(18)
}, 60_000)
