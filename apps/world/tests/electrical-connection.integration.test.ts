import { describe, expect, test } from 'bun:test'
import {
  electricalPortFromObject,
  nowIso,
  type ActorId,
  type CommandId,
  type EventId,
  type ObjectId,
  type SimulationRunEvent,
  type SimulationRunId,
} from '../src/core/model/index.ts'
import { scenarios } from './fixtures/scenarios.ts'
import { testScenarioSources } from './fixtures/scenarios.ts'
import { compileScenarioSource } from '../src/core/scenarios/config.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../src/packs/electric-grid/sim/adapter.ts'
import { electricGridRuntimeId } from '../src/packs/electric-grid/sim/constants.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from '../src/packs/process-plant/sim/adapter.ts'
import { processPlantSimRuntimeId } from '../src/packs/process-plant/sim/constants.ts'
import { processPlantActionInvokeCommandKind } from '../src/packs/process-plant/commands.ts'
import { createRuntimeHub } from '../src/simulation/runtime-hub.ts'

const simulationRunId = 'run:halden-four-unit-integration' as SimulationRunId

describe('electrical Pack connection', () => {
  test('rejects unresolved and multiply connected electrical ports at Scenario compilation', async () => {
    const source = testScenarioSources.find(candidate => candidate.id === 'halden-power-complex')
    if (!source) throw new Error('missing Halden four-unit Scenario source')
    const badPort = structuredClone(source)
    badPort.connections[0]!.network.portId = 'missing-port'
    await expect(compileScenarioSource(badPort, [processPlantPack, electricGridPack], { routing: createDirectRoutingAdapter() }))
      .rejects.toThrow('unknown network port')

    const reversedRoles = structuredClone(source)
    const original = reversedRoles.connections[0]!
    reversedRoles.connections[0] = { ...original, system: original.network, network: original.system }
    await expect(compileScenarioSource(reversedRoles, [processPlantPack, electricGridPack], { routing: createDirectRoutingAdapter() }))
      .rejects.toThrow('system endpoint is not a system port')

    const duplicated = structuredClone(source)
    duplicated.connections[1]!.system = { ...duplicated.connections[0]!.system }
    await expect(compileScenarioSource(duplicated, [processPlantPack, electricGridPack], { routing: createDirectRoutingAdapter() }))
      .rejects.toThrow('electrical port is connected more than once')

    const laterDeletion = structuredClone(source)
    laterDeletion.timeline = { cues: [{
      id: 'remove-connected-plant',
      at: { kind: 'after_scenario_start', seconds: 60 },
      actions: [{ type: 'delete_object', objectId: 'plant:halden-1' as ObjectId }],
    }] }
    const compiled = await compileScenarioSource(laterDeletion, [processPlantPack, electricGridPack], { routing: createDirectRoutingAdapter() })
    expect(compiled.connections.map(connection => connection.id)).toContain('halden-unit-1-grid')
  })

  test('couples four independent Plants to Grid flow and frequency without duplicate generators', async () => {
    const scenario = scenarios.find(candidate => candidate.id === 'halden-power-complex')
    if (!scenario) throw new Error('missing Halden four-unit scenario')
    const connection = await createRuntimeHub([
      createLocalProcessPlantPackRuntimeAdapter(),
      createLocalElectricGridPackRuntimeAdapter(),
    ]).connect({
      simulationRunId,
      scenario: {
        scenarioId: scenario.id,
        runtimeIds: [processPlantSimRuntimeId, electricGridRuntimeId],
        connections: scenario.connections,
        world: scenario.world,
        initialObjects: scenario.initialObjects,
        runtimeConfigByRuntimeId: {},
        runtimeConfig: {},
      },
    })
    let sequence = 0
    let committed = Promise.resolve()
    const unsubscribe = connection.subscribe(emission => {
      const events: SimulationRunEvent[] = emission.events.flatMap(event => {
        if (event.type !== 'object.upserted' && event.type !== 'object.deleted') return []
        sequence += 1
        return [{
          ...event,
          id: `event:electrical-integration:${sequence}` as EventId,
          simulationRunId,
          seq: sequence,
        } as SimulationRunEvent]
      })
      committed = committed.then(() => connection.observeCommittedEvents(events))
    })
    try {
      await Bun.sleep(3_200)
      await committed
      const before = await connection.getSnapshot()
      const gridBefore = before.objects.find(object => object.id === 'grid:halden-four-unit' as ObjectId)
      const plantBefore = before.objects.find(object => object.id === 'plant:halden-1' as ObjectId)
      if (!gridBefore || !plantBefore) throw new Error('connected runtime snapshot is incomplete')
      const plantPortBefore = electricalPortFromObject(plantBefore, 'grid-420kv')
      const gridPortBefore = electricalPortFromObject(gridBefore, 'unit-1-420kv')
      expect(plantPortBefore?.state?.connected).toBe(true)
      expect(plantPortBefore?.state?.activePowerMw).toBeGreaterThan(800)
      expect(gridPortBefore?.state?.activePowerMw).toBeLessThan(-800)

      const beforeQuery = await connection.invokeQuery({
        capabilityId: 'world.electric-grid.connection-points.list',
        input: { gridId: 'grid:halden-four-unit' },
      })
      const beforePoints = (beforeQuery as { connectionPoints: ReadonlyArray<{ connected: boolean; systemActivePowerMw: number }> }).connectionPoints
      expect(beforePoints).toHaveLength(4)
      expect(beforePoints.every(point => point.connected && point.systemActivePowerMw > 800)).toBe(true)
      const summaryBefore = await connection.invokeQuery({ capabilityId: 'world.electric-grid.grid.summary', input: { gridId: 'grid:halden-four-unit' } })
      const projectionBefore = (summaryBefore as { projection: { activeAlarmCount: number; frequencyHz: number; highestBranchLoadingPercent: number; totalGenerationMw: number } }).projection
      expect(projectionBefore.activeAlarmCount).toBe(0)
      expect(projectionBefore.highestBranchLoadingPercent).toBeLessThan(85)

      const trip = await connection.sendCommand({
        id: 'command:trip-halden-unit-1' as CommandId,
        simulationRunId,
        actorId: 'actor:integration-test' as ActorId,
        kind: processPlantActionInvokeCommandKind,
        targetObjectIds: ['plant:halden-1' as ObjectId],
        payload: { plantId: 'plant:halden-1', actionId: 'turbine-trip', parameters: {} },
        issuedAt: nowIso(),
      })
      expect(trip.ok).toBe(true)
      await Bun.sleep(8_500)
      await committed
      const after = await connection.getSnapshot()
      const plantAfter = after.objects.find(object => object.id === 'plant:halden-1' as ObjectId)
      if (!plantAfter) throw new Error('tripped Plant disappeared')
      expect(electricalPortFromObject(plantAfter, 'grid-420kv')?.state?.activePowerMw).toBeLessThan(plantPortBefore!.state!.activePowerMw * 0.45)
      const afterQuery = await connection.invokeQuery({
        capabilityId: 'world.electric-grid.connection-points.list',
        input: { gridId: 'grid:halden-four-unit' },
      })
      const afterPoints = (afterQuery as { connectionPoints: ReadonlyArray<{ system: { objectId: string }; systemActivePowerMw: number }> }).connectionPoints
      expect(afterPoints.find(point => point.system.objectId === 'plant:halden-1')?.systemActivePowerMw).toBeLessThan(beforePoints[0]!.systemActivePowerMw * 0.45)
      const summaryAfter = await connection.invokeQuery({ capabilityId: 'world.electric-grid.grid.summary', input: { gridId: 'grid:halden-four-unit' } })
      const projectionAfter = (summaryAfter as { projection: { frequencyHz: number; totalGenerationMw: number } }).projection
      expect(projectionAfter.frequencyHz).toBeLessThan(projectionBefore.frequencyHz - 0.1)
      expect(projectionAfter.totalGenerationMw).toBeLessThan(projectionBefore.totalGenerationMw)
    } finally {
      unsubscribe()
      await connection.close()
    }
  }, 20_000)

  test('removes a Plant runtime and its Grid exchange immediately on committed deletion', async () => {
    const scenario = scenarios.find(candidate => candidate.id === 'halden-power-complex')
    if (!scenario) throw new Error('missing Halden four-unit scenario')
    const connection = await createRuntimeHub([
      createLocalProcessPlantPackRuntimeAdapter(),
      createLocalElectricGridPackRuntimeAdapter(),
    ]).connect({
      simulationRunId,
      scenario: {
        scenarioId: scenario.id,
        runtimeIds: [processPlantSimRuntimeId, electricGridRuntimeId],
        connections: scenario.connections,
        world: scenario.world,
        initialObjects: scenario.initialObjects,
        runtimeConfigByRuntimeId: {},
        runtimeConfig: {},
      },
    })
    try {
      const before = await connection.invokeQuery({
        capabilityId: 'world.electric-grid.connection-points.list',
        input: { gridId: 'grid:halden-four-unit' },
      })
      const beforePoints = (before as { connectionPoints: ReadonlyArray<{ connected: boolean; systemActivePowerMw: number }> }).connectionPoints
      expect(beforePoints).toHaveLength(4)
      expect(beforePoints.every(point => point.connected && point.systemActivePowerMw > 800)).toBe(true)

      const deletedAt = nowIso()
      await connection.observeCommittedEvents([{
        id: 'event:delete-halden-unit-1' as EventId,
        simulationRunId,
        seq: 1,
        at: deletedAt,
        provenance: { source: 'operator' },
        type: 'object.deleted',
        objectId: 'plant:halden-1' as ObjectId,
      }])

      const plants = await connection.invokeQuery({
        capabilityId: 'world.process-plant.plants.list',
        input: {},
      })
      expect((plants as { plants: ReadonlyArray<{ id: string }> }).plants.map(plant => plant.id))
        .toEqual(['plant:halden-2', 'plant:halden-3', 'plant:halden-4'])

      const after = await connection.invokeQuery({
        capabilityId: 'world.electric-grid.connection-points.list',
        input: { gridId: 'grid:halden-four-unit' },
      })
      const afterPoints = (after as { connectionPoints: ReadonlyArray<{ id: string; connected: boolean; systemActivePowerMw: number }> }).connectionPoints
      expect(afterPoints.find(point => point.id === 'unit-1-420kv')).toMatchObject({ connected: false, systemActivePowerMw: 0 })
      expect(afterPoints.filter(point => point.connected)).toHaveLength(3)

      const snapshot = await connection.getSnapshot()
      const grid = snapshot.objects.find(object => object.id === 'grid:halden-four-unit' as ObjectId)
      if (!grid) throw new Error('Grid disappeared after connected Plant deletion')
      expect(electricalPortFromObject(grid, 'unit-1-420kv')?.state).toMatchObject({ connected: false, activePowerMw: 0 })

      const switchyard = await connection.invokeQuery({
        capabilityId: 'world.electric-grid.asset.get',
        input: { gridId: 'grid:halden-four-unit', assetId: 'bus:halden-pwr-switchyard-420' },
      })
      expect(switchyard).toMatchObject({
        asset: {
          status: { tone: 'working', label: '3/4 connected' },
          summary: expect.stringMatching(/MW supplied · 3\/4 connected/),
        },
      })
    } finally {
      await connection.close()
    }
  })
})
