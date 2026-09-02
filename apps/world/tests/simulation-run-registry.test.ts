import { describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import type {
  ActorId,
  InteractionSignal,
  SignalId,
  SimulationRunEvent,
  SimulationRunId,
} from '../src/core/model/index.ts'
import { nowIso, simulationRunIdSchema } from '../src/core/model/index.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { assignToIncidentCommandKind } from '../src/packs/ambulance/commands.ts'
import { createLocalAmbulancePackRuntimeAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createLocalTrafficPackRuntimeAdapter } from '../src/packs/traffic/sim/adapter.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../src/packs/weather/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createTestScenarioCatalog, testScenarioAuthoring } from './helpers.ts'
import { osloAmbulanceScenario } from '../src/scenarios/index.ts'

const createRegistry = (dataDir: string, workspaceId: WorkspaceId = newWorkspaceId()) =>
  createSimulationRunRegistry({
    dataDir,
    workspaceId,
    scenarioCatalog: createTestScenarioCatalog(),
    ...testScenarioAuthoring(),
    runtimeAdapters: [
      createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }),
      createLocalTrafficPackRuntimeAdapter(),
      createLocalWeatherPackRuntimeAdapter(),
    ],
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
  const incident = snapshot.objects.find(object => object.kind === 'incident')
  if (!ambulance || !incident) throw new Error('Scenario missing ambulance or incident')
  const outcome = await runtime.invokeCapability(
    { id: 'actor:test-operator' as ActorId, label: 'Test Operator', role: 'operator' },
    {
      capabilityId: assignToIncidentCommandKind,
      input: { ambulanceId: ambulance.id, incidentId: incident.id },
    },
  )
  expect(outcome.kind).toBe('command')
  if (outcome.kind !== 'command') throw new Error('expected command Capability result')
  expect(outcome.result.ok).toBe(true)
}

describe('Simulation Run registry', () => {
  test('creates an opaque server-owned id and an immutable resolved manifest', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const runtime = await registry.create({ scenarioId: 'oslo-ambulance' })
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
      expect(manifest.scenario.id).toBe('oslo-ambulance')
      expect(manifest.scenario.revisionId).toMatch(/^revision-[a-f0-9]{32}$/)
      expect(manifest.scenario.digest).toMatch(/^[a-f0-9]{64}$/)
      expect(manifest.scenario.compiledDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(manifest.packs.every(pack => pack.version.length > 0)).toBe(true)
      expect(manifest.runtimes.every(adapter => adapter.version.length > 0)).toBe(true)
      expect(manifest.runtimes.map(adapter => adapter.clock).sort()).toEqual(['none', 'simulation', 'simulation'])
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
    const changed = await registry.create()
    const untouched = await registry.create()
    try {
      await issueDispatchCommand(changed)
      expect(changed.snapshot().seq).toBeGreaterThan(untouched.snapshot().seq)
      expect(untouched.snapshot().objects).toHaveLength(osloAmbulanceScenario.initialObjects.length)
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
    const first = await firstRegistry.create()
    const id = first.id
    await issueDispatchCommand(first)
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
    const before = await registry.create({ scenarioId: 'halden' })
    const id = before.id
    const manifestPath = join(simulationRunDir(dataDir, workspaceId, id), 'manifest.json')
    const manifestBefore = await readFile(manifestPath, 'utf8')
    await issueDispatchCommand(before)

    const after = await registry.reset(id)
    try {
      expect(after).not.toBe(before)
      expect(after.snapshot().scenario?.scenarioId).toBe('halden')
      expect(after.snapshot().objects.some(object => object.id === 'facility:halden-hospital')).toBe(true)
      expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
    } finally {
      await registry.close(id)
    }
  })

  test('lists unloaded runs with pinned revision metadata', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const runtime = await firstRegistry.create()
    const id = runtime.id
    const snapshotSeq = runtime.snapshot().seq
    await firstRegistry.close(id)

    const known = await createRegistry(dataDir, workspaceId).listKnown()
    expect(known).toEqual([expect.objectContaining({
      id,
      scenarioId: 'oslo-ambulance',
      scenarioRevisionId: expect.stringMatching(/^revision-/),
      createdAt: expect.any(String),
      loaded: false,
      snapshotSeq,
      objectCount: osloAmbulanceScenario.initialObjects.length,
    })])
  })

  test('deletes loaded and persisted state immediately', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const runtime = await registry.create()
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
    const runtime = await firstRegistry.create()
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

  test('lists Run resources without parsing their pinned Scenario bodies', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const runtime = await registry.create({ scenarioId: 'oslo-ambulance' })
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
      scenarioId: 'oslo-ambulance',
      scenarioTitle: 'Oslo ambulance tutorial',
    })])
  })

  test('fails visibly when pinned Pack versions are unavailable', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const runtime = await firstRegistry.create()
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
    const runtime = await firstRegistry.create()
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
    const runtime = await registry.create()
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
    const runtime = await firstRegistry.create()
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
