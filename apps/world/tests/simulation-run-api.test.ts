import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  accessContextSchema,
  newRequestId,
  newWorkspaceId,
} from '@leitbild/contracts'
import type {
  IsoTimestamp,
  OperationalObject,
  ProcedureCatalog,
  ProcedureDocument,
  SimulationClockState,
  SimulationRunEvent,
  SimulationRunId,
} from '../src/core/model/index.ts'
import { deleteObjectCommandKind, geoPointFromLonLat } from '../src/core/model/index.ts'
import { handleSimulationRunApi } from '../src/core/api/simulation-run-routes.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { ProcedureSourceLoadStatus, ProcedureSourceService } from '../src/core/procedures/source.ts'
import { parseProcedureMarkdown } from '../src/core/procedures/procmd.ts'
import { setDestinationCommandKind } from '../src/packs/ambulance/commands.ts'
import { assetArrivedAtTargetSignalType } from '../src/packs/ambulance/sim/interactions.ts'
import { createTestPackRuntimeAdapters, createTestScenarioCatalog, testPacks } from './helpers.ts'
import { osloAmbulanceScenario } from '../src/scenarios/index.ts'

interface ApiResponse<T> {
  readonly status: number
  readonly body: T
}

const procedureSource = {
  sourceId: 'pwr-ops',
  label: 'PWR operations procedures',
  repository: 'leitbild-wikis/pwr-ops',
  ref: 'main',
  path: 'wiki/procedures',
  commitSha: 'api-test-revision',
  fetchedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
  sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/tree/main/wiki/procedures',
}

const procedureMarkdown = `---
type: procedure
procedure-md: 0.7
procedure-id: E-0
title: Reactor Trip or Safety Injection
profile: nuclear-erg
category: diagnostic-eop
csfs-monitored: [subcriticality]
entry-triggers: [reactor-trip-signal]
---

# E-0 — Reactor Trip or Safety Injection

## Step 1 [id: verify-reactor-trip]
Check: reactor trip breakers «TRIP-BKR-A» OPEN
- Verified → END

## Tags

- id: TRIP-BKR-A
  description: reactor trip breaker A position
  sim-path: rps.trip_breaker.a.position
  units: enum[OPEN,CLOSED]
`

const createProcedureDocument = (): ProcedureDocument =>
  parseProcedureMarkdown({
    source: procedureSource,
    sourcePath: 'wiki/procedures/E-0.md',
    sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/blob/main/wiki/procedures/E-0.md',
    rawMarkdown: procedureMarkdown,
  })

const createProcedureSourceService = (document = createProcedureDocument()): ProcedureSourceService => ({
  listSources: () => [{
    sourceId: document.source.sourceId,
    label: document.source.label,
    repository: document.source.repository,
    ref: document.source.ref,
    path: document.source.path,
  }],
  readStatus: (): ProcedureSourceLoadStatus => ({
    sourceId: document.source.sourceId,
    label: document.source.label,
    repository: document.source.repository,
    ref: document.source.ref,
    path: document.source.path,
    stage: 'ready',
    loadedItems: 1,
    totalItems: 1,
    completedAt: document.source.fetchedAt,
    cached: true,
  }),
  readCatalog: async (): Promise<ProcedureCatalog> => ({
    source: document.source,
    procedures: [{
      sourceId: document.source.sourceId,
      procedureId: document.procedureId,
      title: document.title,
      ...(document.profile === undefined ? {} : { profile: document.profile }),
      ...(document.category === undefined ? {} : { category: document.category }),
      csfsMonitored: document.csfsMonitored,
      entryTriggers: document.entryTriggers,
      stepCount: document.steps.length,
      tagCount: document.tags.length,
      sourcePath: document.sourcePath,
      sourceUrl: document.sourceUrl,
    }],
  }),
  readDocument: async (config): Promise<ProcedureDocument> => {
    if (config.procedureId !== document.procedureId) throw new Error(`unknown procedure ${config.procedureId}`)
    return document
  },
})

