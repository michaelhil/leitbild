import { newWorkspaceId,type WorkspaceId } from '@leitbild/contracts'
import { describe,expect,test } from 'bun:test'
import { access,mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ActorId,
  InteractionSignal,
  SignalId,
  SimulationRunEvent,
  SimulationRunId,
} from '../src/core/model/index.ts'
import { nowIso,simulationRunIdSchema } from '../src/core/model/index.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { dispatchCommandKind } from '../src/packs/ambulance/commands.ts'
import { responseScenario } from './fixtures/scenarios.ts'
import { createTestPackRuntimeAdapters,createTestScenarioRuntimeResolver,testScenarioAuthoring } from './helpers.ts'

const createRegistry = (dataDir: string, workspaceId: WorkspaceId = newWorkspaceId()) =>
  createSimulationRunRegistry({
    dataDir,
    workspaceId,
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
    ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
  })

const simulationRunDir = (
  dataDir: string,
  workspaceId: WorkspaceId,
  simulationRunId: SimulationRunId,
): string => join(dataDir, 'workspaces', workspaceId, 'world', 'simulation-runs', simulationRunId)

const issueDispatchCommand = async (runtime: SimulationRunRuntime): Promise<void> => {
  const snapshot = runtime.snapshot()
  const ambulance = snapshot.objects.find(object =>
    object.kind === 'mobile_entity' && object.operational.status === 'available')
  const incident = snapshot.objects.find(object => object.kind === 'incident' && snapshot.objects.some(patient => (patient.packData as { type?: string; incidentId?: string }).type === 'patient' && (patient.packData as { incidentId?: string }).incidentId === object.id))
  if (!ambulance || !incident) throw new Error('Scenario missing ambulance or incident')
  const outcome = await runtime.invokeCapability(
    { id: 'actor:test-operator' as ActorId, label: 'Test Operator', role: 'operator' },
    {
      capabilityId: dispatchCommandKind,
      input: { ambulanceId: ambulance.id, incidentId: incident.id, patientIds: snapshot.objects.filter(object => (object.packData as { type?: string; incidentId?: string }).type === 'patient' && (object.packData as { incidentId?: string }).incidentId === incident.id).slice(0, 1).map(object => object.id) },
    },
  )
  expect(outcome.kind).toBe('command')
  if (outcome.kind !== 'command') throw new Error('expected command Capability result')
  expect(outcome.result.ok).toBe(true)
}

