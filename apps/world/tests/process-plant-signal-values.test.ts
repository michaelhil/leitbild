import { expect, test } from 'bun:test'
import { isoTimestampSchema } from '../src/core/model/index.ts'
import { parseProcedureTagValue } from '../src/features/procedures/pack-observations.ts'
import { answerProcessPlantQuery, compileProcessPlant, createProcessPlantRampRunner, createProcessPlantRuntime, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import { processSignalTagIdSchema, variablePathSchema } from '../src/packs/process-plant/graph/index.ts'
import { createPlantOperations } from '../src/packs/process-plant/operations/plant-operations.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:signal-values', loopCount: 4 }))
const at = isoTimestampSchema.parse('2026-10-31T04:00:21.000Z')
const capability = processPlantCapabilities.find(row => row.id === 'world.process-plant.signals.read')!
const fixture = (): ProcessPlantRuntimeInstance => {
  const runtime = createProcessPlantRuntime({ system: plant })
  return { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), operations: createPlantOperations({ graph: plant.graph }), performance: createProcessPlantRuntimePerformance() }
}
const query = (instance: ProcessPlantRuntimeInstance, id: string, input: Record<string, unknown>): any => {
  const result = answerProcessPlantQuery({ request: { capabilityId: id, input: { plantId: plant.id, ...input } },
    plants: new Map([[plant.id, instance]]), objects: new Map(), simulationTime: at })
  expect(processPlantCapabilities.find(row => row.id === id)!.output.parse(result)).toEqual(result)
  return result
}
const read = (instance: ProcessPlantRuntimeInstance, input: Record<string, unknown>) => query(instance, capability.id, input)
const equalFacts = (full: any, values: any) => {
  expect(values.detail).toBe('values')
  expect(values.signals).toHaveLength(full.signals.length)
  const { signals: _fullRows, ...fullBatch } = full
  const { detail: _detail, signals: _valueRows, ...valuesBatch } = values
  expect(valuesBatch).toEqual(fullBatch)
  for (const [index, row] of full.signals.entries()) {
    const actual = values.signals[index]
    for (const key of ['path', 'tagId', 'label', 'unit', 'writable', 'published', 'limits', 'simulatorOnly', 'externalRefs']) expect(actual.signal[key]).toEqual(row.signal[key])
    for (const key of ['path', 'value', 'canonicalValue', 'unit', 'writable', 'published', 'limits']) expect(actual.variable[key]).toEqual(row.variable[key])
    const { signal: _signal, variable: _variable, ...other } = row
    const { signal: _valueSignal, variable: _valueVariable, ...valueOther } = actual
    expect(valueOther).toEqual(other)
    for (const key of ['description', 'equipmentId', 'capabilities', 'owner', 'quantity', 'kind', 'discipline']) expect(actual.signal).not.toHaveProperty(key)
    for (const key of ['label', 'description', 'equipmentId', 'capabilities', 'externalRefs', 'tagId', 'quantity', 'kind', 'discipline']) expect(actual.variable).not.toHaveProperty(key)
  }
}

test('values is explicit; default and full keep complete metadata, while real ordered controller facts and simulator labels remain exact', () => {
  const instance = fixture(), before = instance.runtime.snapshot()
  const refs = [
    ...['A', 'B', 'C', 'D'].flatMap(loop => [{ tagId: `AFW-${loop}-CV` }, { tagId: `AFW-${loop}-CV-POS` }]),
    { path: 'condenser.coolingWaterFlowKgPerS' }, { tagId: 'TURB-BYP-AUTO' }, { tagId: 'TURB-BYP-SP' },
    { path: 'turbineBypassValve.effectivePositionFraction' }, { path: 'turbineBypassValve.outletFlowKgPerS' },
    { path: 'sgA.secondaryInventoryKg' }, { tagId: 'AFW-A-CV' },
  ]
  const full = read(instance, { signals: refs, evidence: true })
  expect(read(instance, { signals: refs, evidence: true, detail: 'full' })).toEqual(full)
  expect(full).not.toHaveProperty('detail')
  expect(full.signals[0].signal.description).toContain('demand')
  expect(full.signals[0].signal.owner).toBeDefined()
  const values = read(instance, { signals: refs, evidence: true, detail: 'values' })
  equalFacts(full, values)
  expect(values.signals[0]).toEqual(values.signals.at(-1))
  expect(values.signals[13].signal.simulatorOnly).toBe(true)
  expect(query(instance, 'world.process-plant.signals.resolve', { signals: refs }).signals).toEqual(full.signals.map((row: any) => row.signal))
  expect(instance.runtime.snapshot()).toEqual(before)
})

