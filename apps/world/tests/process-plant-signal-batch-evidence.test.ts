import { expect, test } from 'bun:test'
import { isoTimestampSchema } from '../src/core/model/index.ts'
import { parseProcedureTagValue } from '../src/features/procedures/pack-observations.ts'
import {
  answerProcessPlantQuery, compileProcessPlant, createProcessPlantRampRunner,
  createProcessPlantRuntime, createPwrReferencePlantDefinition,
} from '../src/packs/process-plant/index.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import { processPlantEvidenceFrame } from '../src/packs/process-plant/evidence-frame.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:batch-evidence', loopCount: 4 }))
const at = isoTimestampSchema.parse('2026-10-31T04:00:21.000Z')
const capability = processPlantCapabilities.find(row => row.id === 'world.process-plant.signals.read')!
const fixture = (): ProcessPlantRuntimeInstance => {
  const runtime = createProcessPlantRuntime({ system: plant })
  return { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() }
}
const read = (instance: ProcessPlantRuntimeInstance, input: Record<string, unknown>, simulationTime = at): any => {
  const result = answerProcessPlantQuery({
    request: { capabilityId: capability.id, input: capability.input.parse({ plantId: plant.id, ...input }) },
    plants: new Map([[plant.id, instance]]), objects: new Map(), simulationTime,
  })
  expect(capability.output.parse(result)).toEqual(result)
  return result
}
const paths = [
  ...['A', 'B', 'C', 'D'].map(loop => `auxFeedwaterValve${loop}.effectivePositionFraction`),
  ...['B', 'C'].map(loop => `auxFeedwaterTurbineSteamValve${loop}.effectivePositionFraction`),
  'auxFeedwaterPumpMotor.runningState', 'auxFeedwaterPumpMotorB.runningState', 'auxFeedwaterPumpTurbine.runningState',
  'auxFeedwaterPumpTurbine.speedRpm',
  ...['B', 'C'].map(loop => `auxFeedwaterTurbineSteamValve${loop}.outletFlowKgPerS`), 'auxFeedwaterPumpTurbine.flowKgPerS',
]

test('one canonical evidence frame applies to all thirteen real feedback rows without changing any per-signal facts', () => {
  const instance = fixture()
  const before = instance.runtime.snapshot()
  const signals = paths.map((path, index) => ({ path, ...(index === 0 ? { requestedUnit: 'percent' } : {}) }))
  const plain = read(instance, { signals, observed: true })
  const acquired = read(instance, { signals, observed: true, evidence: true })
  expect(acquired).toEqual({ ...plain, evidence: processPlantEvidenceFrame(instance, at) })
  expect(acquired.signals).toHaveLength(13)
  expect(acquired.signals.map((row: any) => row.variable.path)).toEqual(paths)
  expect(acquired.signals.every((row: any) => row.evidence === undefined)).toBe(true)
  expect(acquired.signals[0].valueView).toMatchObject({ status: 'unavailable', unit: 'fraction', requestedUnit: 'percent' })
  expect(acquired.evidence).not.toHaveProperty('kind')
  expect(acquired.evidence).not.toHaveProperty('sampledAt')
  expect(plain).not.toHaveProperty('evidence')
  expect(instance.runtime.snapshot()).toEqual(before)
})

test('batch identity follows the actual acquired Plant and Run time, with ordered duplicate requests retained', () => {
  const instance = fixture()
  const signals = [{ tagId: 'PT-455' }, { path: 'core.powerMw' }, { tagId: 'PT-455' }]
  const first = read(instance, { signals, evidence: true })
  const later = isoTimestampSchema.parse('2026-10-31T04:00:22.000Z')
  const second = read(instance, { signals, evidence: true }, later)
  expect(first.signals).toHaveLength(3)
  expect(first.signals[0]).toEqual(first.signals[2])
  expect(second.signals).toEqual(first.signals)
  expect(second.evidence).toEqual({ ...first.evidence, simulationTime: later })
  expect(first.evidence.modelDigest).toBe(plant.modelDigest)
  expect(first.evidence.provenance).toBe('runtime-model')
})

