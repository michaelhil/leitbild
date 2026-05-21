import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, ControlInstanceId, IsoTimestamp } from '../src/core/model/index.ts'
import type { PackQueryRequest } from '../src/core/packs/protocol.ts'
import type { SimulationProviderStateStore } from '../src/simulation/protocol.ts'
import {
  createLocalProcessPlantSimulationAdapter,
  pressurizedWaterReactorPlantSpec,
  processPlantControlWriteCommandKind,
} from '../src/packs/process-plant/index.ts'

const controlInstanceId = 'control-instance:process-plant-test' as ControlInstanceId
const startsAt = '2026-01-01T09:00:00.000Z' as IsoTimestamp

const createMemoryStateStore = (): SimulationProviderStateStore => {
  let state: unknown | null = null
  return {
    load: async (): Promise<unknown | null> => state,
    save: async (nextState: unknown): Promise<void> => {
      state = nextState
    },
  }
}

const scenarioConfig = () => ({
  scenarioId: 'process-plant-test',
  providerIds: ['process-plant-local'],
  world: {
    startsAt,
    environment: {},
  },
  initialObjects: [],
  processSystems: [{
    id: 'plant',
    pack: 'process-plant',
    componentLibrary: 'process-plant',
    graph: pressurizedWaterReactorPlantSpec,
  }],
  providerConfigs: {},
  providerConfig: {},
})

const query = (kind: string, payload: unknown = {}): PackQueryRequest => ({
  packId: 'process-plant',
  kind,
  payload,
})

const command = (payload: unknown): CommandEnvelope => ({
  id: 'command:process-plant-test' as CommandId,
  controlInstanceId,
  actorId: 'actor:operator' as ActorId,
  kind: processPlantControlWriteCommandKind,
  targetObjectIds: [],
  payload,
  issuedAt: startsAt,
})

describe('process plant simulation provider', () => {
  test('runs scenario-defined process systems without operational objects', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig(),
      providerStateStore: createMemoryStateStore(),
    })

    const snapshot = await connection.getSnapshot()
    expect(snapshot.objects).toEqual([])

    const systems = await connection.query(query('process-plant.systems.list'))
    expect(systems.ok).toBe(true)
    if (!systems.ok) throw new Error(systems.reason)
    expect((systems.result as { systems: ReadonlyArray<{ readonly id: string }> }).systems.map(system => system.id)).toEqual(['plant'])

    const telemetry = await connection.query(query('process-plant.telemetry.published', { systemId: 'plant' }))
    expect(telemetry.ok).toBe(true)
    if (!telemetry.ok) throw new Error(telemetry.reason)
    expect((telemetry.result as { variables: ReadonlyArray<{ readonly path: string }> }).variables.map(variable => variable.path)).toContain('core.powerMw')

    await connection.close()
  })

  test('applies validated write commands through the runtime update loop', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig(),
      providerStateStore: createMemoryStateStore(),
    })

    const accepted = await connection.sendCommand(command({
      systemId: 'plant',
      path: 'rcpA.running',
      value: false,
    }))
    expect(accepted.ok).toBe(true)

    await Bun.sleep(1_100)

    const read = await connection.query(query('process-plant.variables.read', {
      systemId: 'plant',
      paths: ['rcpA.running', 'rcpA.flowKgPerS'],
    }))
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.reason)
    const values = new Map((read.result as { variables: ReadonlyArray<{ readonly path: string; readonly value: unknown }> }).variables.map(variable => [variable.path, variable.value]))
    expect(values.get('rcpA.running')).toBe(false)
    expect(values.get('rcpA.flowKgPerS')).toBe(0)

    await connection.close()
  })

  test('restores queued commands from provider-private state', async () => {
    const stateStore = createMemoryStateStore()
    const firstConnection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig(),
      providerStateStore: stateStore,
    })
    const accepted = await firstConnection.sendCommand(command({
      systemId: 'plant',
      path: 'rcpA.running',
      value: false,
    }))
    expect(accepted.ok).toBe(true)
    await firstConnection.close()

    const secondConnection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig(),
      providerStateStore: stateStore,
    })
    await Bun.sleep(1_100)
    const read = await secondConnection.query(query('process-plant.variables.read', {
      systemId: 'plant',
      paths: ['rcpA.running'],
    }))
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.reason)
    expect((read.result as { variables: ReadonlyArray<{ readonly value: unknown }> }).variables[0]?.value).toBe(false)

    await secondConnection.close()
  })

  test('rejects invalid process variable writes explicitly', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig(),
      providerStateStore: createMemoryStateStore(),
    })

    const rejected = await connection.sendCommand(command({
      systemId: 'plant',
      path: 'core.powerMw',
      value: 1,
    }))
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error('expected command rejection')
    expect(rejected.reason).toContain('not writable')

    await connection.close()
  })
})
