import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActorId, CommandEnvelope, CommandId, IsoTimestamp, OperationalObject, SimulationRunId } from '../src/core/model/index.ts'
import { createSimulationClock, type SimulationClock } from '../src/core/model/time.ts'
import type { PackRuntimeConnection, PackRuntimeEvent, PackRuntimeStateStore } from '../src/simulation/protocol.ts'
import { createLocalProcessPlantPackRuntimeAdapter, processPlantControlWriteCommandKind } from '../src/packs/process-plant/index.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { processPlantUnitPackDataSchema } from '../src/packs/process-plant/model.ts'
import { processPlantRuntimeStateSchema } from '../src/packs/process-plant/sim/runtime-state.ts'
import { ld01UnitArtifactEnv } from '../src/packs/process-plant/engine/artifact.ts'
import { ld01ChannelIdOf } from '../src/packs/process-plant/engine/tag-map.ts'
import { scenarios } from './fixtures/scenarios.ts'
import { topologyGraphSchema } from '../src/core/observation/topology.ts'
import { compileOperatingGraph } from '../scripts/reference-design-operating-graph'
import { elec, ic, packet, unitOf } from '../scripts/reference-design-operating-graph.fixture'

// An LD-01 Plant through the Pack's own Run path: refused at creation without a native artifact, run on the
// protocol double (tests/ld01-unit-double.ts) when an artifact names it, restored "engine unavailable" when the
// artifact is gone, and failed at its time when its child dies. Never the TS PWR in its place.
const cleanups: Array<() => Promise<void>> = []
const savedEnv = process.env[ld01UnitArtifactEnv]
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  if (savedEnv === undefined) delete process.env[ld01UnitArtifactEnv]
  else process.env[ld01UnitArtifactEnv] = savedEnv
})

const simulationRunId = 'run:ld01-shell' as SimulationRunId
const world = scenarios.find(scenario => scenario.id === 'test-plant')!.world
const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex')
const graph = {
  schemaVersion: 1, id: 'ld01.shell-test', title: 'LD-01 shell test', timestep: { fixedStepMs: 100 },
  components: [{
    id: 'PROTECTION', kind: 'nativeProtectionSystem', label: 'Reactor protection',
    parameters: {
      readings: [
        { path: 'pressure', label: 'Pressurizer pressure', kind: 'state', discipline: 'thermal', quantity: 'pressure', unit: 'MPa' },
        { path: 'tripped', label: 'Division I1 tripped', kind: 'discrete', discipline: 'control', quantity: 'boolean', unit: 'boolean' },
      ],
      commands: [{ path: 'manualReactorTrip', label: 'Manual reactor trip', actuation: 'command' }],
      keyValues: ['pressure'],
    },
    metadata: { presentation: { momentary: ['manualReactorTrip'] } },
    variables: [{ path: 'pressure', tagId: 'LD01.PZR.PRESSURE.TEST' }],
  }],
  connections: [],
  publishedVariables: ['PROTECTION.pressure', 'PROTECTION.tripped', 'PROTECTION.manualReactorTrip'],
}
const tagMap = {
  channels: { 'PROTECTION.pressure': 'LD01.PZR.PRESSURE', 'PROTECTION.tripped': 'LD01.PROT.I1.TRIP' },
  commands: { 'PROTECTION.manualReactorTrip': { kind: 'ManualReactorTrip' } },
}