test('a common batch frame preserves independent unavailable-quality rows and their original values and units', () => {
  const instance = fixture()
  const snapshotAt = instance.runtime.readVariableSnapshot
  const qualification = plant.graph.components.flatMap(component => component.semantics.meaningfulWhile)[0]!
  expect(qualification).toBeDefined()
  // Test-only failed qualification feedback: the query must retain the
  // declared signal's unavailable quality independently of the batch identity.
  const failed: ProcessPlantRuntimeInstance = { ...instance, runtime: { ...instance.runtime,
    readVariableSnapshot: path => path === qualification.flag ? { ...snapshotAt(path), value: false, canonicalValue: false } : snapshotAt(path),
  } }
  const signals = [{ path: qualification.variables[0] }, { tagId: 'PT-455' }]
  const plain = read(failed, { signals })
  const acquired = read(failed, { signals, evidence: true })
  expect(acquired.signals).toEqual(plain.signals)
  expect(acquired.signals[0].quality.status).toBe('unavailable')
  expect(acquired.signals[1].quality.status).toBe('good')
  expect(acquired.signals[0].quality.reason).toContain('measures nothing unless')
  expect(acquired.signals[0].variable).toEqual(snapshotAt(qualification.variables[0]!))
  expect(acquired.evidence).toEqual(processPlantEvidenceFrame(instance, at))
})

test('evidence requires an acquisition time and the output accepts only the canonical batch contract', () => {
  const instance = fixture()
  const input = { plantId: plant.id, signals: [{ tagId: 'PT-455' }], evidence: true }
  expect(() => answerProcessPlantQuery({ request: { capabilityId: capability.id, input },
    plants: new Map([[plant.id, instance]]), objects: new Map() })).toThrow('needs the Run time')
  const acquired = read(instance, input)
  expect(capability.output.safeParse({ ...acquired, evidence: { ...acquired.evidence, kind: 'engineering-diagnostic' } }).success).toBe(false)
  expect(capability.output.safeParse({ ...acquired, signals: [{ ...acquired.signals[0], evidence: acquired.evidence }] }).success).toBe(false)
  const { simulationTime: _time, ...withoutTime } = acquired.evidence
  expect(capability.output.safeParse({ ...acquired, evidence: withoutTime }).success).toBe(false)
})

test('the shared procedure adapter receives unchanged deciding evidence from the canonical batch, never from a row fallback', () => {
  const instance = fixture()
  const acquired = read(instance, { signals: [{ tagId: 'PT-455' }], evidence: true })
  const parsed = parseProcedureTagValue({ id: 'PT-455' }, acquired)
  const { evidenceKind, simulationTime, ...identity } = acquired.evidence
  expect(parsed.evidence).toEqual({ ...identity, kind: evidenceKind, sampledAt: simulationTime })
  expect(parsed.value).toBe(acquired.signals[0].variable.value)
  expect(parsed.unit).toBe(acquired.signals[0].variable.unit)
  expect(parsed.writable).toBe(acquired.signals[0].signal.writable)
  expect(parsed.quality).toBe(acquired.signals[0].quality.status)
  const plain = read(instance, { signals: [{ tagId: 'PT-455' }] })
  expect(parseProcedureTagValue({ id: 'PT-455' }, plain)).not.toHaveProperty('evidence')
  expect(() => parseProcedureTagValue({ id: 'PT-455' }, { ...plain,
    signals: [{ ...plain.signals[0], evidence: { ...identity, kind: evidenceKind, sampledAt: simulationTime } }] })).toThrow('complete batch')
  for (const evidence of [null, {}, { ...acquired.evidence, evidenceKind: 'assumed' }, { ...acquired.evidence, simulationTime: 'invalid' }]) {
    expect(() => parseProcedureTagValue({ id: 'PT-455' }, { ...plain, evidence })).toThrow()
  }
})
