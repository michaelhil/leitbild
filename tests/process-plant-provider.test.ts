import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, ControlInstanceId, IsoTimestamp } from '../src/core/model/index.ts'
import type { PackQueryRequest } from '../src/core/packs/protocol.ts'
import type { SimulationProviderStateStore } from '../src/simulation/protocol.ts'
import {
  createLocalProcessPlantSimulationAdapter,
  compileProcessPlantSystems,
  createProcessPlantProtectionRunner,
  pressurizedWaterReactorPlantSpec,
  processPlantControlWriteCommandKind,
  processPlantIcAcknowledgeCommandKind,
  variablePathSchema,
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

const acknowledgeCommand = (payload: unknown): CommandEnvelope => ({
  id: 'command:process-plant-ack-test' as CommandId,
  controlInstanceId,
  actorId: 'actor:operator' as ActorId,
  kind: processPlantIcAcknowledgeCommandKind,
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

  test('exposes procedure-relevant signal search and mixed signal reads', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig(),
      providerStateStore: createMemoryStateStore(),
    })

    const procedureSignals = await connection.query(query('process-plant.signals.search', {
      systemId: 'plant',
      procedureRelevant: true,
    }))
    expect(procedureSignals.ok).toBe(true)
    if (!procedureSignals.ok) throw new Error(procedureSignals.reason)
    const searched = (procedureSignals.result as {
      readonly systems: ReadonlyArray<{
        readonly signals: ReadonlyArray<{
          readonly path: string
          readonly tagId?: string
          readonly capabilities?: { readonly procedureRelevant?: boolean; readonly aiVisible?: boolean }
        }>
      }>
    }).systems[0]?.signals ?? []
    expect(searched.map(signal => signal.tagId)).toContain('PT-455')
    expect(searched.map(signal => signal.tagId)).toContain('RCP-A-RUN')
    expect(searched.every(signal => signal.capabilities?.procedureRelevant === true)).toBe(true)
    expect(searched.every(signal => signal.capabilities?.aiVisible === true)).toBe(true)

    const writableSignals = await connection.query(query('process-plant.signals.search', {
      systemId: 'plant',
      writable: true,
    }))
    expect(writableSignals.ok).toBe(true)
    if (!writableSignals.ok) throw new Error(writableSignals.reason)
    const writable = (writableSignals.result as {
      readonly systems: ReadonlyArray<{
        readonly signals: ReadonlyArray<{ readonly path: string; readonly writable: boolean }>
      }>
    }).systems[0]?.signals ?? []
    expect(writable.map(signal => signal.path)).toContain('pressurizer.heaterPowerMw')
    expect(writable.map(signal => signal.path)).toContain('rcpA.running')
    expect(writable.every(signal => signal.writable)).toBe(true)

    const read = await connection.query(query('process-plant.signals.read', {
      systemId: 'plant',
      signals: [{ tagId: 'PT-455' }, { path: 'sgA.levelPercent' }],
    }))
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.reason)
    expect((read.result as {
      readonly signals: ReadonlyArray<{ readonly signal: { readonly path: string }; readonly variable: { readonly path: string } }>
    }).signals.map(entry => [entry.signal.path, entry.variable.path])).toEqual([
      ['pressurizer.pressureMPa', 'pressurizer.pressureMPa'],
      ['sgA.levelPercent', 'sgA.levelPercent'],
    ])

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
                    type: 'alarm.enter',
                    id: 'heater-trip-alarm',
                    title: 'Protection test alarm',
                    message: 'Protection test condition is active.',
                    severity: 'warning',
                  },
                  {
                    type: 'writeSignal',
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
                  type: 'alarm.enter',
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

  test('exposes I&C status with persistent alarm lifecycle state', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            protection: {
              rules: [{
                id: 'persistent-alarm-test',
                ruleClass: 'alarm',
                latch: false,
                condition: {
                  type: 'comparison',
                  signal: { tagId: 'PZR-HTR' },
                  operator: '>',
                  value: 0,
                },
                effects: [{
                  type: 'alarm.enter',
                  id: 'heater-high',
                  title: 'Heater high',
                  message: 'Pressurizer heater is energized.',
                  severity: 'notice',
                }],
              }],
            },
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })

    const heater = await connection.sendCommand(command({
      systemId: 'plant',
      tagId: 'PZR-HTR',
      value: 1,
    }))
    expect(heater.ok).toBe(true)
    await Bun.sleep(1_100)

    const status = await connection.query(query('process-plant.ic.status', { systemId: 'plant' }))
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error(status.reason)
    const alarms = (status.result as {
      readonly ic: { readonly alarms: ReadonlyArray<{ readonly id: string; readonly active: boolean; readonly acknowledged: boolean; readonly severity: string }> }
    }).ic.alarms
    expect(alarms).toContainEqual(expect.objectContaining({
      id: 'alarm:persistent-alarm-test:heater-high',
      active: true,
      acknowledged: false,
      severity: 'notice',
    }))

    await connection.close()
  })

  test('evaluates procedure-facing I&C conditions by tag id', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig(),
      providerStateStore: createMemoryStateStore(),
    })

    const result = await connection.query(query('process-plant.conditions.evaluate', {
      systemId: 'plant',
      condition: {
        type: 'all',
        conditions: [
          { type: 'comparison', signal: { tagId: 'PT-455' }, operator: '>', value: 0 },
          { type: 'not', condition: { type: 'comparison', signal: { tagId: 'RCP-A-RUN' }, operator: '==', value: false } },
        ],
      },
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    const body = result.result as {
      readonly matches: boolean
      readonly signalsRead: ReadonlyArray<{ readonly signal: { readonly tagId?: string }; readonly variable: { readonly path: string } }>
    }
    expect(body.matches).toBe(true)
    expect(body.signalsRead.map(entry => entry.signal.tagId)).toEqual(['PT-455', 'RCP-A-RUN'])

    await connection.close()
  })

  test('records failed I&C writes without silently mutating runtime state', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            protection: {
              rules: [{
                id: 'invalid-write-test',
                ruleClass: 'protection',
                condition: {
                  type: 'comparison',
                  signal: { tagId: 'PZR-HTR' },
                  operator: '>',
                  value: 0,
                },
                effects: [{
                  type: 'writeSignal',
                  id: 'write-core-power',
                  signal: { path: 'core.powerMw' },
                  value: 1,
                }],
              }],
            },
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })

    const heater = await connection.sendCommand(command({
      systemId: 'plant',
      tagId: 'PZR-HTR',
      value: 1,
    }))
    expect(heater.ok).toBe(true)
    await Bun.sleep(1_100)

    const status = await connection.query(query('process-plant.ic.status', { systemId: 'plant' }))
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error(status.reason)
    const failures = (status.result as {
      readonly ic: { readonly failures: ReadonlyArray<{ readonly ruleId: string; readonly effectId?: string; readonly message: string }> }
    }).ic.failures
    expect(failures).toContainEqual(expect.objectContaining({
      ruleId: 'invalid-write-test',
      effectId: 'write-core-power',
    }))
    expect(failures[0]?.message).toContain('not writable')

    await connection.close()
  })

  test('acknowledges persistent I&C lifecycle state through an explicit command', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            protection: {
              rules: [{
                id: 'acknowledge-alarm-test',
                ruleClass: 'alarm',
                condition: {
                  type: 'comparison',
                  signal: { tagId: 'PZR-HTR' },
                  operator: '>',
                  value: 0,
                },
                effects: [{
                  type: 'alarm.enter',
                  id: 'heater-ack-alarm',
                  title: 'Heater acknowledge alarm',
                  message: 'Pressurizer heater is energized.',
                  severity: 'warning',
                }],
              }],
            },
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })

    const heater = await connection.sendCommand(command({
      systemId: 'plant',
      tagId: 'PZR-HTR',
      value: 1,
    }))
    expect(heater.ok).toBe(true)
    await Bun.sleep(1_100)

    const acknowledged = await connection.sendCommand(acknowledgeCommand({
      systemId: 'plant',
      lifecycleId: 'alarm:acknowledge-alarm-test:heater-ack-alarm',
    }))
    expect(acknowledged.ok).toBe(true)

    const status = await connection.query(query('process-plant.ic.status', { systemId: 'plant' }))
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error(status.reason)
    const alarms = (status.result as {
      readonly ic: { readonly alarms: ReadonlyArray<{ readonly id: string; readonly acknowledged: boolean }> }
    }).ic.alarms
    expect(alarms).toContainEqual(expect.objectContaining({
      id: 'alarm:acknowledge-alarm-test:heater-ack-alarm',
      acknowledged: true,
    }))

    await connection.close()
  })

  test('rejects restored I&C snapshots that reference unknown rule state', () => {
    const system = compileProcessPlantSystems([{
      id: 'plant',
      pack: 'process-plant',
      componentLibrary: 'process-plant',
      graph: pressurizedWaterReactorPlantSpec,
    }])[0]
    if (!system) throw new Error('expected compiled process plant system')

    expect(() => createProcessPlantProtectionRunner({
      system,
      protection: {
        rules: [{
          id: 'known-rule',
          enabled: true,
          ruleClass: 'protection',
          condition: {
            type: 'comparison',
            signal: { path: variablePathSchema.parse('pressurizer.pressureMPa') },
            operator: '>',
            value: 0,
          },
          delayMs: 0,
          latch: true,
          resetWhenClear: false,
          effects: [{
            type: 'alarm.enter',
            id: 'known-alarm',
            title: 'Known alarm',
            message: 'Known alarm message.',
            severity: 'warning',
          }],
        }],
      },
      restoredSnapshot: {
        rules: [{
          ruleId: 'missing-rule',
          active: false,
          latched: false,
          firedCount: 0,
        }],
        alarms: [],
        trips: [],
        failures: [],
      },
    })).toThrow('restored I&C snapshot references unknown rule')
  })
})
