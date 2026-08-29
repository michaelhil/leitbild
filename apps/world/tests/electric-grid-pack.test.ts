import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, SimulationRunId, IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { nowIso } from '../src/core/model/index.ts'
import { createScenarioCatalog } from '../src/core/scenarios/catalog.ts'
import { gridDerateBranchCommandKind, gridTripGeneratorCommandKind } from '../src/packs/electric-grid/commands.ts'
import { electricGridPackDataSchema, type ElectricGridPackData, type GridBranchData, type GridGeneratorData, type GridLoadData, type GridSystemData } from '../src/packs/electric-grid/model.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { norwayGridArenaTopology } from '../src/packs/electric-grid/arena/norway-grid-arena.ts'
import { solveGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../src/packs/electric-grid/sim/adapter.ts'
import { electricGridRuntimeId } from '../src/packs/electric-grid/sim/constants.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { scenarios } from '../src/scenarios/index.ts'
import type { PackRuntimeEvent } from '../src/simulation/protocol.ts'

const simulationRunId = 'run-electric-grid-test' as SimulationRunId
const actorId = 'actor:electric-grid-test' as ActorId
const sourceDerivedTopologyRuntimeConfig = {
  topology: {
    kind: 'built-in',
    arenaId: 'source-derived-norway-grid',
  },
} as const

const command = (config: {
  readonly kind: string
  readonly targetObjectIds: ReadonlyArray<ObjectId>
  readonly payload: unknown
}): CommandEnvelope => ({
  id: `command:${crypto.randomUUID()}` as CommandId,
  simulationRunId,
  actorId,
  kind: config.kind,
  targetObjectIds: config.targetObjectIds,
  payload: config.payload,
  issuedAt: nowIso(),
})

const gridScenario = () => {
  const scenario = scenarios.find(candidate => candidate.id === 'norway-electric-grid')
  if (!scenario) throw new Error('missing built-in norway-electric-grid scenario')
  return scenario
}

const parsedPackData = <T extends ElectricGridPackData['type']>(
  object: { readonly packData?: unknown },
  type: T,
): Extract<ElectricGridPackData, { readonly type: T }> => {
  const data = electricGridPackDataSchema.parse(object.packData)
  if (data.type !== type) throw new Error(`expected ${type}, got ${data.type}`)
  return data as Extract<ElectricGridPackData, { readonly type: T }>
}

describe('electric grid pack', () => {
  test('loads the built-in Norway grid scenario as a real electric-grid runtime', () => {
    const scenario = gridScenario()
    const catalog = createScenarioCatalog({
      packs: [electricGridPack, weatherPack],
      scenarios: [scenario],
      defaultScenarioId: scenario.id,
    })
    const runtime = catalog.runtimeFor(scenario.id)
    const gridObjects = scenario.initialObjects.filter(object => object.packId === 'electric-grid')

    expect(runtime?.runtimes).toContainEqual({
      packId: 'electric-grid',
      runtimeId: electricGridRuntimeId,
      runtimeConfig: sourceDerivedTopologyRuntimeConfig,
    })
    expect(electricGridPack.presentation.mapLayerGroups?.map(group => group.id)).not.toContain('electric-grid:branches')
    expect(electricGridPack.presentation.mapLayerGroups?.map(group => group.id)).toContain('electric-grid:reference-lines')
    expect(scenario.surface.regions.find(region => region.primitive === 'map')?.config.layers).toContain('grid')
    expect(gridObjects.length).toBeGreaterThanOrEqual(250)
    expect(gridObjects.some(object => {
      const parsed = electricGridPackDataSchema.safeParse(object.packData)
      return parsed.success && parsed.data.type === 'grid_branch' && parsed.data.provenance.sourceId === 'osm:pbf-power:NO'
    })).toBe(true)
    expect(gridObjects.every(object => {
      const parsed = electricGridPackDataSchema.safeParse(object.packData)
      return !parsed.success || parsed.data.type !== 'grid_branch' || object.spatial.geometry === undefined
    })).toBe(true)
    expect(gridObjects.some(object => object.provenance.externalId?.includes('leitbild-demo-grid-v1') === true)).toBe(false)
    expect(gridObjects.some(object => {
      const parsed = electricGridPackDataSchema.safeParse(object.packData)
      return parsed.success && parsed.data.type === 'grid_load' && parsed.data.loadKind === 'ev_charging'
    })).toBe(true)
    expect(gridObjects.some(object => {
      const parsed = electricGridPackDataSchema.safeParse(object.packData)
      return parsed.success &&
        parsed.data.type === 'grid_generator' &&
        parsed.data.provenance.sourceId.startsWith('nve:vannkraftdatabase:') &&
        parsed.data.annualProductionGwh !== undefined &&
        parsed.data.operator !== undefined &&
        parsed.data.priceArea?.startsWith('NO') === true
    })).toBe(true)
  })

  test('solves frequency, voltage, branches, and consumer service on connect', async () => {
    const scenario = gridScenario()
    const connection = await createLocalElectricGridPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: {
        scenarioId: scenario.id,
        runtimeIds: [electricGridRuntimeId],
        world: scenario.world,
        initialObjects: scenario.initialObjects,
        runtimeConfigs: {},
        runtimeConfig: sourceDerivedTopologyRuntimeConfig,
      },
    })

    try {
      const snapshot = await connection.getSnapshot()
      if (!scenario.world.startsAt) throw new Error('grid scenario must declare a deterministic start time')
      const systemObject = snapshot.objects.find(object => object.id === 'grid:norway-system')
      if (!systemObject) throw new Error('missing grid system object')
      const system = parsedPackData(systemObject, 'grid_system') as GridSystemData
      const branches = snapshot.objects
        .map(object => electricGridPackDataSchema.parse(object.packData))
        .filter(data => data.type === 'grid_branch') as ReadonlyArray<GridBranchData>

      expect(system.tick).toBeGreaterThanOrEqual(1)
      expect(system.frequencyHz).toBeGreaterThan(48.4)
      expect(system.frequencyHz).toBeLessThan(50.6)
      expect(system.busStates.length).toBeGreaterThanOrEqual(5)
      expect(system.totalGenerationMw).toBeGreaterThan(0)
      expect(system.servedLoadMw).toBeGreaterThan(0)
      expect(branches.some(branch => Math.abs(branch.flowMw) > 0)).toBe(true)
      expect(system.updatedAt).toBe(scenario.world.startsAt)
      expect(system.lowestVoltagePu).toBeGreaterThan(0.98)
      expect(system.activeIslandCount).toBeGreaterThanOrEqual(1)
      expect(system.activeAlarmCount).toBe(0)
    } finally {
      await connection.close()
    }
  })

  test('applies deterministic operating demand profiles without drifting load baselines', () => {
    const scenario = gridScenario()
    const topology = norwayGridArenaTopology()
    const first = solveGrid({
      objects: scenario.initialObjects,
      runtimeState: null,
      topology,
      dtSeconds: 1,
      at: '2026-01-01T10:00:00.000Z' as IsoTimestamp,
    })
    const second = solveGrid({
      objects: first.objects,
      runtimeState: first.runtimeState,
      topology,
      dtSeconds: 90,
      at: '2026-01-01T10:01:30.000Z' as IsoTimestamp,
    })
    const firstLoad = first.objects
      .flatMap(object => {
        const parsed = electricGridPackDataSchema.safeParse(object.packData)
        return parsed.success ? [parsed.data] : []
      })
      .find(data => data.type === 'grid_load') as GridLoadData | undefined
    const secondLoad = second.objects
      .flatMap(object => {
        const parsed = electricGridPackDataSchema.safeParse(object.packData)
        return parsed.success ? [parsed.data] : []
      })
      .find(data => data.type === 'grid_load') as GridLoadData | undefined

    expect(firstLoad?.nominalDemandMw).toBeGreaterThan(0)
    expect(secondLoad?.nominalDemandMw).toBe(firstLoad?.nominalDemandMw)
    expect(Math.abs(second.summary.totalLoadMw - first.summary.totalLoadMw)).toBeGreaterThan(1)
  })

  test('accepts operational commands and exposes query snapshots', async () => {
    const scenario = gridScenario()
    const connection = await createLocalElectricGridPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: {
        scenarioId: scenario.id,
        runtimeIds: [electricGridRuntimeId],
        world: scenario.world,
        initialObjects: scenario.initialObjects,
        runtimeConfigs: {},
        runtimeConfig: sourceDerivedTopologyRuntimeConfig,
      },
    })

    try {
      const initial = await connection.getSnapshot()
      const generator = initial.objects.find(object => {
        const parsed = electricGridPackDataSchema.safeParse(object.packData)
        return parsed.success && parsed.data.type === 'grid_generator'
      })
      const branch = initial.objects.find(object => {
        const parsed = electricGridPackDataSchema.safeParse(object.packData)
        return parsed.success && parsed.data.type === 'grid_branch'
      })
      if (!generator || !branch) throw new Error('missing command targets')

      const trip = await connection.sendCommand(command({
        kind: gridTripGeneratorCommandKind,
        targetObjectIds: [generator.id],
        payload: {},
      }))
      const derate = await connection.sendCommand(command({
        kind: gridDerateBranchCommandKind,
        targetObjectIds: [branch.id],
        payload: { availability: 0.6 },
      }))
      const snapshot = await connection.getSnapshot()
      const nextGenerator = snapshot.objects.find(object => object.id === generator.id)
      const nextBranch = snapshot.objects.find(object => object.id === branch.id)
      if (!nextGenerator || !nextBranch) throw new Error('missing updated targets')
      const generatorData = parsedPackData(nextGenerator, 'grid_generator') as GridGeneratorData
      const branchData = parsedPackData(nextBranch, 'grid_branch') as GridBranchData
      const summary = await connection.query({
        packId: 'electric-grid',
        kind: 'electric-grid.network.summary',
        payload: {},
      })

      expect(trip.ok).toBe(true)
      expect(derate.ok).toBe(true)
      expect(generatorData.state).toBe('tripped')
      expect(generatorData.dispatchMw).toBe(0)
      expect(branchData.state).toBe('derated')
      expect(branchData.availability).toBe(0.6)
      expect(summary.ok).toBe(true)
      if (summary.ok) {
        expect(summary.result).toMatchObject({
          assetCounts: {
            branch: expect.any(Number),
            generator: expect.any(Number),
            load: expect.any(Number),
          },
        })
      }
    } finally {
      await connection.close()
    }
  })

  test('keeps solver projections projected while persisting command mutations', async () => {
    const scenario = gridScenario()
    const connection = await createLocalElectricGridPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: {
        scenarioId: scenario.id,
        runtimeIds: [electricGridRuntimeId],
        world: scenario.world,
        initialObjects: scenario.initialObjects,
        runtimeConfigs: {},
        runtimeConfig: sourceDerivedTopologyRuntimeConfig,
      },
    })

    try {
      const emitted: ReadonlyArray<PackRuntimeEvent>[] = []
      const unsubscribe = connection.subscribe(emission => {
        emitted.push(emission.events)
      })
      const snapshot = await connection.getSnapshot()
      const generator = snapshot.objects.find(object => {
        const parsed = electricGridPackDataSchema.safeParse(object.packData)
        return parsed.success && parsed.data.type === 'grid_generator'
      })
      if (!generator) throw new Error('missing command target')

      const trip = await connection.sendCommand(command({
        kind: gridTripGeneratorCommandKind,
        targetObjectIds: [generator.id],
        payload: {},
      }))
      unsubscribe()

      expect(trip.ok).toBe(true)
      const objectEvents = emitted.flat().filter(event => event.type === 'object.upserted')
      expect(objectEvents.some(event => event.persistence === 'durable')).toBe(true)
      expect(objectEvents.some(event => event.persistence === 'projected')).toBe(true)
    } finally {
      await connection.close()
    }
  })

  test('coalesces steady-state projected emissions after the initial catch-up', async () => {
    const scenario = gridScenario()
    const gridObjectCount = scenario.initialObjects.filter(object => object.packId === 'electric-grid').length
    const connection = await createLocalElectricGridPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: {
        scenarioId: scenario.id,
        runtimeIds: [electricGridRuntimeId],
        world: scenario.world,
        initialObjects: scenario.initialObjects,
        runtimeConfigs: {},
        runtimeConfig: sourceDerivedTopologyRuntimeConfig,
      },
    })

    try {
      const emitted: number[] = []
      const unsubscribe = connection.subscribe(emission => {
        emitted.push(emission.events.length)
      })
      await Bun.sleep(4_500)
      unsubscribe()

      expect(emitted.length).toBeGreaterThanOrEqual(2)
      expect(emitted[0]).toBeLessThan(gridObjectCount)
      const lastEmissionCount = emitted.at(-1)
      if (lastEmissionCount === undefined) throw new Error('missing projected grid emission')
      expect(lastEmissionCount).toBeLessThan(40)
    } finally {
      await connection.close()
    }
  })
})
