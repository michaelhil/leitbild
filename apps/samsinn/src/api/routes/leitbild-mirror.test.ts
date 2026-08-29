import { afterEach, describe, expect, test } from 'bun:test'
import { leitbildMirrorRoutes } from './leitbild-mirror.ts'
import { __injectClient, __resetClientPool, type LeitbildClient } from '../../integrations/leitbild/client.ts'
import type { SimulationRunSummary, LeitbildEventHandler, SubscriptionHandle } from '../../integrations/leitbild/types.ts'
import { createLeitbildModuleBinding } from '../../integrations/leitbild/client.ts'
import { workspaceIdSchema } from '@samsinn-leitbild/platform-contracts'
import { createWorkspaceSettings } from '../../core/workspaces/settings.ts'

const BASE_URL = 'https://leitbild.samsinn.app'
const WORKSPACE_ID = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111')
const connection = { moduleBinding: createLeitbildModuleBinding(BASE_URL), workspaceId: WORKSPACE_ID }

interface FakeClientOptions {
  readonly simulationRuns: ReadonlyArray<SimulationRunSummary>
  readonly capabilitiesByInstance: Readonly<Record<string, Record<string, unknown>>>
  readonly queryByInstance: Readonly<Record<string, unknown>>
  readonly createdId?: string
}

interface FakeClientState {
  readonly client: LeitbildClient
  readonly createdScenarioIds: string[]
}

const mkClient = (options: FakeClientOptions): FakeClientState => {
  const createdScenarioIds: string[] = []
  const createdId = options.createdId ?? 'created-pwr'
  const missing = (kind: string, id: string): never => {
    throw new Error(`no ${kind} for ${id}`)
  }
  const client: LeitbildClient = {
    connection,
    baseUrl: BASE_URL,
    getManifest: async () => ({}) as never,
    provisionWorkspace: async () => {},
    listSimulationRuns: async () => options.simulationRuns,
    createSimulationRun: async (scenarioId: string) => {
      createdScenarioIds.push(scenarioId)
      return { id: createdId }
    },
    getSnapshot: async () => ({ seq: 0 }),
    getScenario: async () => undefined,
    getEvents: async () => [],
    callPackQuery: async (workspaceId: string) =>
      options.queryByInstance[workspaceId] ?? missing('query result', workspaceId),
    callCommand: async () => ({}),
    getCapabilities: async (workspaceId: string) =>
      options.capabilitiesByInstance[workspaceId] ?? missing('capabilities', workspaceId),
    subscribe: (_simulationRunId: string, _handler: LeitbildEventHandler, _startSeq: number): SubscriptionHandle => ({
      close: () => {},
      lastSeq: () => 0,
    }),
  }
  return { client, createdScenarioIds }
}

const invokeSelect = async (body: Record<string, unknown>, client: LeitbildClient): Promise<Response> => {
  __injectClient(connection, client, WORKSPACE_ID)
  const path = '/leitbild-proxy/simulation-runs/select'
  const route = leitbildMirrorRoutes.find(r => r.method === 'POST' && r.pattern.test(path))
  if (!route) throw new Error('select route not found')
  const match = path.match(route.pattern)
  if (!match) throw new Error('select route did not match')
  const settings = createWorkspaceSettings()
  settings.setModuleBinding(connection.moduleBinding)
  return route.handler(
    new Request(`http://samsinn.test${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    match,
    { workspaceId: WORKSPACE_ID, system: { settings } } as never,
  ) as Promise<Response>
}

const processPlantCapabilities = (): Record<string, unknown> => ({
  activePackIds: ['process-plant'],
  queryKinds: { 'process-plant': ['process-plant.systems.list', 'process-plant.transient.diagnostics'] },
})

const selectBody = (): Record<string, unknown> => ({
  preferredScenarioId: 'halden-process-plant-demo',
  candidateScenarioIds: ['halden-process-plant-demo', 'oslo-all-packs-demo'],
  requiredPackId: 'process-plant',
  requiredQueryKind: 'process-plant.systems.list',
  probePayload: {},
})

afterEach(() => { __resetClientPool() })

describe('Leitbild proxy simulation-run selection', () => {
  test('reuses a readable process-plant instance', async () => {
    const fake = mkClient({
      simulationRuns: [
        { id: 'older', scenarioId: 'halden-process-plant-demo', scenarioRevisionId: 'revision-old', createdAt: '2026-01-01T00:00:00Z', loaded: true, snapshotSeq: 2, objectCount: 1, websocketClientCount: 0 },
        { id: 'fresh', scenarioId: 'halden-process-plant-demo', scenarioRevisionId: 'revision-new', createdAt: '2026-01-02T00:00:00Z', loaded: true, snapshotSeq: 10, objectCount: 1, websocketClientCount: 0 },
      ],
      capabilitiesByInstance: {
        older: processPlantCapabilities(),
        fresh: processPlantCapabilities(),
      },
      queryByInstance: {
        older: { systems: [{ id: 'old-plant' }] },
        fresh: { response: { ok: true, result: { systems: [{ id: 'fresh-plant' }] } } },
      },
    })

    const res = await invokeSelect(selectBody(), fake.client)
    const data = await res.json() as { simulationRunId?: string; created?: boolean; systemIds?: ReadonlyArray<string> }

    expect(res.status).toBe(200)
    expect(data.simulationRunId).toBe('fresh')
    expect(data.created).toBe(false)
    expect(data.systemIds).toEqual(['fresh-plant'])
    expect(fake.createdScenarioIds).toEqual([])
  })

  test('creates a preferred scenario when existing candidates fail the process-plant probe', async () => {
    const fake = mkClient({
      simulationRuns: [
        { id: 'bad', scenarioId: 'halden-process-plant-demo', scenarioRevisionId: 'revision-bad', createdAt: '2026-01-01T00:00:00Z', loaded: true, snapshotSeq: 20, objectCount: 1, websocketClientCount: 0 },
      ],
      capabilitiesByInstance: {
        bad: { activePackIds: ['weather'], queryKinds: { weather: ['weather.fieldStats'] } },
        'created-pwr': processPlantCapabilities(),
      },
      queryByInstance: {
        'created-pwr': { systems: [{ id: 'new-plant' }] },
      },
      createdId: 'created-pwr',
    })

    const res = await invokeSelect(selectBody(), fake.client)
    const data = await res.json() as { simulationRunId?: string; created?: boolean; systemIds?: ReadonlyArray<string>; skippedCandidates?: ReadonlyArray<string> }

    expect(res.status).toBe(200)
    expect(data.simulationRunId).toBe('created-pwr')
    expect(data.created).toBe(true)
    expect(data.systemIds).toEqual(['new-plant'])
    expect(data.skippedCandidates?.[0]).toContain('missing active pack')
    expect(fake.createdScenarioIds).toEqual(['halden-process-plant-demo'])
  })

  test('rejects request-level base URL overrides', async () => {
    const fake = mkClient({
      simulationRuns: [],
      capabilitiesByInstance: {},
      queryByInstance: {},
    })

    const res = await invokeSelect({ ...selectBody(), baseUrl: 'https://example.com' }, fake.client)
    const data = await res.json() as { error?: string }

    expect(res.status).toBe(400)
    expect(data.error).toContain('unexpected fields: baseUrl')
  })
})
