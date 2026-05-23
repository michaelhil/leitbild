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

const scenarioConfig = (processPlantConfig: unknown = {}) => ({
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
  providerConfigs: {
    'process-plant': processPlantConfig,
  },
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

  test('resolves process signal tags and accepts tag-addressed writes', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig(),
      providerStateStore: createMemoryStateStore(),
    })

    const resolved = await connection.query(query('process-plant.signals.resolve', {
      systemId: 'plant',
      signals: [{ tagId: 'RCP-A-RUN' }, { tagId: 'PT-455' }],
    }))
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error(resolved.reason)
    expect((resolved.result as { signals: ReadonlyArray<{ readonly path: string }> }).signals.map(signal => signal.path)).toEqual([
      'rcpA.running',
      'pressurizer.pressureMPa',
    ])
    expect((resolved.result as { signals: ReadonlyArray<{ readonly capabilities: { readonly writable: boolean; readonly procedureRelevant: boolean } }> }).signals[0]?.capabilities).toMatchObject({
      writable: true,
      procedureRelevant: true,
    })

    const accepted = await connection.sendCommand(command({
      systemId: 'plant',
      tagId: 'RCP-A-RUN',
      value: false,
    }))
    expect(accepted.ok).toBe(true)

    await Bun.sleep(1_100)

    const read = await connection.query(query('process-plant.signals.read', {
      systemId: 'plant',
      signals: [{ tagId: 'RCP-A-RUN' }],
    }))
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.reason)
    expect((read.result as { signals: ReadonlyArray<{ readonly variable: { readonly value: unknown } }> }).signals[0]?.variable.value).toBe(false)

    await connection.close()
  })

  test('rejects command writes outside declared hard ranges', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig(),
      providerStateStore: createMemoryStateStore(),
    })

    const rejected = await connection.sendCommand(command({
      systemId: 'plant',
      tagId: 'PZR-HTR',
      value: 50,
    }))
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error('expected command rejection')
    expect(rejected.reason).toContain('outside hard range 0..30')

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

  test('applies pack-owned scheduled actions and exposes configured telemetry trends', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            telemetry: {
              sampleIntervalMs: 1_000,
              variables: ['rcpA.running', 'turbine.electricMw'],
            },
            schedule: {
              actions: [{
                id: 'plant-rcp-a-trip',
                atMs: 1_000,
                type: 'setVariable',
                path: 'rcpA.running',
                value: false,
              }],
            },
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })

    await Bun.sleep(1_100)

    const read = await connection.query(query('process-plant.variables.read', {
      systemId: 'plant',
      paths: ['rcpA.running'],
    }))
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.reason)
    expect((read.result as { variables: ReadonlyArray<{ readonly value: unknown }> }).variables[0]?.value).toBe(false)

    const trends = await connection.query(query('process-plant.trends.read', {
      systemId: 'plant',
      paths: ['rcpA.running'],
    }))
    expect(trends.ok).toBe(true)
    if (!trends.ok) throw new Error(trends.reason)
    const series = (trends.result as { series: ReadonlyArray<{ readonly points: ReadonlyArray<{ readonly value: unknown }> }> }).series[0]
    expect(series?.points.map(point => point.value)).toContain(false)

    await connection.close()
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

  test('emits protection signals and queues protection writes at tick boundaries', async () => {
    const received: unknown[] = []
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            protection: {
              rules: [{
                id: 'heater-trip-test',
                condition: {
                  type: 'comparison',
                  signal: { tagId: 'PZR-HTR' },
                  operator: '>',
                  value: 0,
                },
                effects: [
                  {
                    type: 'alarm',
                    id: 'heater-trip-alarm',
                    title: 'Protection test alarm',
                    message: 'Protection test condition is active.',
                    severity: 'warning',
                  },
                  {
                    type: 'write',
                    id: 'trip-rcp-a',
                    signal: { tagId: 'RCP-A-RUN' },
                    value: false,
                  },
                ],
              }],
            },
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })
    connection.subscribe(emission => {
      received.push(...emission.events)
    })

    const heater = await connection.sendCommand(command({
      systemId: 'plant',
      tagId: 'PZR-HTR',
      value: 1,
    }))
    expect(heater.ok).toBe(true)
    await Bun.sleep(2_100)
    const read = await connection.query(query('process-plant.signals.read', {
      systemId: 'plant',
      signals: [{ tagId: 'RCP-A-RUN' }],
    }))
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.reason)
    expect((read.result as { signals: ReadonlyArray<{ readonly variable: { readonly value: unknown } }> }).signals[0]?.variable.value).toBe(false)
    expect(received.some(event => (event as { readonly type?: string }).type === 'interaction.signal')).toBe(true)

    await connection.close()
  })

  test('emits non-latched protection effects once per active condition entry', async () => {
    const received: unknown[] = []
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            protection: {
              rules: [{
                id: 'heater-non-latched-test',
                latch: false,
                condition: {
                  type: 'comparison',
                  signal: { tagId: 'PZR-HTR' },
                  operator: '>',
                  value: 0,
                },
                effects: [{
                  type: 'alarm',
                  id: 'heater-non-latched-alarm',
                  title: 'Non-latched test alarm',
                  message: 'Non-latched condition is active.',
                  severity: 'warning',
                }],
              }],
            },
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })
    connection.subscribe(emission => {
      received.push(...emission.events)
    })

    const heater = await connection.sendCommand(command({
      systemId: 'plant',
      tagId: 'PZR-HTR',
      value: 1,
    }))
    expect(heater.ok).toBe(true)
    await Bun.sleep(3_100)

    const signals = received.filter(event => (event as { readonly type?: string }).type === 'interaction.signal')
    expect(signals).toHaveLength(1)

    await connection.close()
  })
})
