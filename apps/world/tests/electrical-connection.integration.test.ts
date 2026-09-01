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
import { scenarios } from '../src/scenarios/index.ts'
import { builtinScenarioSources } from '../src/scenarios/index.ts'
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
    const source = builtinScenarioSources.find(candidate => candidate.id === 'halden-four-unit-grid')
    if (!source) throw new Error('missing Halden four-unit Scenario source')
    const badPort = structuredClone(source)
    badPort.connections[0]!.network.portId = 'missing-port'
    await expect(compileScenarioSource(badPort, [processPlantPack, electricGridPack], { routing: createDirectRoutingAdapter() }))
      .rejects.toThrow('unknown network port')

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
    const scenario = scenarios.find(candidate => candidate.id === 'halden-four-unit-grid')
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

      const beforeQuery = await connection.query({
        packId: 'electric-grid',
        kind: 'electric-grid.connection-points.list',
        payload: { gridId: 'grid:halden-four-unit' },
      })
      if (!beforeQuery.ok) throw new Error(beforeQuery.reason)
      const beforePoints = (beforeQuery.result as { connectionPoints: ReadonlyArray<{ connected: boolean; systemActivePowerMw: number }> }).connectionPoints
      expect(beforePoints).toHaveLength(4)
      expect(beforePoints.every(point => point.connected && point.systemActivePowerMw > 800)).toBe(true)
      const summaryBefore = await connection.query({ packId: 'electric-grid', kind: 'electric-grid.grid.summary', payload: { gridId: 'grid:halden-four-unit' } })
      if (!summaryBefore.ok) throw new Error(summaryBefore.reason)
      const projectionBefore = (summaryBefore.result as { projection: { activeAlarmCount: number; frequencyHz: number; highestBranchLoadingPercent: number; totalGenerationMw: number } }).projection
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
      const afterQuery = await connection.query({
        packId: 'electric-grid',
        kind: 'electric-grid.connection-points.list',
        payload: { gridId: 'grid:halden-four-unit' },
      })
      if (!afterQuery.ok) throw new Error(afterQuery.reason)
      const afterPoints = (afterQuery.result as { connectionPoints: ReadonlyArray<{ system: { objectId: string }; systemActivePowerMw: number }> }).connectionPoints
      expect(afterPoints.find(point => point.system.objectId === 'plant:halden-1')?.systemActivePowerMw).toBeLessThan(beforePoints[0]!.systemActivePowerMw * 0.45)
      const summaryAfter = await connection.query({ packId: 'electric-grid', kind: 'electric-grid.grid.summary', payload: { gridId: 'grid:halden-four-unit' } })
      if (!summaryAfter.ok) throw new Error(summaryAfter.reason)
      const projectionAfter = (summaryAfter.result as { projection: { frequencyHz: number; totalGenerationMw: number } }).projection
      expect(projectionAfter.frequencyHz).toBeLessThan(projectionBefore.frequencyHz - 0.1)
      expect(projectionAfter.totalGenerationMw).toBeLessThan(projectionBefore.totalGenerationMw)
    } finally {
      unsubscribe()
      await connection.close()
    }
  }, 20_000)
})