const createTestRegistry = async (config: {
  readonly procedureSourceService?: ProcedureSourceService
} = {}): Promise<SimulationRunRegistry> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-api-test-'))
  return createSimulationRunRegistry({
    dataDir,
    workspaceId: newWorkspaceId(),
    scenarioCatalog: createTestScenarioCatalog(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
    interactionHandlers: testPacks.flatMap(pack => pack.interactions?.handlers ?? []),
    ...(config.procedureSourceService === undefined
      ? {}
      : { procedureSourceService: config.procedureSourceService }),
  })
}

const callRoute = async <T>(
  registry: SimulationRunRegistry,
  path: string,
  init?: RequestInit,
  websocketClients?: ReadonlyArray<{ readonly id: SimulationRunId; readonly websocketClientCount: number }>,
): Promise<ApiResponse<T>> => {
  const apiPrefix = `/api/workspaces/${encodeURIComponent(registry.workspaceId)}/world`
  const request = new Request(`http://leitbild.test${apiPrefix}${path}`, init)
  const response = await handleSimulationRunApi(request, new URL(request.url), {
    registry,
    accessContext: accessContextSchema.parse({
      workspaceId: registry.workspaceId,
      requestId: newRequestId(),
      actor: { kind: 'anonymous' },
    }),
    ...(websocketClients === undefined ? {} : { websocketClients }),
  })
  if (!response) throw new Error(`route did not handle ${init?.method ?? 'GET'} ${path}`)
  return { status: response.status, body: await response.json() as T }
}

interface CreatedRunResponse {
  readonly id: SimulationRunId
  readonly scenario?: { readonly id: string; readonly packs: readonly string[] }
  readonly snapshot: {
    readonly seq: number
    readonly scenario?: { readonly scenarioId: string }
    readonly clock?: SimulationClockState
    readonly objects: readonly OperationalObject[]
  }
}

const createRun = async (
  registry: SimulationRunRegistry,
  scenarioId?: string,
): Promise<CreatedRunResponse> => {
  const response = await callRoute<CreatedRunResponse>(registry, '/simulation-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scenarioId === undefined ? {} : { scenarioId }),
  })
  expect(response.status).toBe(201)
  return response.body
}

const runPath = (id: SimulationRunId, suffix = ''): string =>
  `/simulation-runs/${encodeURIComponent(id)}${suffix}`

const closeAll = async (registry: SimulationRunRegistry): Promise<void> => {
  for (const runtime of registry.list()) await registry.close(runtime.id)
}

