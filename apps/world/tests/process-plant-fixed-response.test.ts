import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createProcessPlantRampRunner, createProcessPlantRuntime, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { evaluateProcessPlantProcedureCondition, type ProcessPlantProcedureCondition } from '../src/packs/process-plant/condition-evidence.ts'
import { evaluateProcessPlantResponse, processPlantResponseQuerySchema } from '../src/packs/process-plant/response-evidence.ts'
import { createPlantOperations } from '../src/packs/process-plant/operations/plant-operations.ts'
import { processPlantSignalReferenceSchema, readableProcessPlantSignalBinding, type ProcessPlantSignalReference } from '../src/packs/process-plant/signals.ts'
import { processPlantSimRuntimeId } from '../src/packs/process-plant/sim/constants.ts'
import { objectIdSchema, recordingSeriesIdFor, type IsoTimestamp, type RecordedSample } from '../src/core/model/index.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()
const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:fixed-response', loopCount: 2 }))
const basis = { modelRef: compiled.modelRef, modelDigest: compiled.modelDigest, source: 'fixed-response-test.md', description: 'Test-only finite sampled response.' }
const epoch = Date.parse('2026-10-30T04:00:00.000Z')
const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString() as IsoTimestamp
const pressure = processPlantSignalReferenceSchema.parse({ tagId: 'SG-A-PRESS' }), radiation = processPlantSignalReferenceSchema.parse({ tagId: 'SG-A-N16' })
const auto = processPlantSignalReferenceSchema.parse({ tagId: 'TURB-BYP-AUTO' }), target = processPlantSignalReferenceSchema.parse({ tagId: 'TURB-BYP-SP' })
const flow = processPlantSignalReferenceSchema.parse({ path: 'condenser.coolingWaterFlowKgPerS' })
const conditions: ReadonlyArray<ProcessPlantProcedureCondition> = [
  { type: 'comparison', signal: pressure, operator: '>', value: 0, unit: 'MPa' },
  { type: 'comparison', signal: radiation, operator: '<=', value: 0.03, unit: 'mSv/h' },
  { type: 'comparison', signal: flow, operator: '>=', value: 0, unit: 'kg/s' },
  { type: 'setting', signal: auto, operator: '==', value: true, unit: 'boolean' },
  { type: 'setting', signal: target, operator: '>=', value: 0, unit: 'MPa' },
]
const fixture = (startingConditions = conditions) => {
  const runtime = createProcessPlantRuntime({ system: compiled })
  const operations = createPlantOperations({ graph: compiled.graph })
  const plant: ProcessPlantRuntimeInstance = { plant: compiled, runtime, operations,
    ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() }
  runtime.tick(5000)
  const startingCondition: ProcessPlantProcedureCondition = { type: 'all', conditions: startingConditions }
  const start = { targetObjectId: compiled.id, ...evaluateProcessPlantProcedureCondition({ plant, condition: startingCondition, basis, simulationTime: at(5) }) }
  runtime.tick(10_000)
  const input = processPlantResponseQuerySchema.parse({ targetObjectId: compiled.id, basis, condition: { type: 'all', conditions },
    startingCondition, startingObservation: start, windowSeconds: 5,
    comparisons: [{ signal: pressure, statistic: 'minimum', operator: '>', value: 0, unit: 'MPa' },
      { signal: radiation, statistic: 'maximum', operator: '<=', value: 0.03, unit: 'mSv/h' }],
    unchangedSettings: [{ signal: auto, unit: 'boolean' }, { signal: target, unit: 'MPa' }] })
  const rows = new Map<string, RecordedSample[]>()
  const add = (signal: ProcessPlantSignalReference, seconds: number, value?: number | boolean) => {
    const binding = readableProcessPlantSignalBinding(compiled.graph, signal)
    const seriesId = recordingSeriesIdFor(compiled.id, binding.path)
    const values = rows.get(seriesId) ?? []
    values.push({ runtimeId: processPlantSimRuntimeId, seriesId, sequence: values.length + 1,
      observedAt: at(seconds), simulationTime: at(seconds), elapsedMs: seconds * 1000,
      value: value ?? runtime.readVariable(binding.path), quality: 'good' })
    rows.set(seriesId, values.sort((a, b) => Date.parse(a.simulationTime!) - Date.parse(b.simulationTime!)).map((row, index) => ({ ...row, sequence: index + 1 })))
  }
  for (const signal of [pressure, radiation, auto, target]) { add(signal, 0); add(signal, 9); add(signal, 15) }
  const evaluate = (override: Partial<typeof input> = {}) => evaluateProcessPlantResponse({ plant, input: { ...input, ...override }, simulationTime: at(15),
    recordingIntervalMs: 1000, recordedSeriesIds: new Set(rows.keys()), recordedHistory: { read: query => (rows.get(query.seriesId) ?? [])
      .filter(row => row.simulationTime! >= query.from && row.simulationTime! <= query.to).slice(-query.limit) } })
  return { plant, input, start, add, rows, evaluate }
}

