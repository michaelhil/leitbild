import { describe, expect, test } from 'bun:test'
import { component, connect, plantGraphSpecSchema, compileResolvedProcessPlant, compileProcessPlant, createPwrReferencePlantDefinition, createProcessPlantRuntime, createProcessPlantProtectionRunner, createProcessPlantRampRunner, answerProcessPlantQuery, commandsForProcessPlantAction, type VariablePath } from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { processPlantSignalQuality } from '../src/packs/process-plant/signals.ts'
import { evaluateProcessPlantProcedureCondition, type ProcessPlantProcedureCondition } from '../src/packs/process-plant/condition-evidence.ts'
import { createProcessPlantRecordingPlan } from '../src/packs/process-plant/recording.ts'
import { readPlant } from '../src/packs/process-plant/observation/read.ts'
import { evaluateSafetyFunction } from '../src/packs/process-plant/safety-functions.ts'
import { processPlantIcSafetyFunctionSchema } from '../src/packs/process-plant/runtime/index.ts'
import { isoTimestampSchema, objectIdSchema } from '../src/core/model/index.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()
const path = (p: string) => p as VariablePath
const timestamp = (seconds: number) => isoTimestampSchema.parse(new Date(Date.parse('2026-10-30T10:00:00Z') + seconds * 1000).toISOString())
const create = () => {
  const base = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'instrument-power' }))
  // Test-only separate physical feeds let one channel fail without also
  // removing its train mate. The production model retains two vital trains.
  const graph = plantGraphSpecSchema.parse({ ...base.sourceGraph,
    components: [...base.sourceGraph.components, ...['A', 'C'].map(loop => component(`channelSupply${loop}`, 'electricalGridSource', `Test channel ${loop} supply`, { nominalPowerMw: 1 }))],
    connections: [...base.sourceGraph.connections.filter(edge => !['deltaTChannelA.power', 'deltaTChannelC.power'].includes(edge.to)),
      ...['A', 'C'].map(loop => connect(`channel-feed-${loop}`, `channelSupply${loop}.outlet`, `deltaTChannel${loop}.power`, { connectionKind: 'electricalPower' }))],
  })
  const plant = compileResolvedProcessPlant({ id: base.id, modelRef: 'test.instrument-power', operatingPointRef: base.operatingPointRef, automationRef: base.automationRef, graph, automationForGraph: () => base.automation })
  const runtime = createProcessPlantRuntime({ system: plant })
  const instance: ProcessPlantRuntimeInstance = { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance(), protection: createProcessPlantProtectionRunner({ system: plant, protection: plant.automation }) }
  const set = (p: string, value: boolean | number) => runtime.writeCommand({ type: 'setVariable', path: path(p), value })
  const run = (seconds: number, protection = false) => { for (let i = 0; i < seconds; i++) {
    runtime.tick(1000)
    if (protection) instance.protection!.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'instrument-test' as never, sourceRuntimeId: 'process-plant.local' })
  } }
  return { instance, runtime, plant, set, run }
}