/** An artifact whose binary starts the protocol double, its fixture as the joined packet. */
const artifactWith = async (fixture: Record<string, unknown>, compiled: { readonly graph: unknown; readonly tagMap: unknown; readonly automation: unknown } = { graph, tagMap, automation: {} }): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'leitbild-ld01-shell-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const files: Record<string, string> = {
    'lib/libtest.dylib': 'a library the binary would load\n',
    'bin/ld01-unit': `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, 'ld01-unit-double.ts')}'\n`,
    'packets/joined.json': JSON.stringify({
      t0: 100, frame_s: 0.1,
      channels: [
        { id: 'LD01.PZR.PRESSURE', unit: 'Pa', value: 15_000_000, rate: 1_000 },
        { id: 'LD01.PROT.I1.TRIP', unit: '1', value: 0, rate: 0, setBy: 'ManualReactorTrip' },
      ],
      ...fixture,
    }),
    'packets/ic.json': '{}', 'packets/pzr-control.json': '{}', 'packets/elec.json': '{}', 'packets/s3-state.json': '{}',
    'wiki/page.md': '# page\n',
    'ld01-graph.json': JSON.stringify({ format: 'ld01-plant-graph', sources: { packet: 'c'.repeat(64) }, scope: ['test graph'], graph: compiled.graph, tagMap: compiled.tagMap, automation: compiled.automation }),
    'artifact.json': JSON.stringify({
      format: 'ld01-unit-artifact', binary: 'bin/ld01-unit', libraries: ['lib/libtest.dylib'], graph: 'ld01-graph.json',
      load: {
        inputs: { packet: 'packets/joined.json', wiki_root: 'wiki', wiki_commit: null, wiki_repository: null, ic: 'packets/ic.json', pzr_control: 'packets/pzr-control.json', pzr_control_wiki: 'wiki', elec: 'packets/elec.json' },
        state: 'packets/s3-state.json', solver: { weights: 'declared', first_step: 'declared', stepping: 'free', water: 'if97' },
      },
    }),
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(directory, path, '..'), { recursive: true })
    await writeFile(join(directory, path), text)
  }
  await chmod(join(directory, 'bin/ld01-unit'), 0o755)
  await writeFile(join(directory, 'MANIFEST.sha256'), Object.entries(files).map(([path, text]) => `${sha256(text)}  ${path}\n`).join(''))
  return directory
}

const ld01Item = {
  pack: 'process-plant', type: 'plant', id: 'plant:ld01', label: 'LD-01', location: [10.4, 59.9],
  model: { ref: 'process-plant.ld01', parameters: {} },
  operatingPoint: { ref: 'process-plant.ld01.s3-settled' },
  automation: { ref: 'process-plant.ld01.kernel' },
}
const expand = (): OperationalObject => {
  const expanded = processPlantPack.scenario!.expandItem(ld01Item as never, { at: world.startsAt } as never)
  if (expanded instanceof Promise) throw new Error('the process-plant Pack expands a Plant synchronously')
  return expanded.objects[0]!
}

const memoryStore = (): PackRuntimeStateStore & { readonly state: () => unknown } => {
  let state: unknown | null = null
  return { load: async () => state, save: async next => { state = structuredClone(next) }, state: () => state }
}
const pausedClock = (): SimulationClock => createSimulationClock({ currentTime: world.startsAt, updatedAt: '2026-01-01T09:00:00.000Z' as IsoTimestamp, paused: true })
const advance = async (connection: PackRuntimeConnection, clock: SimulationClock, ms: number): Promise<void> => {
  const current = clock.read()
  const next = { ...current, currentTime: new Date(Date.parse(current.currentTime) + ms).toISOString() as IsoTimestamp }
  await connection.advanceTo!(next)
  clock.set(next)
}
const connect = async (object: OperationalObject, store: PackRuntimeStateStore, clock: SimulationClock): Promise<PackRuntimeConnection> => {
  const connection = await createLocalProcessPlantPackRuntimeAdapter().connect({
    simulationRunId,
    scenario: { scenarioId: 'ld01-shell', runtimeIds: ['process-plant.local'], connections: [], world, initialObjects: [object], runtimeConfig: {} } as never,
    runtimeStateStore: store,
    runClock: clock,
  })
  return connection
}
const read = async (connection: PackRuntimeConnection, path: string): Promise<unknown> => {
  const served = await connection.invokeQuery({ capabilityId: 'world.process-plant.signals.read', input: { plantId: 'plant:ld01', signals: [{ path }] } }) as { readonly signals: ReadonlyArray<{ readonly variable: { readonly value: unknown } }> }
  return served.signals[0]!.variable.value
}
const projectionOf = async (connection: PackRuntimeConnection) => {
  const projection = processPlantUnitPackDataSchema.parse((await connection.getSnapshot()).objects.find(object => String(object.id) === 'plant:ld01')!.packData).projection
  if (projection === undefined) throw new Error('the LD-01 Plant object carries no projection')
  return projection
}

