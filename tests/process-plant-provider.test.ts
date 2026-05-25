import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, ControlInstanceId, InteractionSignal, IsoTimestamp, ObjectId, OperationalObject, SignalId } from '../src/core/model/index.ts'
import { geoPointFromLonLat, operationalDemandRequestedSignalType } from '../src/core/model/index.ts'
import type { PackQueryRequest } from '../src/core/packs/protocol.ts'
import type { SimulationProviderStateStore } from '../src/simulation/protocol.ts'
import {
  createLocalProcessPlantSimulationAdapter,
  compileProcessPlantSystems,
  createProcessPlantProtectionRunner,
  pressurizedWaterReactorPlantSpec,
  processPlantControlWriteCommandKind,
  processPlantIcLifecycleCommandKind,
  processPlantPressurizedWaterReactorIcRef,
  processPlantPack,
  processPlantUnitDomainDataSchema,
  variablePathSchema,
} from '../src/packs/process-plant/index.ts'
import { createAmbulanceMedicalDemandInteractionHandler } from '../src/packs/ambulance/sim/interactions.ts'

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

const scenarioConfig = (
  processPlantConfig: unknown = {},
  processSystemOverrides: Record<string, unknown> = {},
) => ({
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
    ...processSystemOverrides,
  }],
  providerConfigs: {
    'process-plant-local': processPlantConfig,
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

const lifecycleCommand = (payload: unknown): CommandEnvelope => ({
  id: 'command:process-plant-ack-test' as CommandId,
  controlInstanceId,
  actorId: 'actor:operator' as ActorId,
  kind: processPlantIcLifecycleCommandKind,
  targetObjectIds: [],
  payload,
  issuedAt: startsAt,
})

describe('process plant simulation provider', () => {
  test('projects scenario-defined process units as operational objects', async () => {
    const unit = await processPlantPack.scenario!.expandObject({
      pack: 'process-plant',
      type: 'unit',
      id: 'plant:test',
      label: 'Test Unit',
      systemId: 'plant',
      location: [11.37, 59.12],
    }, {
      at: startsAt,
      objects: [],
      objectById: () => undefined,
      routing: {
        id: 'unused-process-plant-test-routing',
        route: async () => {
          throw new Error('process plant unit expansion should not route')
        },
      },
      providerConfigs: {},
    }) as OperationalObject
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: {
        ...scenarioConfig(),
        initialObjects: [unit],
      },
      providerStateStore: createMemoryStateStore(),
    })

    const snapshot = await connection.getSnapshot()
    expect(snapshot.objects.map(object => object.id)).toEqual(['plant:test' as ObjectId])
    const data = processPlantUnitDomainDataSchema.parse(snapshot.objects[0]?.domainData)
    expect(data.systemId).toBe('plant')
    expect(data.projection?.fields.map(field => field.key)).toContain('thermal-power')
    expect(data.projection?.fields.find(field => field.key === 'runtime-performance')?.value).toBe('pending')
    expect(snapshot.objects[0]?.operational.status).toBe('normal')

    await Bun.sleep(1_100)

    const advancedSnapshot = await connection.getSnapshot()
    const advancedData = processPlantUnitDomainDataSchema.parse(advancedSnapshot.objects[0]?.domainData)
    expect(advancedData.projection?.fields.find(field => field.key === 'runtime-performance')?.value).toMatch(/^RT x\d+ \(\d+\.\d ms\)$/)

    await connection.close()
  })

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

    const railProfile = await connection.query(query('process-plant.display-profile.read', {
      systemId: 'plant',
      profileId: 'leitbild-rail',
    }))
    expect(railProfile.ok).toBe(true)
    if (!railProfile.ok) throw new Error(railProfile.reason)
    const profileFields = (railProfile.result as {
      readonly groups: ReadonlyArray<{
        readonly fields: ReadonlyArray<{
          readonly key: string
          readonly label: string
          readonly variable: { readonly path: string; readonly value: unknown }
        }>
      }>
    }).groups.flatMap(group => group.fields)
    expect(profileFields.map(field => field.key)).toContain('thermal-power')
    expect(profileFields.find(field => field.key === 'thermal-power')?.variable.path).toBe('core.totalThermalPowerMw')

    await connection.close()
  })

  test('exposes compiled process surfaces and batched surface snapshots through pack queries', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig(),
      providerStateStore: createMemoryStateStore(),
    })

    const surfaces = await connection.query(query('process-plant.surfaces.list', { systemId: 'plant' }))
    expect(surfaces.ok).toBe(true)
    if (!surfaces.ok) throw new Error(surfaces.reason)
    expect((surfaces.result as {
      readonly surfaces: ReadonlyArray<{ readonly id: string; readonly title: string }>
    }).surfaces).toContainEqual(expect.objectContaining({
      id: 'unit-overview',
      title: 'Unit Overview',
    }))

    const surface = await connection.query(query('process-plant.surface.read', {
      systemId: 'plant',
      surfaceId: 'unit-overview',
    }))
    expect(surface.ok).toBe(true)
    if (!surface.ok) throw new Error(surface.reason)
    const compiled = (surface.result as {
      readonly surface: {
        readonly widgets: ReadonlyArray<{ readonly id: string }>
        readonly paths: ReadonlyArray<{ readonly id: string }>
        readonly bindingPaths: ReadonlyArray<string>
      }
    }).surface
    expect(compiled.widgets.map(widget => widget.id)).toContain('reactor-vessel')
    expect(compiled.paths.map(path => path.id)).toContain('main-steam-to-turbine')
    expect(compiled.bindingPaths).toContain('core.totalThermalPowerMw')

    const snapshot = await connection.query(query('process-plant.surface.snapshot', {
      systemId: 'plant',
      surfaceId: 'unit-overview',
    }))
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) throw new Error(snapshot.reason)
    const values = new Map((snapshot.result as {
      readonly values: ReadonlyArray<{
        readonly path: string
        readonly label: string
        readonly value: unknown
        readonly formatted: string
      }>
    }).values.map(value => [value.path, value]))
    expect(typeof values.get('core.totalThermalPowerMw')?.value).toBe('number')
    expect(values.get('core.totalThermalPowerMw')?.formatted).toMatch(/MW$/)
    expect(typeof values.get('pressurizer.pressureMPa')?.value).toBe('number')

    await connection.close()
  })

  test('creates an ambulance incident once from a generic medical demand signal', async () => {
    const handler = createAmbulanceMedicalDemandInteractionHandler()
    const signal: InteractionSignal = {
      id: 'signal:medical-demand-test' as SignalId,
      controlInstanceId,
      at: startsAt,
      source: { kind: 'object', id: 'plant:test' as ObjectId },
      targets: [{ kind: 'role', id: 'medical-transport' }],
      type: operationalDemandRequestedSignalType,
      severity: 'warning',
      payload: {
        schemaVersion: 1,
        demandId: 'medical-demand-test',
        capability: 'medical.transport',
        sourceObjectId: 'plant:test',
        location: geoPointFromLonLat(11.37, 59.12),
        quantity: 2,
        severity: 'warning',
        title: 'Medical demand test',
        description: 'Two people need medical transport.',
      },
    }

    const effects = await handler.handle({
      signal,
      snapshot: { seq: 1, objects: [] },
      provenance: { source: 'simulator' },
    })
    expect(effects.map(effect => effect.type)).toEqual(['object.upsert', 'notification.emit'])
    if (effects[0]?.type !== 'object.upsert') throw new Error('medical demand should create an incident object')
    expect(effects[0].object.id).toBe('incident:medical-demand-test' as ObjectId)

    const repeated = await handler.handle({
      signal,
      snapshot: {
        seq: 2,
        objects: [effects[0].object],
      },
      provenance: { source: 'simulator' },
    })
    expect(repeated).toEqual([])
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
      readonly signals: ReadonlyArray<{
        readonly signal: { readonly path: string }
        readonly variable: { readonly path: string }
        readonly quality: { readonly status: string }
      }>
    }).signals.map(entry => [entry.signal.path, entry.variable.path])).toEqual([
      ['pressurizer.pressureMPa', 'pressurizer.pressureMPa'],
      ['sgA.levelPercent', 'sgA.levelPercent'],
    ])
    expect((read.result as {
      readonly signals: ReadonlyArray<{ readonly quality: { readonly status: string } }>
    }).signals.every(entry => entry.quality.status === 'good')).toBe(true)

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
                    type: 'trip.enter',
                    id: 'heater-trip',
                    title: 'Protection test trip',
                    message: 'Protection test condition is active.',
                    severity: 'critical',
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

  test('preserves structured annunciator metadata in I&C lifecycle state', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            protection: {
              rules: [{
                id: 'annunciator-metadata-test',
                ruleClass: 'alarm',
                latch: false,
                resetWhenClear: true,
                condition: {
                  type: 'comparison',
                  signal: { tagId: 'PZR-HTR' },
                  operator: '>',
                  value: 0,
                },
                effects: [{
                  type: 'alarm.enter',
                  id: 'heater-energized',
                  title: 'Heater energized',
                  message: 'Pressurizer heaters are energized.',
                  severity: 'notice',
                  annunciator: {
                    system: 'reactor coolant system',
                    equipmentId: 'pressurizer',
                    group: 'pressurizer',
                    firstOutGroup: 'pressurizer-pressure',
                    priority: 'medium',
                    role: 'status',
                  },
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
      readonly ic: {
        readonly alarms: ReadonlyArray<{
          readonly id: string
          readonly annunciator?: { readonly system?: string; readonly equipmentId?: string; readonly priority?: string; readonly role?: string }
        }>
      }
    }).ic.alarms
    expect(alarms).toContainEqual(expect.objectContaining({
      id: 'alarm:annunciator-metadata-test:heater-energized',
      annunciator: expect.objectContaining({
        system: 'reactor coolant system',
        equipmentId: 'pressurizer',
        priority: 'medium',
        role: 'status',
      }),
    }))

    await connection.close()
  })

  test('mode conditions qualify I&C rules without a separate mode store', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            protection: {
              rules: [{
                id: 'mode-qualified-alarm-test',
                ruleClass: 'alarm',
                latch: false,
                resetWhenClear: true,
                modeLabel: 'impossible test mode',
                modeCondition: {
                  type: 'comparison',
                  signal: { path: 'core.powerMw' },
                  operator: '<',
                  value: 0,
                },
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
                  message: 'Heater is energized.',
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
      readonly ic: { readonly alarms: ReadonlyArray<{ readonly id: string; readonly active: boolean }> }
    }).ic.alarms
    expect(alarms).toContainEqual(expect.objectContaining({
      id: 'alarm:mode-qualified-alarm-test:heater-high',
      active: false,
    }))

    await connection.close()
  })

  test('validates control writes through the query surface without mutating state', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig(),
      providerStateStore: createMemoryStateStore(),
    })

    const accepted = await connection.query(query('process-plant.control.validate', {
      systemId: 'plant',
      tagId: 'PZR-HTR',
      value: 2,
    }))
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error(accepted.reason)
    expect((accepted.result as { readonly accepted: boolean; readonly currentValue: unknown }).accepted).toBe(true)
    expect((accepted.result as { readonly accepted: boolean; readonly currentValue: unknown }).currentValue).toBe(0)

    const rejected = await connection.query(query('process-plant.control.validate', {
      systemId: 'plant',
      path: 'core.powerMw',
      value: 1,
    }))
    expect(rejected.ok).toBe(true)
    if (!rejected.ok) throw new Error(rejected.reason)
    expect((rejected.result as { readonly accepted: boolean; readonly reason?: string }).accepted).toBe(false)
    expect((rejected.result as { readonly accepted: boolean; readonly reason?: string }).reason).toContain('not writable')

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

  test('blocks process writes through explicit I&C permissives and interlocks', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            protection: {
              rules: [
                {
                  id: 'heater-permissive-test',
                  ruleClass: 'permissive',
                  condition: {
                    type: 'comparison',
                    signal: { tagId: 'RCP-A-RUN' },
                    operator: '==',
                    value: true,
                  },
                  commandGates: [{
                    signal: { tagId: 'PZR-HTR' },
                    message: 'heater requires RCP A running',
                  }],
                },
                {
                  id: 'spray-interlock-test',
                  ruleClass: 'interlock',
                  condition: {
                    type: 'comparison',
                    signal: { tagId: 'RCP-A-RUN' },
                    operator: '==',
                    value: false,
                  },
                  commandGates: [{
                    signal: { tagId: 'PZR-SPRAY' },
                    message: 'spray is blocked while RCP A is stopped',
                  }],
                },
              ],
            },
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })

    const stopRcp = await connection.sendCommand(command({
      systemId: 'plant',
      tagId: 'RCP-A-RUN',
      value: false,
    }))
    expect(stopRcp.ok).toBe(true)
    await Bun.sleep(1_100)

    const heater = await connection.sendCommand(command({
      systemId: 'plant',
      tagId: 'PZR-HTR',
      value: 1,
    }))
    expect(heater.ok).toBe(false)
    if (heater.ok) throw new Error('expected heater command rejection')
    expect(heater.reason).toContain('heater requires RCP A running')

    const spray = await connection.sendCommand(command({
      systemId: 'plant',
      tagId: 'PZR-SPRAY',
      value: 10,
    }))
    expect(spray.ok).toBe(false)
    if (spray.ok) throw new Error('expected spray command rejection')
    expect(spray.reason).toContain('spray is blocked')

    await connection.close()
  })

  test('rejects invalid I&C rule class and effect combinations before runtime starts', async () => {
    await expect(createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            protection: {
              rules: [{
                id: 'alarm-with-write-test',
                ruleClass: 'alarm',
                condition: {
                  type: 'comparison',
                  signal: { tagId: 'PZR-HTR' },
                  operator: '>',
                  value: 0,
                },
                effects: [{
                  type: 'writeSignal',
                  id: 'write-spray',
                  signal: { tagId: 'PZR-SPRAY' },
                  value: 1,
                }],
              }],
            },
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })).rejects.toThrow('alarm rule alarm-with-write-test must only define alarm.enter effects')
  })

  test('rejects invalid I&C clear conditions before runtime starts', async () => {
    await expect(createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            protection: {
              rules: [{
                id: 'invalid-clear-condition-test',
                ruleClass: 'alarm',
                condition: {
                  type: 'comparison',
                  signal: { tagId: 'PZR-HTR' },
                  operator: '>',
                  value: 0,
                },
                clearCondition: {
                  type: 'comparison',
                  signal: { tagId: 'RCP-A-RUN' },
                  operator: '>',
                  value: 0,
                },
                effects: [{
                  type: 'alarm.enter',
                  id: 'heater-high',
                  title: 'Heater high',
                  message: 'Heater alarm.',
                  severity: 'warning',
                }],
              }],
            },
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })).rejects.toThrow('uses numeric operator > with non-numeric signal rcpA.running')
  })

  test('validates procedure tag appendices against graph-owned process signal bindings', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig(),
      providerStateStore: createMemoryStateStore(),
    })

    const validation = await connection.query(query('process-plant.procedure-tags.validate', {
      systemId: 'plant',
      tags: [
        {
          id: 'PT-455',
          simPath: 'pressurizer.pressureMPa',
          units: 'MPa',
          equipment: 'pressurizer',
        },
        {
          id: 'SG-A-N16',
          simPath: 'wrong.path',
          units: 'psig',
          equipment: 'sg-a',
        },
        {
          id: 'NO-SUCH-TAG',
          simPath: 'missing.signal',
          units: 'MPa',
          equipment: 'missing',
        },
      ],
    }))
    expect(validation.ok).toBe(true)
    if (!validation.ok) throw new Error(validation.reason)
    const tags = (validation.result as {
      readonly tags: ReadonlyArray<{ readonly id: string; readonly status: string; readonly warnings: ReadonlyArray<string> }>
    }).tags
    expect(tags.find(tag => tag.id === 'PT-455')?.status).toBe('resolved')
    expect(tags.find(tag => tag.id === 'SG-A-N16')?.status).toBe('resolved-with-warnings')
    expect(tags.find(tag => tag.id === 'SG-A-N16')?.warnings.join(' ')).toContain('sim-path wrong.path')
    expect(tags.find(tag => tag.id === 'NO-SUCH-TAG')?.status).toBe('missing')

    await connection.close()
  })

  test('rejects invalid I&C write targets before runtime starts', async () => {
    await expect(createLocalProcessPlantSimulationAdapter().connect({
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
    })).rejects.toThrow('writes non-writable signal core.powerMw')
  })

  test('applies explicit I&C lifecycle actions through one command surface', async () => {
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

    const acknowledged = await connection.sendCommand(lifecycleCommand({
      systemId: 'plant',
      lifecycleId: 'alarm:acknowledge-alarm-test:heater-ack-alarm',
      action: 'acknowledge',
    }))
    expect(acknowledged.ok).toBe(true)

    const suppressed = await connection.sendCommand(lifecycleCommand({
      systemId: 'plant',
      lifecycleId: 'alarm:acknowledge-alarm-test:heater-ack-alarm',
      action: 'suppress',
    }))
    expect(suppressed.ok).toBe(true)

    const shelved = await connection.sendCommand(lifecycleCommand({
      systemId: 'plant',
      lifecycleId: 'alarm:acknowledge-alarm-test:heater-ack-alarm',
      action: 'shelve',
    }))
    expect(shelved.ok).toBe(true)

    const status = await connection.query(query('process-plant.ic.status', { systemId: 'plant' }))
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error(status.reason)
    const alarms = (status.result as {
      readonly ic: { readonly alarms: ReadonlyArray<{ readonly id: string; readonly acknowledged: boolean; readonly suppressed: boolean; readonly shelved: boolean }> }
    }).ic.alarms
    expect(alarms).toContainEqual(expect.objectContaining({
      id: 'alarm:acknowledge-alarm-test:heater-ack-alarm',
      acknowledged: true,
      suppressed: true,
      shelved: true,
    }))

    const reset = await connection.sendCommand(lifecycleCommand({
      systemId: 'plant',
      lifecycleId: 'alarm:acknowledge-alarm-test:heater-ack-alarm',
      action: 'reset',
    }))
    expect(reset.ok).toBe(true)

    await connection.close()
  })

  test('emits lifecycle action events and records operator provenance in alarm history', async () => {
    const received: unknown[] = []
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            protection: {
              rules: [{
                id: 'alarm-history-provenance-test',
                ruleClass: 'alarm',
                condition: {
                  type: 'comparison',
                  signal: { tagId: 'PZR-HTR' },
                  operator: '>',
                  value: 0,
                },
                effects: [{
                  type: 'alarm.enter',
                  id: 'heater-alarm',
                  title: 'Heater alarm',
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
    connection.subscribe(emission => received.push(...emission.events))

    const heater = await connection.sendCommand(command({
      systemId: 'plant',
      tagId: 'PZR-HTR',
      value: 1,
    }))
    expect(heater.ok).toBe(true)
    await Bun.sleep(1_100)

    const acknowledged = await connection.sendCommand({
      ...lifecycleCommand({
        systemId: 'plant',
        lifecycleId: 'alarm:alarm-history-provenance-test:heater-alarm',
        action: 'acknowledge',
        reason: 'operator verified heater alarm',
      }),
      clientId: 'client:alarm-board' as never,
    })
    expect(acknowledged.ok).toBe(true)

    const actionEvents = received.filter(event =>
      (event as { readonly type?: string }).type === 'interaction.signal'
      && (event as { readonly signal?: { readonly type?: string } }).signal?.type === 'process-plant.alarm.acknowledged',
    )
    expect(actionEvents).toHaveLength(1)

    const history = await connection.query(query('process-plant.alarms.history', { systemId: 'plant' }))
    expect(history.ok).toBe(true)
    if (!history.ok) throw new Error(history.reason)
    const entries = (history.result as {
      readonly history: ReadonlyArray<{ readonly lifecycleId: string; readonly transition: string; readonly actorId?: string; readonly clientId?: string; readonly reason?: string }>
    }).history
    expect(entries).toContainEqual(expect.objectContaining({
      lifecycleId: 'alarm:alarm-history-provenance-test:heater-alarm',
      transition: 'acknowledged',
      actorId: 'actor:operator',
      clientId: 'client:alarm-board',
      reason: 'operator verified heater alarm',
    }))

    await connection.close()
  })

  test('uses explicit alarm clear conditions and clear delays to avoid chatter', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            protection: {
              rules: [{
                id: 'clear-hysteresis-test',
                ruleClass: 'alarm',
                latch: false,
                resetWhenClear: true,
                condition: {
                  type: 'comparison',
                  signal: { tagId: 'PZR-HTR' },
                  operator: '>',
                  value: 5,
                },
                clearCondition: {
                  type: 'comparison',
                  signal: { tagId: 'PZR-HTR' },
                  operator: '<',
                  value: 2,
                },
                clearDelayMs: 1_000,
                effects: [{
                  type: 'alarm.enter',
                  id: 'heater-high',
                  title: 'Heater high',
                  message: 'Pressurizer heater is above the alarm threshold.',
                  severity: 'warning',
                }],
              }],
            },
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })

    expect((await connection.sendCommand(command({ systemId: 'plant', tagId: 'PZR-HTR', value: 10 }))).ok).toBe(true)
    await Bun.sleep(1_100)
    expect((await connection.sendCommand(command({ systemId: 'plant', tagId: 'PZR-HTR', value: 4 }))).ok).toBe(true)
    await Bun.sleep(1_100)
    let status = await connection.query(query('process-plant.alarms.status', { systemId: 'plant' }))
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error(status.reason)
    let alarm = (status.result as {
      readonly alarms: ReadonlyArray<{ readonly id: string; readonly active: boolean; readonly clearCount: number }>
    }).alarms.find(candidate => candidate.id === 'alarm:clear-hysteresis-test:heater-high')
    expect(alarm?.active).toBe(true)

    expect((await connection.sendCommand(command({ systemId: 'plant', tagId: 'PZR-HTR', value: 0 }))).ok).toBe(true)
    await Bun.sleep(2_100)
    status = await connection.query(query('process-plant.alarms.status', { systemId: 'plant' }))
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error(status.reason)
    alarm = (status.result as {
      readonly alarms: ReadonlyArray<{ readonly id: string; readonly active: boolean; readonly clearCount: number }>
    }).alarms.find(candidate => candidate.id === 'alarm:clear-hysteresis-test:heater-high')
    expect(alarm?.active).toBe(false)
    expect(alarm?.clearCount).toBe(1)

    await connection.close()
  })

  test('expires shelved alarms and exposes alarm summary first-out state', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            protection: {
              rules: [
                {
                  id: 'first-out-heater-test',
                  ruleClass: 'alarm',
                  condition: {
                    type: 'comparison',
                    signal: { tagId: 'PZR-HTR' },
                    operator: '>',
                    value: 0,
                  },
                  effects: [{
                    type: 'alarm.enter',
                    id: 'heater',
                    title: 'Heater alarm',
                    message: 'Heater alarm.',
                    severity: 'warning',
                    annunciator: {
                      group: 'pressurizer',
                      firstOutGroup: 'pressurizer-test',
                      priority: 'high',
                      role: 'symptom',
                    },
                  }],
                },
                {
                  id: 'first-out-spray-test',
                  ruleClass: 'alarm',
                  condition: {
                    type: 'comparison',
                    signal: { tagId: 'PZR-SPRAY' },
                    operator: '>',
                    value: 0,
                  },
                  effects: [{
                    type: 'alarm.enter',
                    id: 'spray',
                    title: 'Spray alarm',
                    message: 'Spray alarm.',
                    severity: 'warning',
                    annunciator: {
                      group: 'pressurizer',
                      firstOutGroup: 'pressurizer-test',
                      priority: 'high',
                      role: 'symptom',
                    },
                  }],
                },
              ],
            },
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })

    expect((await connection.sendCommand(command({ systemId: 'plant', tagId: 'PZR-HTR', value: 1 }))).ok).toBe(true)
    await Bun.sleep(1_100)
    expect((await connection.sendCommand(command({ systemId: 'plant', tagId: 'PZR-SPRAY', value: 1 }))).ok).toBe(true)
    await Bun.sleep(1_100)

    const shelved = await connection.sendCommand(lifecycleCommand({
      systemId: 'plant',
      lifecycleId: 'alarm:first-out-heater-test:heater',
      action: 'shelve',
      shelveDurationMs: 1_000,
    }))
    expect(shelved.ok).toBe(true)
    await Bun.sleep(2_100)

    const summary = await connection.query(query('process-plant.alarms.summary', { systemId: 'plant' }))
    expect(summary.ok).toBe(true)
    if (!summary.ok) throw new Error(summary.reason)
    const alarmSummary = (summary.result as {
      readonly summary: {
        readonly activeCount: number
        readonly firstOutCount: number
        readonly firstOut: ReadonlyArray<{ readonly id: string; readonly firstOut: boolean; readonly shelved: boolean }>
      }
    }).summary
    expect(alarmSummary.activeCount).toBe(2)
    expect(alarmSummary.firstOutCount).toBe(1)
    expect(alarmSummary.firstOut).toContainEqual(expect.objectContaining({
      id: 'alarm:first-out-heater-test:heater',
      firstOut: true,
      shelved: false,
    }))

    const history = await connection.query(query('process-plant.alarms.history', { systemId: 'plant' }))
    expect(history.ok).toBe(true)
    if (!history.ok) throw new Error(history.reason)
    expect((history.result as {
      readonly history: ReadonlyArray<{ readonly lifecycleId: string; readonly transition: string }>
    }).history).toContainEqual(expect.objectContaining({
      lifecycleId: 'alarm:first-out-heater-test:heater',
      transition: 'shelveExpired',
    }))

    await connection.close()
  })

  test('loads reference I&C behavior through explicit icRef', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            icRef: processPlantPressurizedWaterReactorIcRef,
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })

    await Bun.sleep(1_100)

    const status = await connection.query(query('process-plant.ic.status', { systemId: 'plant' }))
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error(status.reason)
    const ic = (status.result as {
      readonly ic: {
        readonly rules: ReadonlyArray<{ readonly ruleId: string }>
        readonly alarms: ReadonlyArray<{ readonly id: string; readonly title: string }>
        readonly failures: ReadonlyArray<unknown>
      }
    }).ic
    expect(ic.rules.map(rule => rule.ruleId)).toContain('sg-a-tube-leak-indication')
    expect(ic.rules.map(rule => rule.ruleId)).toContain('pzr-pressure-high-relief')
    expect(ic.rules.map(rule => rule.ruleId)).toContain('reactor-high-power-trip')
    expect(ic.rules.map(rule => rule.ruleId)).toContain('containment-pressure-high')
    expect(ic.rules.map(rule => rule.ruleId)).toContain('accumulator-a-injecting')
    expect(ic.failures).toEqual([])

    await connection.close()
  })

  test('exposes I&C catalog for UI and AI introspection', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            icRef: processPlantPressurizedWaterReactorIcRef,
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })

    const catalog = await connection.query(query('process-plant.ic.catalog', { systemId: 'plant' }))
    expect(catalog.ok).toBe(true)
    if (!catalog.ok) throw new Error(catalog.reason)
    const ic = (catalog.result as {
      readonly ic: {
        readonly ruleCount: number
        readonly rules: ReadonlyArray<{
          readonly id: string
          readonly ruleClass: string
          readonly watchedSignals: ReadonlyArray<{ readonly path: string; readonly tagId?: string }>
          readonly effects: ReadonlyArray<{ readonly type: string; readonly signal?: { readonly path: string } }>
        }>
      }
    }).ic
    expect(ic.ruleCount).toBeGreaterThan(20)
    const relief = ic.rules.find(rule => rule.id === 'pzr-pressure-high-relief')
    expect(relief?.ruleClass).toBe('protection')
    expect(relief?.watchedSignals.map(signal => signal.tagId)).toContain('PT-455')
    expect(relief?.effects.some(effect => effect.type === 'writeSignal' && effect.signal?.path === 'pressurizer.reliefValvePositionFraction')).toBe(true)
    const pzrPressureLow = ic.rules.find(rule => rule.id === 'pzr-pressure-low')
    expect(pzrPressureLow?.watchedSignals.map(signal => signal.tagId)).toContain('PT-455')

    await connection.close()
  })

  test('rejects ambiguous reference and inline I&C configuration', async () => {
    await expect(createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            icRef: processPlantPressurizedWaterReactorIcRef,
            protection: { rules: [] },
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })).rejects.toThrow('must not define both icRef and inline protection')
  })

  test('rejects provider config for an unknown process system', async () => {
    await expect(createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          missingPlant: {
            icRef: processPlantPressurizedWaterReactorIcRef,
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })).rejects.toThrow('process plant provider config references unknown process system: missingPlant')
  })

  test('rejects unknown process plant icRef explicitly', async () => {
    await expect(createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            icRef: 'process-plant.no-such-ic.v1',
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })).rejects.toThrow('unknown process plant icRef')
  })

  test('reference I&C reports SGTR indications without encoding procedures', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            icRef: processPlantPressurizedWaterReactorIcRef,
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })

    const leak = await connection.sendCommand(command({
      systemId: 'plant',
      tagId: 'SG-A-TUBE-LEAK',
      value: 0.02,
    }))
    expect(leak.ok).toBe(true)
    await Bun.sleep(3_200)

    const status = await connection.query(query('process-plant.ic.status', { systemId: 'plant' }))
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error(status.reason)
    const alarms = (status.result as {
      readonly ic: {
        readonly alarms: ReadonlyArray<{
          readonly id: string
          readonly active: boolean
          readonly title: string
          readonly annunciator?: { readonly equipmentId?: string; readonly priority?: string }
        }>
      }
    }).ic.alarms
    expect(alarms).toContainEqual(expect.objectContaining({
      id: 'alarm:sg-a-tube-leak-indication:tube-leak',
      active: true,
      annunciator: expect.objectContaining({
        equipmentId: 'sgA',
        priority: 'high',
      }),
    }))
    expect(alarms.some(entry => entry.title.toLowerCase().includes('procedure'))).toBe(false)

    await connection.close()
  })

  test('reference I&C actuates auxiliary feedwater on SG low-low level', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            icRef: processPlantPressurizedWaterReactorIcRef,
          },
        },
      }, {
        initialState: {
          'sgA.secondaryInventoryKg': 2_500,
          'sgA.levelPercent': 5,
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })

    await Bun.sleep(3_200)

    const read = await connection.query(query('process-plant.signals.read', {
      systemId: 'plant',
      signals: [
        { path: 'auxFeedwaterPumpMotor.running' },
        { path: 'auxFeedwaterPumpTurbine.running' },
        { path: 'auxFeedwaterValveA.positionFraction' },
      ],
    }))
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.reason)
    const values = new Map((read.result as {
      readonly signals: ReadonlyArray<{ readonly signal: { readonly path: string }; readonly variable: { readonly value: unknown } }>
    }).signals.map(entry => [entry.signal.path, entry.variable.value]))
    expect(values.get('auxFeedwaterPumpMotor.running')).toBe(true)
    expect(values.get('auxFeedwaterPumpTurbine.running')).toBe(true)
    expect(values.get('auxFeedwaterValveA.positionFraction')).toBe(1)

    const status = await connection.query(query('process-plant.ic.status', { systemId: 'plant' }))
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error(status.reason)
    const trips = (status.result as {
      readonly ic: { readonly trips: ReadonlyArray<{ readonly id: string; readonly active: boolean }> }
    }).ic.trips
    expect(trips).toContainEqual(expect.objectContaining({
      id: 'trip:sg-a-level-low-low-afw-actuation:afw-actuation',
      active: true,
    }))

    await connection.close()
  })

  test('reference I&C reports RCP trip and loop low flow', async () => {
    const connection = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            icRef: processPlantPressurizedWaterReactorIcRef,
          },
        },
      }),
      providerStateStore: createMemoryStateStore(),
    })

    const stopped = await connection.sendCommand(command({
      systemId: 'plant',
      tagId: 'RCP-A-RUN',
      value: false,
    }))
    expect(stopped.ok).toBe(true)
    await Bun.sleep(3_200)

    const status = await connection.query(query('process-plant.ic.status', { systemId: 'plant' }))
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error(status.reason)
    const activeAlarmIds = (status.result as {
      readonly ic: { readonly alarms: ReadonlyArray<{ readonly id: string; readonly active: boolean }> }
    }).ic.alarms.filter(alarm => alarm.active).map(alarm => alarm.id)
    expect(activeAlarmIds).toContain('alarm:rcp-a-trip:not-running')

    await connection.close()
  })

  test('reference I&C state restores per system from provider snapshots', async () => {
    const store = createMemoryStateStore()
    const first = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            icRef: processPlantPressurizedWaterReactorIcRef,
          },
        },
      }),
      providerStateStore: store,
    })

    const leak = await first.sendCommand(command({
      systemId: 'plant',
      tagId: 'SG-A-TUBE-LEAK',
      value: 0.02,
    }))
    expect(leak.ok).toBe(true)
    await Bun.sleep(1_200)
    await first.close()

    const restored = await createLocalProcessPlantSimulationAdapter().connect({
      controlInstanceId,
      scenario: scenarioConfig({
        systems: {
          plant: {
            icRef: processPlantPressurizedWaterReactorIcRef,
          },
        },
      }),
      providerStateStore: store,
    })
    const status = await restored.query(query('process-plant.ic.status', { systemId: 'plant' }))
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error(status.reason)
    const alarms = (status.result as {
      readonly ic: { readonly alarms: ReadonlyArray<{ readonly id: string; readonly active: boolean }> }
    }).ic.alarms
    expect(alarms).toContainEqual(expect.objectContaining({
      id: 'alarm:sg-a-tube-leak-indication:tube-leak',
      active: true,
    }))

    await restored.close()
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
          ruleClass: 'alarm',
          condition: {
            type: 'comparison',
            signal: { path: variablePathSchema.parse('pressurizer.pressureMPa') },
            operator: '>',
            value: 0,
          },
          delayMs: 0,
          clearDelayMs: 0,
          latch: true,
          resetWhenClear: false,
          effects: [{
            type: 'alarm.enter',
            id: 'known-alarm',
            title: 'Known alarm',
            message: 'Known alarm message.',
            severity: 'warning',
          }],
          commandGates: [],
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
        history: [],
      },
    })).toThrow('restored I&C snapshot references unknown rule')
  })
})
