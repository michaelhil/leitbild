import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, ControlInstanceId, ObjectId } from '../src/core/model/index.ts'
import { nowIso } from '../src/core/model/index.ts'
import { createScenarioCatalog } from '../src/core/scenarios/catalog.ts'
import { gridDerateBranchCommandKind, gridTripGeneratorCommandKind } from '../src/packs/electric-grid/commands.ts'
import { electricGridPackDataSchema, type ElectricGridPackData, type GridBranchData, type GridGeneratorData, type GridSystemData } from '../src/packs/electric-grid/model.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../src/packs/electric-grid/sim/adapter.ts'
import { electricGridRuntimeId } from '../src/packs/electric-grid/sim/constants.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { scenarios } from '../src/scenarios/index.ts'

const controlInstanceId = 'control-instance:electric-grid-test' as ControlInstanceId
const actorId = 'actor:electric-grid-test' as ActorId

const command = (config: {
  readonly kind: string
  readonly targetObjectIds: ReadonlyArray<ObjectId>
  readonly payload: unknown
}): CommandEnvelope => ({
  id: `command:${crypto.randomUUID()}` as CommandId,
  controlInstanceId,
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
      runtimeConfig: {},
    })
    expect(electricGridPack.mapLayerGroups).toContainEqual({
      id: 'electric-grid:branches',
      label: 'Simulated grid lines',
      defaultVisible: true,
      layerIdPattern: 'operational:grid:*',
    })
    expect(electricGridPack.mapLayerGroups?.map(group => group.id)).toContain('electric-grid:reference-lines')
    expect(gridObjects.length).toBeGreaterThanOrEqual(20)
    expect(gridObjects.some(object => {
      const parsed = electricGridPackDataSchema.safeParse(object.packData)
      return parsed.success && parsed.data.type === 'grid_branch' && parsed.data.branchKind === 'hvdc_link'
    })).toBe(true)
    expect(gridObjects.some(object => {
      const parsed = electricGridPackDataSchema.safeParse(object.packData)
      return parsed.success && parsed.data.type === 'grid_load' && parsed.data.loadKind === 'ev_charging'
    })).toBe(true)
  })

  test('solves frequency, voltage, branches, and consumer service on connect', async () => {
    const scenario = gridScenario()
    const connection = await createLocalElectricGridPackRuntimeAdapter().connect({
      controlInstanceId,
      scenario: {
        scenarioId: scenario.id,
        runtimeIds: [electricGridRuntimeId],
        world: scenario.world,
        initialObjects: scenario.initialObjects,
        runtimeConfigs: {},
        runtimeConfig: {},
      },
    })

    try {
      const snapshot = await connection.getSnapshot()
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
      expect(system.lowestVoltagePu).toBeGreaterThan(0.88)
    } finally {
      await connection.close()
    }
  })

  test('accepts operational commands and exposes query snapshots', async () => {
    const scenario = gridScenario()
    const connection = await createLocalElectricGridPackRuntimeAdapter().connect({
      controlInstanceId,
      scenario: {
        scenarioId: scenario.id,
        runtimeIds: [electricGridRuntimeId],
        world: scenario.world,
        initialObjects: scenario.initialObjects,
        runtimeConfigs: {},
        runtimeConfig: {},
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
})