describe('powered delta-T indications and common evidence validity', () => {
  test('losing a channel supply invalidates its indications without zeroing private plant physics', () => {
    const { plant, runtime, set, run } = create()
    expect(processPlantSignalQuality(runtime.readVariableSnapshot(path('deltaTChannelA.deltaTC')), { system: plant, runtime }).status).toBe('good')
    set('channelSupplyA.available', false)
    run(1)
    expect(runtime.readVariable(path('deltaTChannelA.supplyAvailable'))).toBe(false)
    expect(processPlantSignalQuality(runtime.readVariableSnapshot(path('deltaTChannelA.deltaTC')), { system: plant, runtime })).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('supply') })
    expect(Number(runtime.readVariable(path('deltaTChannelA.deltaTC')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(path('core.powerMw')))).toBeGreaterThan(0)
    expect(processPlantSignalQuality(runtime.readVariableSnapshot(path('core.powerMw')), { system: plant, runtime }).status).toBe('good')
    expect(processPlantSignalQuality(runtime.readVariableSnapshot(path('deltaTChannelB.deltaTC')), { system: plant, runtime }).status).toBe('good')
  })

  test('the existing voter tolerates one unavailable channel and trips on two explicit fail-safe votes', () => {
    const { instance, runtime, set, run } = create()
    set('channelSupplyA.available', false)
    run(4, true)
    expect(runtime.readVariable(path('reactorTripBreakerA.closedState'))).toBe(true)
    expect(runtime.readVariable(path('reactorTripBreakerB.closedState'))).toBe(true)
    expect(instance.protection!.snapshot().alarms.some(alarm => alarm.active && alarm.title === 'Delta-T channel A instrument supply lost')).toBe(true)
    set('channelSupplyC.available', false)
    run(4, true)
    expect(runtime.readVariable(path('reactorTripBreakerA.closedState'))).toBe(false)
    expect(runtime.readVariable(path('reactorTripBreakerB.closedState'))).toBe(false)
  })

  test('signals, Plan/process observations, procedure comparisons and CSF trees cannot green an unavailable indication', () => {
    const { plant, instance, set, run } = create()
    set('channelSupplyA.available', false)
    run(1)
    const signal = path('deltaTChannelA.deltaTC')
    const condition: ProcessPlantProcedureCondition = { type: 'comparison', signal: { path: signal }, operator: '>', value: 0, unit: 'degC' }
    const basis = { modelRef: plant.modelRef, modelDigest: plant.modelDigest, source: 'test:instrument-power', description: 'Indication availability test only.' }
    const evaluate = (criterion: ProcessPlantProcedureCondition) => evaluateProcessPlantProcedureCondition({ plant: instance, condition: criterion, basis })
    expect(evaluate(condition)).toMatchObject({ status: 'unknown', evidence: [{ status: 'unknown', rangeValidity: 'unavailable' }] })
    expect(evaluate({ type: 'not', condition }).status).toBe('unknown')
    const queried = answerProcessPlantQuery({ request: { capabilityId: 'world.process-plant.signals.read', input: { plantId: plant.id, signals: [{ path: signal }] } }, plants: new Map([[plant.id, instance]]), objects: new Map() }) as { signals: Array<{ quality: { status: string } }> }
    expect(queried.signals[0]?.quality.status).toBe('unavailable')
    expect(readPlant({ objectId: objectIdSchema.parse(plant.id), system: instance, recording: null, simulationTime: timestamp(1), history: undefined }, [signal])[0]).toMatchObject({ value: null, quality: 'not-applicable' })
    const functionOnChannel = processPlantIcSafetyFunctionSchema.parse({ ...plant.automation.safetyFunctions[0], monitored: undefined,
      tree: { question: 'Is this indicated delta-T positive?', basis: 'Test a real indication availability boundary.',
        condition: { type: 'comparison', signal: { path: signal }, operator: '>', value: 0 }, yes: { status: 'green', meaning: 'Indicated.' }, no: { status: 'red', meaning: 'Not indicated.' } },
    })
    expect(evaluateSafetyFunction({ system: plant, runtime: instance.runtime, safetyFunction: functionOnChannel })).toMatchObject({ status: 'unknown' })
  })

  test('recording retains a quality transition even when the underlying numeric diagnostic is unchanged', () => {
    const { plant, instance, set, run } = create()
    const plan = createProcessPlantRecordingPlan({ selection: { packId: 'process-plant', profileId: 'operations' }, plants: new Map([[plant.id, instance]]), unitLabels: new Map([[plant.id, 'Instrument test unit']]) })
    const series = plan.descriptors.find(item => item.signalId === 'offsiteGrid.frequencyHz')!
    const sample = (seconds: number) => plan.sample({ observedAt: timestamp(seconds), simulationTime: timestamp(seconds) }).samples.find(item => item.seriesId === series.id)
    expect(sample(0)).toMatchObject({ value: 50, quality: 'good' })
    set('offsiteGrid.available', false)
    run(1)
    expect(sample(1)).toMatchObject({ value: 50, quality: 'bad' })
    expect(sample(2)).toBeUndefined()
    set('offsiteGrid.available', true)
    run(1)
    expect(sample(3)).toMatchObject({ value: 50, quality: 'good' })
  })

  test('shared validity also honors older model qualifiers, including a loop without forced flow', () => {
    const { plant, runtime, set, run } = create()
    set('rcpA.running', false)
    run(1)
    expect(processPlantSignalQuality(runtime.readVariableSnapshot(path('deltaTChannelA.deltaTPowerPercent')), { system: plant, runtime }).status).toBe('unavailable')
    expect(processPlantSignalQuality(runtime.readVariableSnapshot(path('deltaTChannelA.deltaTC')), { system: plant, runtime }).status).toBe('good')
  })

  test('the actual two-train model loses only isolated train A indications and actuators when AC is lost', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'actual-storage-isolation' }))
    const runtime = createProcessPlantRuntime({ system: plant })
    const set = (p: string, value: boolean) => runtime.writeCommand({ type: 'setVariable', path: path(p), value })
    set('vitalBatteryA.batteryConnected', false)
    runtime.tick(1000)
    expect(runtime.readVariable(path('deltaTChannelA.supplyAvailable'))).toBe(true)
    expect(runtime.readVariable(path('deltaTChannelC.supplyAvailable'))).toBe(true)
    for (const command of commandsForProcessPlantAction({ actionId: 'loss-offsite-power', parameters: {}, graph: plant.graph })) set(command.path, command.value as boolean)
    runtime.tick(1000)
    runtime.tick(1000)
    expect(runtime.readVariable(path('deltaTChannelA.supplyAvailable'))).toBe(false)
    expect(runtime.readVariable(path('deltaTChannelC.supplyAvailable'))).toBe(false)
    expect(runtime.readVariable(path('deltaTChannelB.supplyAvailable'))).toBe(true)
    expect(runtime.readVariable(path('deltaTChannelD.supplyAvailable'))).toBe(true)
    expect(runtime.readVariable(path('steamGeneratorReliefValveA.motorPowerAvailable'))).toBe(false)
    expect(runtime.readVariable(path('steamGeneratorReliefValveB.motorPowerAvailable'))).toBe(true)
    expect(runtime.readVariable(path('vitalBatteryA.storedEnergyMj'))).toBe(28_800)
    expect(processPlantSignalQuality(runtime.readVariableSnapshot(path('deltaTChannelA.deltaTC')), { system: plant, runtime }).status).toBe('unavailable')
    set('vitalBatteryA.batteryConnected', true)
    runtime.tick(1000)
    expect(runtime.readVariable(path('deltaTChannelA.supplyAvailable'))).toBe(true)
    expect(processPlantSignalQuality(runtime.readVariableSnapshot(path('deltaTChannelA.deltaTC')), { system: plant, runtime }).status).toBe('good')
    expect(Number(runtime.readVariable(path('vitalBatteryA.storedEnergyMj')))).toBeLessThan(28_800)
  })
})