test('all evidence, observed and operations combinations preserve exact histories, requested conversions and undeclared observations', () => {
  const instance = fixture(), binding = plant.graph.signalBindingByTagId.get(processSignalTagIdSchema.parse('AFW-A-CV'))!
  instance.operations!.record({ commandId: 'test:accepted-afw', path: binding.path, value: .6, origin: 'ai', actorId: 'test:operator', elapsedMs: 0, kind: 'write' }, { elapsedMs: 0, wallMs: 0 })
  instance.operations!.recordReset({ commandId: 'test:accepted-reset', kind: 'reset', ruleId: 'sg-a-level-low-low-afw-actuation', label: 'AFW actuation',
    holds: [binding.path], origin: 'person', actorId: 'test:operator', elapsedMs: 0 }, { elapsedMs: 0, wallMs: 0 })
  const signals = [{ tagId: 'AFW-A-CV', requestedUnit: 'fraction' }, { tagId: 'PT-455', requestedUnit: 'psig' },
    { tagId: 'CET-AVG', requestedUnit: 'degF' }, { path: 'auxFeedwaterPumpTurbine.flowKgPerS' }, { path: 'core.boronFeedbackPcm' }]
  for (const evidence of [false, true]) for (const observed of [false, true]) for (const operations of [false, true]) {
    const options = { ...(evidence ? { evidence: true } : {}), ...(observed ? { observed: true } : {}), ...(operations ? { operations: true } : {}) }
    const full = read(instance, { signals, ...options }), values = read(instance, { signals, ...options, detail: 'values' })
    equalFacts(full, values)
    expect(values.signals[0].valueView.status).toBe('native')
    expect(values.signals[1].valueView).toMatchObject({ status: 'unavailable', unit: 'MPa', requestedUnit: 'psig', reason: expect.stringContaining('Native values remain') })
    expect(values.signals[2].valueView.status).toBe('converted')
    if (operations) { expect(values.operations.log[0].commandId).toBe('test:accepted-afw'); expect(values.operations.resets[0].commandId).toBe('test:accepted-reset') }
    if (observed) expect(values.signals.at(-1).observed).toBe(null)
  }
})

test('binding and acquired snapshot disagreements remain separate, including native/canonical values and outside-range quality', () => {
  const instance = fixture(), snapshot = instance.runtime.readVariableSnapshot
  const binding = plant.graph.signalBindingByTagId.get(processSignalTagIdSchema.parse('SG-A-LVL-NR'))!
  const changed: ProcessPlantRuntimeInstance = { ...instance, runtime: { ...instance.runtime, readVariableSnapshot: path => path === binding.path
    ? { ...snapshot(path), value: 42, canonicalValue: .42, unit: 'MPa', writable: true, published: false, limits: { hardRange: { min: 0, max: 5 } } }
    : snapshot(path) } }
  const input = { signals: [{ tagId: 'SG-A-LVL-NR' }], evidence: true }
  const full = read(changed, input), values = read(changed, { ...input, detail: 'values' })
  equalFacts(full, values)
  expect(values.signals[0]).toMatchObject({ signal: { unit: 'percent', writable: false, published: true },
    variable: { value: 42, canonicalValue: .42, unit: 'MPa', writable: true, published: false, limits: { hardRange: { min: 0, max: 5 } } },
    quality: { status: 'outside-hard-range', reason: expect.stringContaining('42 is outside hard range 0..5 MPa') } })
  expect(values.signals[0].signal.limits).toEqual(binding.limits)
  expect(() => parseProcedureTagValue({ id: 'SG-A-LVL-NR' }, values)).toThrow('native units disagree')
})

test('an unavailable measured value retains its original value and reason independently of the good batch identity', () => {
  const instance = fixture(), snapshot = instance.runtime.readVariableSnapshot
  const qualification = plant.graph.components.flatMap(component => component.semantics.meaningfulWhile)[0]!
  const changed: ProcessPlantRuntimeInstance = { ...instance, runtime: { ...instance.runtime,
    readVariableSnapshot: path => path === qualification.flag ? { ...snapshot(path), value: false, canonicalValue: false } : snapshot(path) } }
  const input = { signals: [{ path: qualification.variables[0] }, { tagId: 'PT-455' }], evidence: true }
  const full = read(changed, input), values = read(changed, { ...input, detail: 'values' })
  equalFacts(full, values)
  expect(values.signals[0].quality).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('measures nothing unless') })
  expect(values.signals[1].quality.status).toBe('good')
  expect(values.signals[0].variable.value).toEqual(snapshot(qualification.variables[0]!).value)
})

test('procedure interpretation receives the same exact evidence and current value from either explicit detail', () => {
  const instance = fixture(), input = { signals: [{ tagId: 'PT-455', requestedUnit: 'psig' }], evidence: true }
  expect(parseProcedureTagValue({ id: 'PT-455', units: 'psig' }, read(instance, { ...input, detail: 'values' })))
    .toEqual(parseProcedureTagValue({ id: 'PT-455', units: 'psig' }, read(instance, input)))
})

test('values cannot reveal injected faults or fault truth, repair invalid references, or bypass the acquisition-time requirement', () => {
  const instance = fixture()
  for (const path of ['pressurizer.reliefValveFailureActive', 'sgA.tubeLeakFraction', 'sgA.primaryToSecondaryLeakKgPerS']) {
    expect(plant.graph.signalBindingByPath.has(variablePathSchema.parse(path))).toBe(true)
    expect(() => read(instance, { signals: [{ path }], detail: 'values', evidence: true })).toThrow('not a reading')
  }
  expect(read(instance, { signals: [{ tagId: 'GRID-HZ' }], detail: 'values' }).signals).toHaveLength(1)
  for (const detail of ['compact', null, true]) expect(capability.input.safeParse({ plantId: plant.id, signals: [{ tagId: 'PT-455' }], detail }).success).toBe(false)
  expect(capability.input.safeParse({ plantId: plant.id, signals: [{ tagId: 'PT-455', path: 'pressurizer.pressureMPa' }], detail: 'values' }).success).toBe(false)
  expect(capability.output.safeParse({ plantId: plant.id, detail: 'full', signals: [] }).success).toBe(false)
  expect(() => answerProcessPlantQuery({ request: { capabilityId: capability.id, input: { plantId: plant.id, signals: [{ tagId: 'PT-455' }], detail: 'values', evidence: true } },
    plants: new Map([[plant.id, instance]]), objects: new Map() })).toThrow('needs the Run time')
})