describe('an LD-01 Plant in a Run', () => {
  test('is refused at creation where no native artifact is installed, as on production', () => {
    delete process.env[ld01UnitArtifactEnv]
    expect(expand).toThrow('an LD-01 Plant is refused: the LD-01 native engine is not installed here: LD01_UNIT_ARTIFACT names no artifact directory')
  })

  test('runs on its native engine, takes a kernel command, checkpoints by SNAPSHOT and resumes there', async () => {
    process.env[ld01UnitArtifactEnv] = await artifactWith({})
    const object = expand()
    const store = memoryStore()
    const clock = pausedClock()
    const first = await connect(object, store, clock)
    await advance(first, clock, 1_000)
    expect(await read(first, 'PROTECTION.pressure')).toBeCloseTo(15.0011, 12)
    const command = { id: 'command:trip' as CommandId, simulationRunId, actorId: 'actor:human:op' as ActorId, kind: processPlantControlWriteCommandKind, targetObjectIds: [], issuedAt: world.startsAt, payload: { plantId: 'plant:ld01', path: 'PROTECTION.manualReactorTrip', value: true } } satisfies CommandEnvelope
    expect(await first.sendCommand(command, { origin: 'person' })).toMatchObject({ ok: true })
    await advance(first, clock, 1_000)
    expect(await read(first, 'PROTECTION.tripped')).toBe(true)
    await first.checkpoint!()
    const saved = processPlantRuntimeStateSchema.parse(store.state())
    expect(saved.plants[0]!.runtime).toMatchObject({ engine: 'ld01-unit', snapshot: { format: 'ld01-unit-snapshot' } })
    await advance(first, clock, 1_000)
    const sourceAfter = await read(first, 'PROTECTION.pressure')
    await first.close()
    const resumed = await connect(object, store, pausedClock())
    try {
      // Close snapshotted the unit where it stood: the resumed Plant reads that frame, and its trip.
      expect(await read(resumed, 'PROTECTION.pressure')).toBe(sourceAfter)
      expect(await read(resumed, 'PROTECTION.tripped')).toBe(true)
      expect((await projectionOf(resumed)).statusLabel).not.toBe('Engine unavailable')
    } finally {
      await resumed.close()
    }
  })

  test('at maximum pace, a wall tick during a slow exchange neither rewinds nor repeats the slice (no clock-mark guard needed)', async () => {
    // Each ADVANCE takes 1.5 s of wall time, longer than the adapter's 1 s wall tick, so a tick fires while a
    // slice's exchange is in flight and before the Run clock moves. Two 1 s slices must advance the unit 2 s.
    process.env[ld01UnitArtifactEnv] = await artifactWith({ advanceDelayMs: 1_500 })
    const object = expand()
    const clock = pausedClock()
    const connection = await connect(object, memoryStore(), clock)
    try {
      await advance(connection, clock, 1_000)
      await advance(connection, clock, 1_000)
      // As after one 1 s slice (15.0011 above), two slices read 15.0021; a rewound mark would read 15.0031.
      expect(await read(connection, 'PROTECTION.pressure')).toBeCloseTo(15.0021, 12)
    } finally {
      await connection.close()
    }
  }, 20_000)

  test('restored where its artifact is gone, connects as "engine unavailable" and keeps its saved state', async () => {
    process.env[ld01UnitArtifactEnv] = await artifactWith({})
    const object = expand()
    const store = memoryStore()
    const clock = pausedClock()
    const first = await connect(object, store, clock)
    await advance(first, clock, 1_000)
    await first.close()
    const before = structuredClone(store.state())
    delete process.env[ld01UnitArtifactEnv]
    const restored = await connect(object, store, pausedClock())
    try {
      const projection = await projectionOf(restored)
      expect(projection.statusLabel).toBe('Engine unavailable')
      expect(projection.summary).toBe('LD-01 engine unavailable: the LD-01 native engine is not installed here: LD01_UNIT_ARTIFACT names no artifact directory')
      await expect(read(restored, 'PROTECTION.pressure')).rejects.toThrow('LD-01 engine unavailable')
      await restored.checkpoint!()
      expect(store.state()).toEqual(before)
    } finally {
      await restored.close()
    }
  })

  test('whose child dies fails at its time: it shows the cause, keeps its last state, and nothing restarts it', async () => {
    process.env[ld01UnitArtifactEnv] = await artifactWith({ dieAtS: 101.5 })
    const object = expand()
    const store = memoryStore()
    const clock = pausedClock()
    const connection = await connect(object, store, clock)
    const events: PackRuntimeEvent[] = []
    connection.subscribe(event => { if (event.type === 'event.emission') events.push(...event.events) })
    try {
      await advance(connection, clock, 1_000)
      await connection.checkpoint!()
      const saved = structuredClone(processPlantRuntimeStateSchema.parse(store.state()).plants[0]!.runtime)
      await advance(connection, clock, 1_000)
      const failed = events.find(event => event.type === 'interaction.signal' && event.signal.type === 'process-plant.engine.failed')
      expect(failed?.type === 'interaction.signal' && String((failed.signal.payload as { message: string }).message)).toMatch(/^LD-01 engine failed at t=1\.100 s: ld01-unit \(pid \d+\) was killed by SIGKILL/u)
      expect((await projectionOf(connection)).statusLabel).toBe('Engine unavailable')
      await expect(read(connection, 'PROTECTION.pressure')).rejects.toThrow('LD-01 engine failed at t=1.100 s')
      await advance(connection, clock, 1_000)
      await connection.checkpoint!()
      expect(processPlantRuntimeStateSchema.parse(store.state()).plants[0]!.runtime).toEqual(saved)
    } finally {
      await connection.close()
    }
  })

  test('on its compiled graph, serves the generated displays: declarations, topology and reads of the unit\'s frame', async () => {
    const compiled = compileOperatingGraph({ packet, ic, elec, sha8: 'abcdef12' })
    const channels = [...new Set(Object.values(compiled.tagMap.channels).map(ld01ChannelIdOf))].map(id => unitOf(id) === '1'
      ? { id, unit: '1', value: 1, rate: 0 }
      : { id, unit: unitOf(id), value: 15_000_000, rate: 1_000 })
    process.env[ld01UnitArtifactEnv] = await artifactWith({ channels }, compiled)
    const object = expand()
    const clock = pausedClock()
    const connection = await connect(object, memoryStore(), clock)
    try {
      await advance(connection, clock, 1_000)
      const declarations = await connection.invokeQuery({ capabilityId: 'world.process-plant.observation.declarations', input: { objectIds: ['plant:ld01'] } }) as { readonly declarations: ReadonlyArray<{ readonly observables: ReadonlyArray<{ readonly ref: string; readonly tag?: string }> }> }
      const observables = declarations.declarations[0]!.observables
      expect(observables.find(entry => entry.ref === 'plant:ld01#PZR.PT1')?.tag).toBe('LD01.PZR.PT1')
      const topology = await connection.invokeQuery({ capabilityId: 'world.process-plant.observation.topology', input: { objectId: 'plant:ld01' } }) as { readonly nodes: ReadonlyArray<{ readonly id: string; readonly class: string; readonly group?: string }>; readonly groups: ReadonlyArray<{ readonly id: string }> }
      // World core's own topology contract holds (node bindings, ports, media within its bounds).
      topologyGraphSchema.parse(topology)
      expect(topology.groups.map(group => group.id)).toEqual(['A', 'B'])
      expect(topology.nodes.find(node => node.id === 'FW.FCV.A')).toMatchObject({ class: 'switch', group: 'A' })
      expect(topology.nodes.find(node => node.id === 'CORE')?.class).toBe('source')
      expect(topology.nodes.find(node => node.id === 'SG.A.PRIMARY')).toMatchObject({ class: 'transfer', group: 'A' })
      expect(topology.nodes.find(node => node.id === 'PUMP.B1')).toMatchObject({ class: 'mover', group: 'B' })
      const read = await connection.invokeQuery({ capabilityId: 'world.process-plant.observation.read', input: { refs: ['plant:ld01#PZR.PT1', 'plant:ld01#PUMP.A1.speed'] } }) as { readonly observations: ReadonlyArray<{ readonly ref: string; readonly value: unknown }> }
      expect(read.observations.find(entry => entry.ref === 'plant:ld01#PZR.PT1')?.value).toBeCloseTo(15.0011, 9)
      expect(read.observations.find(entry => entry.ref === 'plant:ld01#PUMP.A1.speed')?.value).toBeCloseTo(15_001_100 * 60 / (2 * Math.PI), 3)
      // The kernel's latches (every '1' channel of this double reads 1: each function latched in one division) annunciate.
      const alarms = await connection.invokeQuery({ capabilityId: 'world.process-plant.alarms.status', input: { plantId: 'plant:ld01' } }) as { readonly trips: ReadonlyArray<{ readonly ruleId: string; readonly active: boolean }>; readonly alarms: ReadonlyArray<{ readonly ruleId: string; readonly active: boolean }> }
      expect(alarms.trips.find(trip => trip.ruleId === 'LD01.PROT.PZR.HIGH_PRESSURE')?.active).toBe(true)
    } finally {
      await connection.close()
    }
  })
})