describe('procedure-anchored sampled response', () => {
  test('uses the original native acquisition instead of an older exception-record point', () => {
    const f = fixture()
    f.add(pressure, 3, -1)
    const response = f.evaluate()
    expect(response.status).toBe('satisfied')
    expect(response.recordings[0]).toMatchObject({ requestedFrom: at(5), first: { simulationTime: at(5), elapsedMs: 5000 },
      originalAcquisitionIncluded: true, integratedSpanSeconds: 10 })
    expect(response.current).toMatchObject({ targetObjectId: compiled.id, status: 'satisfied' })
  })

  test('a failed radiation point cannot roll out of the interval while the agent waits', () => {
    const f = fixture()
    f.add(radiation, 6, 0.04)
    const fixed = f.evaluate()
    expect(fixed.status).toBe('challenged')
    expect(fixed.evidence).toContainEqual(expect.objectContaining({ status: 'challenged', actual: 0.04 }))
    const { startingObservation: _start, unchangedSettings: _settings, ...rolling } = f.input
    const unanchored = evaluateProcessPlantResponse({ plant: f.plant, input: rolling, simulationTime: at(15), recordingIntervalMs: 1000,
      recordedSeriesIds: new Set(f.rows.keys()), recordedHistory: { read: query => (f.rows.get(query.seriesId) ?? []).filter(row => row.simulationTime! >= query.from && row.simulationTime! <= query.to).sort((a, b) => a.sequence - b.sequence) } })
    expect(unanchored.status).toBe('satisfied')
  })

  test('wrong scope, definition, time, incomplete starting condition and frozen time cannot qualify', () => {
    const f = fixture()
    for (const changed of [{ targetObjectId: objectIdSchema.parse('plant:other') }, { modelDigest: 'a'.repeat(64) }, { automationDigest: 'a'.repeat(64) },
      { simulationTime: at(16) }, { simTimeMs: 16_000 }, { status: 'challenged' as const }]) {
      expect(f.evaluate({ startingObservation: { ...f.input.startingObservation!, ...changed } }).status).toBe('unknown')
    }
    expect(f.evaluate({ startingCondition: undefined }).status).toBe('unknown')
    expect(f.evaluate({ startingObservation: { ...f.input.startingObservation!, simulationTime: at(15), simTimeMs: 15_000 } })).toMatchObject({ status: 'unknown', reason: expect.stringContaining('duration') })
    const incomplete = fixture(conditions.filter(condition => !('signal' in condition) || condition.signal !== radiation))
    const missing = incomplete.evaluate()
    expect(missing.status).toBe('unknown')
    expect(missing.evidence).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('original starting acquisition') }))
  })

  test('unrecorded endpoint flow must exist in both native acquisitions', () => {
    const f = fixture(conditions.filter(condition => !('signal' in condition) || condition.signal !== flow))
    expect(f.evaluate({ startingCondition: { type: 'all', conditions } })).toMatchObject({ status: 'unknown', reason: expect.stringContaining('original starting acquisition') })
    const complete = fixture()
    expect(complete.evaluate().status).toBe('satisfied')
    expect(complete.rows.has(recordingSeriesIdFor(compiled.id, readableProcessPlantSignalBinding(compiled.graph, flow).path))).toBe(false)
  })

  test('changed and restored setting operations fail even at the same paused simulation time', () => {
    const f = fixture(), binding = readableProcessPlantSignalBinding(compiled.graph, auto)
    for (const [index, value] of [false, true].entries()) f.plant.operations!.record({ commandId: `command:setting-${index}`, path: binding.path,
      value, origin: 'person', actorId: 'person:operator', elapsedMs: 5000, kind: 'write' }, { elapsedMs: 5000, wallMs: epoch })
    const response = f.evaluate()
    expect(response.status).toBe('challenged')
    expect(response.evidence).toContainEqual(expect.objectContaining({ status: 'challenged', reason: expect.stringContaining('operation identity') }))
  })

  test('a recorded setting excursion fails after current configuration is restored; absent recording is unknown', () => {
    const f = fixture()
    f.add(auto, 6, false)
    const response = f.evaluate()
    expect(response.status).toBe('challenged')
    expect(response.evidence).toContainEqual(expect.objectContaining({ status: 'challenged', reason: expect.stringContaining('differs from its original') }))
    const missing = fixture(), binding = readableProcessPlantSignalBinding(compiled.graph, target)
    missing.rows.delete(recordingSeriesIdFor(compiled.id, binding.path))
    expect(missing.evaluate().status).toBe('unknown')
  })
})