describe('Simulation Run registry', () => {
  test('forks a coherent independent Run and accelerates it to an exact paused horizon', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-accelerated-copy-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    try {
      const source = await registry.create({ scenarioId: 'test-response' })
      await source.setClock({ paused: true })
      const sourceBefore = structuredClone(source.snapshot())
      const { runtime: copy } = await registry.createAcceleratedCopy(source.id, { minutes: 0.01, name: 'What-if' })
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if ((await registry.accelerationStatus(copy.id))?.status === 'completed') break
        await Bun.sleep(25)
      }
      const completed = await registry.accelerationStatus(copy.id)
      expect(completed?.currentSimulationTime).toBe(completed?.targetSimulationTime)
      expect(copy.snapshot().clock).toMatchObject({ paused: true, currentTime: completed?.targetSimulationTime })
      expect(source.snapshot().clock?.currentTime).toBe(sourceBefore.clock?.currentTime)
      expect(source.snapshot().objects).toEqual(sourceBefore.objects)
      expect((await registry.summary(copy.id)).title).toBe('What-if')
      const manifest = JSON.parse(await readFile(join(simulationRunDir(dataDir, workspaceId, copy.id), 'manifest.json'), 'utf8')) as { origin?: unknown }
      expect(manifest.origin).toMatchObject({ kind: 'accelerated-copy', sourceRunId: source.id, sourceSequence: sourceBefore.seq })
      await expect(access(join(simulationRunDir(dataDir, workspaceId, copy.id), 'events.jsonl'))).rejects.toThrow()
    } finally { await registry.shutdown() }
  })
  test('pauses accelerated execution without overshooting its current slice', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-accelerated-pause-'))
    const registry = createRegistry(dataDir)
    try {
      const source = await registry.create({ scenarioId: 'test-response' })
      await source.setClock({ paused: true })
      const { runtime: copy } = await registry.createAcceleratedCopy(source.id, { minutes: 10 })
      await registry.pauseAcceleration(copy.id)
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if ((await registry.accelerationStatus(copy.id))?.status !== 'running') break
        await Bun.sleep(25)
      }
      const paused = await registry.accelerationStatus(copy.id)
      expect(paused?.status).toBe('paused')
      expect(Date.parse(paused!.currentSimulationTime)).toBeLessThan(Date.parse(paused!.targetSimulationTime))
      expect(copy.snapshot().clock).toMatchObject({ paused: true, currentTime: paused?.currentSimulationTime })
    } finally { await registry.shutdown() }
  })
  test('accelerates the coupled four-unit Plant, Grid, and Weather scenario through one Run boundary', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-accelerated-halden-'))
    const registry = createRegistry(dataDir)
    try {
      const source = await registry.create({ scenarioId: 'halden-power-complex' })
      await source.setClock({ paused: true })
      const { runtime: copy } = await registry.createAcceleratedCopy(source.id, { minutes: 0.01 })
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if ((await registry.accelerationStatus(copy.id))?.status !== 'running') break
        await Bun.sleep(25)
      }
      expect(await registry.accelerationStatus(copy.id)).toMatchObject({ status: 'completed' })
      const snapshot = copy.snapshot()
      expect(snapshot.objects.filter(object => object.packId === 'process-plant' && object.kind === 'facility')).toHaveLength(4)
      expect(snapshot.objects.some(object => object.id === 'grid:halden-four-unit')).toBe(true)
      expect(snapshot.objects.some(object => object.id === 'weather:halden-complex')).toBe(true)
    } finally { await registry.shutdown() }
  })
  test('starts the Halden dispatch exercise with real responses underway and advances their routes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-accelerated-dispatch-'))
    const registry = createRegistry(dataDir)
    try {
      const source = await registry.create({ scenarioId: 'halden-dispatch' })
      await source.setClock({ paused: true })
      const sourceUnits = source.snapshot().objects.filter(object =>
        object.packId === 'ambulance' && (object.packData as { type?: string }).type === 'ambulance')
      const responding = sourceUnits.filter(object =>
        (object.packData as { assignment?: { phase?: string } }).assignment?.phase === 'responding')
      expect(responding.map(object => String(object.id)).sort()).toEqual(['amb:halden-1', 'amb:halden-2'])
      expect(sourceUnits.find(object => object.id === 'amb:sarpsborg-1')?.operational.status).toBe('available')

      const startingPoints = new Map(responding.map(object => [object.id, object.spatial.position?.point.coordinates]))
      const { runtime: copy } = await registry.createAcceleratedCopy(source.id, { minutes: 0.1 })
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if ((await registry.accelerationStatus(copy.id))?.status !== 'running') break
        await Bun.sleep(25)
      }
      expect(await registry.accelerationStatus(copy.id)).toMatchObject({ status: 'completed' })
      const moved = copy.snapshot().objects.filter(object => startingPoints.has(object.id)).some(object =>
        JSON.stringify(object.spatial.position?.point.coordinates) !== JSON.stringify(startingPoints.get(object.id)))
      expect(moved).toBe(true)
    } finally { await registry.shutdown() }
  })
  test('an unreadable compiled artifact does not hide healthy sibling Runs or rewrite retained state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-unreadable-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const damaged = await registry.create({ scenarioId: 'test-response' })
    const healthy = await registry.create({ scenarioId: 'test-response' })
    await registry.close(damaged.id)
    await registry.close(healthy.id)
    const path = join(simulationRunDir(dataDir, workspaceId, damaged.id), 'compiled-scenario.json')
    await writeFile(path, '{"unsupported":true}')
    const reopened = createRegistry(dataDir, workspaceId)
    await reopened.summary(healthy.id)
    const summaries = await reopened.listKnown()
    expect(summaries.find(run => run.id === damaged.id)).toMatchObject({ loadError: expect.stringContaining('unreadable'), loaded: false })
    expect(summaries.find(run => run.id === healthy.id)).toMatchObject({ title: responseScenario.title, loaded: false })
    expect(summaries.find(run => run.id === healthy.id)?.loadError).toBeUndefined()
    await expect(reopened.load(damaged.id)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('{"unsupported":true}')
  })
  test('keeps independent names across conflicts, reset, template deletion and restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-names-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const first = await registry.create({ scenarioId: 'test-response' })
    const second = await registry.create({ scenarioId: 'test-response' })
    const manifestPath = join(simulationRunDir(dataDir, workspaceId, first.id), 'manifest.json')
    const manifest = await readFile(manifestPath, 'utf8')
    try {
      const results = await Promise.allSettled([
        registry.rename(first.id, 'Operations A', responseScenario.title),
        registry.rename(first.id, 'Operations B', responseScenario.title),
      ])
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
      expect((await registry.listKnown()).find(run => run.id === second.id)?.title).toBe(responseScenario.title)
      await registry.reset(first.id)
      expect((await registry.listKnown()).find(run => run.id === first.id)?.title).toBe('Operations A')
      expect(await readFile(manifestPath, 'utf8')).toBe(manifest)
    } finally {
      await registry.close(first.id)
      await registry.close(second.id)
    }
    const reopened = createRegistry(dataDir, workspaceId)
    expect((await reopened.listKnown()).find(run => run.id === first.id)).toMatchObject({ name: 'Operations A', title: 'Operations A', loaded: false })
    const source = await reopened.currentScenario('test-response')
    if (!source) throw new Error('missing test Scenario')
    const updated = await reopened.updateScenario({ ...source.document, title: 'New template title' }, source.id)
    expect(await reopened.deleteScenario('test-response', updated.id)).toBe(true)
    const restored = await reopened.rename(first.id, null, 'Operations A')
    expect(restored.title).toBe(responseScenario.title)
    expect(restored.name).toBeNull()
    expect(reopened.list()).toEqual([])
    expect((await createRegistry(dataDir, workspaceId).listScenarios()).some(scenario => scenario.id === 'test-response')).toBe(false)
    await reopened.delete(first.id)
    await expect(reopened.rename(first.id, 'Must not resurrect', responseScenario.title)).rejects.toThrow('not found')
    expect((await reopened.listKnown()).map(run => run.id)).toEqual([second.id])
  })

  test('creates an opaque server-owned id and an immutable resolved manifest', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const runtime = await registry.create({ scenarioId: 'test-response' })
    try {
      expect(runtime.id).toMatch(/^run-[0-9a-f-]{36}$/)
      const manifest = JSON.parse(await readFile(
        join(simulationRunDir(dataDir, workspaceId, runtime.id), 'manifest.json'),
        'utf8',
      )) as {
        readonly id: string
        readonly workspaceId: string
        readonly scenario: { readonly id: string; readonly revisionId: string; readonly digest: string; readonly compiledDigest: string }
        readonly packs: ReadonlyArray<{ readonly id: string; readonly version: string }>
        readonly runtimes: ReadonlyArray<{ readonly id: string; readonly version: string; readonly clock: string }>
      }
      expect(manifest.id).toBe(runtime.id)
      expect(manifest.workspaceId).toBe(workspaceId)
      expect(manifest.scenario.id).toBe('test-response')
      expect(manifest.scenario.revisionId).toMatch(/^revision-[a-f0-9]{32}$/)
      expect(manifest.scenario.digest).toMatch(/^[a-f0-9]{64}$/)
      expect(manifest.scenario.compiledDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(manifest.packs.every(pack => pack.version.length > 0)).toBe(true)
      expect(manifest.runtimes.every(adapter => adapter.version.length > 0)).toBe(true)
      expect(manifest.runtimes.map(adapter => adapter.clock).sort()).toEqual(['simulation', 'simulation'])
      const compiledScenario = JSON.parse(await readFile(
        join(simulationRunDir(dataDir, workspaceId, runtime.id), 'compiled-scenario.json'),
        'utf8',
      )) as { readonly id: string }
      expect(compiledScenario.id).toBe(manifest.scenario.id)
    } finally {
      await registry.close(runtime.id)
    }
  })

  test('keeps mutable state isolated between Simulation Runs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const registry = createRegistry(dataDir)
    const changed = await registry.create({ scenarioId: 'test-response' })
    const untouched = await registry.create({ scenarioId: 'test-response' })
    try {
      await issueDispatchCommand(changed)
      expect(changed.snapshot().seq).toBeGreaterThan(untouched.snapshot().seq)
      expect(untouched.snapshot().objects).toHaveLength(responseScenario.initialObjects.length)
      expect(untouched.snapshot().objects.find(object => object.id === 'amb:a12')?.operational.status).toBe('available')
    } finally {
      await registry.close(changed.id)
      await registry.close(untouched.id)
    }
  })

  test('loads a persisted run by its opaque id and coalesces loaded joins', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const first = await firstRegistry.create({ scenarioId: 'test-response' })
    const id = first.id
    await issueDispatchCommand(first)
    await first.setClock({ paused: true })
    const expectedSeq = first.snapshot().seq
    await firstRegistry.close(id)

    const secondRegistry = createRegistry(dataDir, workspaceId)
    const [loaded, joined] = await Promise.all([secondRegistry.load(id), secondRegistry.load(id)])
    try {
      expect(joined).toBe(loaded)
      expect(loaded.snapshot().seq).toBe(expectedSeq)
      expect(loaded.events().some(event => event.type === 'command.issued')).toBe(true)
      expect(secondRegistry.list()).toEqual([loaded])
    } finally {
      await secondRegistry.close(id)
    }
  })

  test('reset preserves the pinned Scenario Revision and restores its initial state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const before = await registry.create({ scenarioId: 'test-response' })
    const id = before.id
    const manifestPath = join(simulationRunDir(dataDir, workspaceId, id), 'manifest.json')
    const manifestBefore = await readFile(manifestPath, 'utf8')
    await issueDispatchCommand(before)

    const after = await registry.reset(id)
    try {
      expect(after).not.toBe(before)
      expect(after.snapshot().scenario?.scenarioId).toBe('test-response')
      expect(after.snapshot().objects.some(object => object.id === 'facility:ous')).toBe(true)
      expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
    } finally {
      await registry.close(id)
    }
  })

  test('lists unloaded runs with pinned revision metadata', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const runtime = await firstRegistry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    const snapshotSeq = runtime.snapshot().seq
    await firstRegistry.close(id)

    const known = await createRegistry(dataDir, workspaceId).listKnown()
    expect(known).toEqual([expect.objectContaining({
      id,
      scenarioId: 'test-response',
      scenarioRevisionId: expect.stringMatching(/^revision-/),
      createdAt: expect.any(String),
      loaded: false,
      snapshotSeq: expect.any(Number),
      objectCount: responseScenario.initialObjects.length,
    })])
    expect(known[0]!.snapshotSeq).toBeGreaterThanOrEqual(snapshotSeq)
  })

  test('deletes loaded and persisted state immediately', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const runtime = await registry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    const runDir = simulationRunDir(dataDir, workspaceId, id)

    expect(await registry.delete(id)).toBe(true)
    await expect(access(runDir)).rejects.toThrow()
    expect(registry.get(id)).toBeUndefined()
    expect(await registry.listKnown()).toEqual([])
    expect(await registry.delete(id)).toBe(false)
  })

  test('reports orphan run directories and refuses to invent their identity', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const id = simulationRunIdSchema.parse('run-orphan')
    await mkdir(simulationRunDir(dataDir, workspaceId, id), { recursive: true })
    const registry = createRegistry(dataDir, workspaceId)

    expect(await registry.listKnown()).toEqual([expect.objectContaining({
      id,
      scenarioId: null,
      scenarioRevisionId: null,
      loadError: 'Simulation Run Manifest is missing',
    })])
    await expect(registry.load(id)).rejects.toThrow(`Simulation Run not found: ${id}`)
  })

  test('fails visibly for a corrupt snapshot instead of resetting it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const runtime = await firstRegistry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    await firstRegistry.close(id)
    await writeFile(join(simulationRunDir(dataDir, workspaceId, id), 'snapshot.json'), '{', 'utf8')

    const secondRegistry = createRegistry(dataDir, workspaceId)
    await expect(secondRegistry.load(id)).rejects.toThrow('Simulation Run snapshot is unreadable')
    expect(await secondRegistry.listKnown()).toEqual([expect.objectContaining({
      id,
      loadError: expect.any(String),
    })])
  })

  test('lists Run resources without parsing their authored revision bodies', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const runtime = await registry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    await registry.close(id)
    const manifest = JSON.parse(await readFile(
      join(simulationRunDir(dataDir, workspaceId, id), 'manifest.json'),
      'utf8',
    )) as { readonly scenario: { readonly revisionId: string } }
    const revisionPath = join(
      dataDir,
      'workspaces',
      workspaceId,
      'world',
      'scenarios',
      'revisions',
      `${manifest.scenario.revisionId}.json`,
    )
    const revision = JSON.parse(await readFile(revisionPath, 'utf8')) as { document: Record<string, unknown> }
    revision.document = { id: 'invalid-pinned-scenario' }
    await writeFile(revisionPath, `${JSON.stringify(revision)}\n`, 'utf8')

    expect(await registry.listKnown()).toEqual([expect.objectContaining({
      id,
      scenarioId: 'test-response',
      scenarioTitle: 'Response fixture',
    })])
  })

  test('fails visibly when pinned Pack versions are unavailable', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const runtime = await firstRegistry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    await firstRegistry.close(id)
    const manifestPath = join(simulationRunDir(dataDir, workspaceId, id), 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      packs: Array<{ id: string; version: string }>
      [key: string]: unknown
    }
    if (!manifest.packs[0]) throw new Error('expected resolved Pack')
    manifest.packs[0].version = '99.0.0'
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    await expect(createRegistry(dataDir, workspaceId).load(id)).rejects.toThrow('Pack version mismatch')
  })

  test('rejects a modified compiled Scenario artifact', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const runtime = await firstRegistry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    await firstRegistry.close(id)
    const compiledPath = join(simulationRunDir(dataDir, workspaceId, id), 'compiled-scenario.json')
    const compiled = JSON.parse(await readFile(compiledPath, 'utf8')) as { title: string; [key: string]: unknown }
    compiled.title = 'Modified after Run creation'
    await writeFile(compiledPath, `${JSON.stringify(compiled, null, 2)}\n`, 'utf8')

    await expect(createRegistry(dataDir, workspaceId).load(id))
      .rejects.toThrow('Compiled Scenario integrity mismatch')
  })

  test('rejects cross-run interaction signals', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const registry = createRegistry(dataDir)
    const runtime = await registry.create({ scenarioId: 'test-response' })
    try {
      const beforeCount = runtime.events().length
      const signal: InteractionSignal = {
        id: `signal:${crypto.randomUUID()}` as SignalId,
        simulationRunId: simulationRunIdSchema.parse('run-other'),
        at: nowIso(),
        source: { kind: 'actor', id: 'actor:test-operator' as ActorId },
        targets: [{ kind: 'broadcast' }],
        type: 'test.signal',
        payload: {},
      }
      await expect(runtime.publishInteractionSignal(signal, { source: 'operator' }))
        .rejects.toThrow('interaction signal simulation run mismatch')
      expect(runtime.events()).toHaveLength(beforeCount)
    } finally {
      await registry.close(runtime.id)
    }
  })

  test('rejects an event log containing another run id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const runtime = await firstRegistry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    await issueDispatchCommand(runtime)
    const events = runtime.events()
    if (!events[0]) throw new Error('expected persisted event')
    await firstRegistry.close(id)
    const wrongEvent: SimulationRunEvent = {
      ...events[0],
      simulationRunId: simulationRunIdSchema.parse('run-other'),
    }
    await writeFile(
      join(simulationRunDir(dataDir, workspaceId, id), 'events.jsonl'),
      `${JSON.stringify(wrongEvent)}\n`,
      'utf8',
    )

    await expect(createRegistry(dataDir, workspaceId).load(id))
      .rejects.toThrow('event log simulation run mismatch')
  })
})


test('pause and speed controls retain simulation progress', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-weather-clock-'))
  const registry = createRegistry(dataDir)
  const runtime = await registry.create({ scenarioId: 'test-response' })
  try {
    await runtime.setClock({ paused: true })
    const before = runtime.snapshot().clock
    await runtime.setClock({ speed: 2 })
    expect(runtime.snapshot().clock?.currentTime).toBe(before?.currentTime)
    expect(runtime.snapshot().clock?.paused).toBe(true)
  } finally { await registry.close(runtime.id) }
})