describe('Simulation Run API', () => {
  test('lists public Scenario metadata and fetches complete definitions', async () => {
    const registry = await createTestRegistry()
    const listed = await callRoute<{
      readonly defaultScenarioId: string
      readonly scenarios: ReadonlyArray<{ readonly id: string; readonly packs?: readonly string[] }>
    }>(registry, '/scenarios')
    expect(listed.status).toBe(200)
    expect(listed.body.defaultScenarioId).toBe('oslo-ambulance')
    expect(listed.body.scenarios.map(scenario => scenario.id)).toContain('halden-process-plant-demo')
    expect(listed.body.scenarios.every(scenario => scenario.packs === undefined)).toBe(true)

    const fetched = await callRoute<{
      readonly scenario: {
        readonly id: string
        readonly packs: readonly string[]
        readonly initialObjects: ReadonlyArray<{ readonly packId: string }>
        readonly processSystems: readonly unknown[]
      }
    }>(registry, '/scenarios/halden-process-plant-demo')
    expect(fetched.body.scenario.packs).toEqual(['process-plant', 'ambulance', 'weather'])
    expect(fetched.body.scenario.initialObjects.filter(object => object.packId === 'process-plant')).toHaveLength(7)
    expect(fetched.body.scenario.processSystems).toHaveLength(7)
  })

  test('creates opaque runs, rejects caller-owned ids, and lists revision metadata', async () => {
    const registry = await createTestRegistry()
    try {
      const rejectedLegacyShape = await callRoute<{ readonly error: { readonly code: string } }>(
        registry,
        '/simulation-runs',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'named-run', scenarioId: 'oslo-ambulance' }),
        },
      )
      expect(rejectedLegacyShape.status).toBe(400)
      expect(rejectedLegacyShape.body.error.code).toBe('invalid_request')

      const created = await createRun(registry, 'oslo-all-packs-demo')
      expect(created.id).toMatch(/^run-[0-9a-f-]{36}$/)
      expect(created.scenario?.id).toBe('oslo-all-packs-demo')
      expect(created.snapshot.objects.filter(object => object.packId === 'process-plant')).toHaveLength(4)
      expect(created.snapshot.objects.filter(object => object.packId === 'electric-grid').length).toBeGreaterThan(200)

      const listed = await callRoute<{
        readonly simulationRuns: ReadonlyArray<{
          readonly id: SimulationRunId
          readonly scenarioId: string
          readonly scenarioRevisionId: string
          readonly createdAt: string
          readonly websocketClientCount: number
        }>
      }>(registry, '/simulation-runs')
      expect(listed.body.simulationRuns).toEqual([expect.objectContaining({
        id: created.id,
        scenarioId: 'oslo-all-packs-demo',
        scenarioRevisionId: expect.stringMatching(/^revision-/),
        createdAt: expect.any(String),
        websocketClientCount: 0,
      })])
    } finally {
      await closeAll(registry)
    }
  })

  test('joins only existing runs and exposes their objects and capabilities', async () => {
    const registry = await createTestRegistry()
    try {
      const created = await createRun(registry)
      await registry.close(created.id)
      const joined = await callRoute<CreatedRunResponse>(registry, runPath(created.id))
      expect(joined.status).toBe(200)
      expect(joined.body.id).toBe(created.id)
      expect(joined.body.snapshot.objects).toHaveLength(osloAmbulanceScenario.initialObjects.length)

      const objects = await callRoute<{ readonly objects: readonly OperationalObject[] }>(
        registry,
        runPath(created.id, '/objects'),
      )
      expect(objects.body.objects).toHaveLength(osloAmbulanceScenario.initialObjects.length)

      const capabilities = await callRoute<{
        readonly simulationRunId: SimulationRunId
        readonly scenarioId: string
        readonly activePackIds: readonly string[]
        readonly acceptedCommandKinds: readonly string[]
      }>(registry, runPath(created.id, '/capabilities'))
      expect(capabilities.body).toMatchObject({
        simulationRunId: created.id,
        scenarioId: 'oslo-ambulance',
        activePackIds: ['ambulance', 'traffic', 'weather'],
      })
      expect(capabilities.body.acceptedCommandKinds).toContain(setDestinationCommandKind)

      const missing = await callRoute<{ readonly error: { readonly code: string } }>(
        registry,
        '/simulation-runs/run-missing',
      )
      expect(missing.status).toBe(404)
      expect(missing.body.error.code).toBe('simulation_run_not_found')
    } finally {
      await closeAll(registry)
    }
  })

  test('rejects unknown Scenarios and invalid run ids with structured errors', async () => {
    const registry = await createTestRegistry()
    const unknownScenario = await callRoute<{ readonly error: { readonly code: string } }>(
      registry,
      '/simulation-runs',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'missing-scenario' }),
      },
    )
    expect(unknownScenario.status).toBe(404)
    expect(unknownScenario.body.error.code).toBe('scenario_not_found')

    const invalidId = await callRoute<{ readonly error: { readonly code: string } }>(
      registry,
      '/simulation-runs/not-a-run/objects',
    )
    expect(invalidId.status).toBe(400)
    expect(invalidId.body.error.code).toBe('invalid_request')
  })

  test('routes generic Pack queries through the run-pinned runtime set', async () => {
    const registry = await createTestRegistry()
    try {
      const created = await createRun(registry)
      const weather = await callRoute<{
        readonly response: { readonly ok: boolean; readonly result?: { readonly state?: unknown } }
      }>(registry, runPath(created.id, '/queries'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packId: 'weather',
          kind: 'weather.sampleAtPoint',
          payload: { point: geoPointFromLonLat(10.7522, 59.9139) },
        }),
      })
      expect(weather.status).toBe(200)
      expect(weather.body.response.ok).toBe(true)
      expect(weather.body.response.result?.state).toBeTruthy()

      const ambulance = await callRoute<{
        readonly response: { readonly ok: boolean; readonly result?: { readonly ambulances?: readonly unknown[] } }
      }>(registry, runPath(created.id, '/queries'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId: 'ambulance', kind: 'ambulance.dispatchState', payload: {} }),
      })
      expect(ambulance.body.response.result?.ambulances?.length).toBeGreaterThan(0)
    } finally {
      await closeAll(registry)
    }
  })

  test('reset restores the pinned Scenario without accepting replacement configuration', async () => {
    const registry = await createTestRegistry()
    try {
      const created = await createRun(registry, 'halden')
      const runtime = registry.get(created.id)
      if (!runtime) throw new Error('expected loaded run')
      const notifications: SimulationRunEvent[][] = []
      const unsubscribe = runtime.subscribe(notification => notifications.push([...notification.events]))
      const facility = created.snapshot.objects.find(object => object.kind === 'facility')
      if (!facility) throw new Error('expected facility')
      await callRoute(registry, runPath(created.id, '/commands'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: deleteObjectCommandKind,
          targetObjectIds: [facility.id],
          payload: { objectId: facility.id },
        }),
      })
      const previousSeq = runtime.snapshot().seq

      const reset = await callRoute<CreatedRunResponse>(registry, runPath(created.id, '/reset'), {
        method: 'POST',
      })
      unsubscribe()
      const resetEvent = notifications.flat().find(event => event.type === 'simulationRun.reset')
      expect(reset.status).toBe(200)
      expect(reset.body.snapshot.scenario?.scenarioId).toBe('halden')
      expect(reset.body.snapshot.objects.some(object => object.id === facility.id)).toBe(true)
      expect(resetEvent).toMatchObject({
        previousSeq,
        previousScenarioId: 'halden',
        scenarioId: 'halden',
      })
    } finally {
      await closeAll(registry)
    }
  })

  test('hard-deletes a run only when it has no connected users', async () => {
    const registry = await createTestRegistry()
    const created = await createRun(registry)
    const blocked = await callRoute<{ readonly error: { readonly code: string } }>(
      registry,
      runPath(created.id),
      { method: 'DELETE' },
      [{ id: created.id, websocketClientCount: 1 }],
    )
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe('simulation_run_has_users')

    const deleted = await callRoute<{ readonly deleted: boolean }>(
      registry,
      runPath(created.id),
      { method: 'DELETE' },
      [{ id: created.id, websocketClientCount: 0 }],
    )
    expect(deleted.status).toBe(200)
    expect(deleted.body.deleted).toBe(true)
    expect(await registry.listKnown()).toEqual([])
  })

  test('records attributed commands and interaction effects in run-scoped events', async () => {
    const registry = await createTestRegistry()
    try {
      const created = await createRun(registry)
      const ambulance = created.snapshot.objects.find(object => object.kind === 'mobile_entity')
      const incident = created.snapshot.objects.find(object => object.kind === 'incident')
      if (!ambulance || !incident) throw new Error('expected ambulance and incident')

      const command = await callRoute<{ readonly result: { readonly ok: boolean } }>(
        registry,
        runPath(created.id, '/commands'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actorId: 'actor:test-api-operator',
            clientId: 'client:test-map',
            idempotencyKey: `api-attribution-${crypto.randomUUID()}`,
            kind: setDestinationCommandKind,
            targetObjectIds: [ambulance.id, incident.id],
            payload: { ambulanceId: ambulance.id, destinationId: incident.id },
          }),
        },
      )
      expect(command.body.result.ok).toBe(true)

      const signal = await callRoute<{ readonly signal: { readonly type: string } }>(
        registry,
        runPath(created.id, '/signals'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actorId: 'actor:test-api-operator',
            source: { kind: 'object', id: ambulance.id },
            type: assetArrivedAtTargetSignalType,
            targetObjectIds: [incident.id],
            payload: { targetObjectId: incident.id },
          }),
        },
      )
      expect(signal.status).toBe(202)

      const events = await callRoute<{
        readonly events: ReadonlyArray<{
          readonly simulationRunId: SimulationRunId
          readonly type: string
          readonly command?: { readonly actorId: string; readonly clientId?: string }
        }>
      }>(registry, runPath(created.id, '/events'))
      expect(events.body.events.every(event => event.simulationRunId === created.id)).toBe(true)
      expect(events.body.events.find(event => event.type === 'command.issued')?.command).toMatchObject({
        actorId: 'actor:test-api-operator',
        clientId: 'client:test-map',
      })
      expect(events.body.events.some(event => event.type === 'interaction.signal.received')).toBe(true)
      expect(events.body.events.some(event => event.type === 'notification.emitted')).toBe(true)
    } finally {
      await closeAll(registry)
    }
  })

  test('exposes procedure sources and synchronizes procedure run state through commands', async () => {
    const registry = await createTestRegistry({ procedureSourceService: createProcedureSourceService() })
    try {
      const created = await createRun(registry)
      const catalog = await callRoute<{ readonly catalog: ProcedureCatalog }>(
        registry,
        runPath(created.id, '/procedures'),
      )
      expect(catalog.body.catalog.procedures.map(procedure => procedure.procedureId)).toEqual(['E-0'])

      const status = await callRoute<{ readonly status: ProcedureSourceLoadStatus }>(
        registry,
        `${runPath(created.id, '/procedure-source-status')}?sourceId=pwr-ops`,
      )
      expect(status.body.status).toMatchObject({ sourceId: 'pwr-ops', stage: 'ready', cached: true })

      const document = await callRoute<{ readonly procedure: ProcedureDocument }>(
        registry,
        runPath(created.id, '/procedures/E-0'),
      )
      expect(document.body.procedure.steps.map(step => step.id)).toEqual(['verify-reactor-trip'])

      await callRoute(registry, runPath(created.id, '/commands'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'procedure.run.start',
          targetObjectIds: [],
          payload: {
            sourceId: 'pwr-ops',
            procedureId: 'E-0',
            scope: {
              systemId: 'procedure-api-unit',
              targetObjectId: 'object:procedure-api-unit',
              label: 'Procedure API unit',
            },
          },
        }),
      })
      const runs = await callRoute<{
        readonly procedures: { readonly runs: ReadonlyArray<{ readonly procedureId: string; readonly status: string }> }
      }>(registry, runPath(created.id, '/procedure-runs'))
      expect(runs.body.procedures.runs).toEqual([
        expect.objectContaining({ procedureId: 'E-0', status: 'active' }),
      ])
    } finally {
      await closeAll(registry)
    }
  })

  test('updates the clock only inside the addressed run', async () => {
    const registry = await createTestRegistry()
    try {
      const first = await createRun(registry)
      const second = await createRun(registry)
      const changed = await callRoute<{ readonly clock: SimulationClockState }>(
        registry,
        runPath(first.id, '/clock'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: true, speed: 2 }),
        },
      )
      expect(changed.body.clock).toMatchObject({ paused: true, speed: 2 })
      expect(registry.get(first.id)?.snapshot().clock?.paused).toBe(true)
      expect(registry.get(second.id)?.snapshot().clock?.paused).toBe(false)
    } finally {
      await closeAll(registry)
    }
  })
})
