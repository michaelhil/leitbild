import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createProcessPlantRampRunner, createProcessPlantRuntime, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { evaluateProcessPlantResponse, processPlantResponseQuerySchema } from '../src/packs/process-plant/response-evidence.ts'
import { createProcessPlantRecordingPlan } from '../src/packs/process-plant/recording.ts'
import { createRunHistorian, recordedHistoryOf } from '../src/features/historian/store.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import { answerProcessPlantQuery } from '../src/packs/process-plant/query.ts'
import { recordingSeriesIdFor, type IsoTimestamp, type RecordedSample } from '../src/core/model/index.ts'
import { guardPlantTests } from './plant-hang-guard.ts'
import { processPlantSimRuntimeId } from '../src/packs/process-plant/sim/constants.ts'
import { createPlantOperations, OPERATIONS_KEPT, type OperationRecord } from '../src/packs/process-plant/operations/plant-operations.ts'
import { processSignalTagIdSchema } from '../src/packs/process-plant/graph/index.ts'
import { variablePathSchema } from '../src/packs/process-plant/graph/index.ts'
import { evaluateProcessPlantProcedureCondition } from '../src/packs/process-plant/condition-evidence.ts'

guardPlantTests()
const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:sampled-response', loopCount: 2 }))
const epoch = Date.parse('2026-10-30T04:00:00.000Z')
const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString() as IsoTimestamp
const instance = (): ProcessPlantRuntimeInstance => {
  const runtime = createProcessPlantRuntime({ system: compiled })
  return { plant: compiled, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() }
}
const plant = instance()
plant.runtime.tick(120_000)
const path = compiled.graph.signalBindingByTagId.get(processSignalTagIdSchema.parse('SG-A-PRESS'))!.path
const value = Number(plant.runtime.readVariable(path))
const seriesId = recordingSeriesIdFor(compiled.id, path)
const input = processPlantResponseQuerySchema.parse({
  targetObjectId: compiled.id,
  basis: { modelRef: compiled.modelRef, modelDigest: compiled.modelDigest, source: 'sampled-response-basis.md#exercise', description: 'Test-only sampled envelope; not a continuous hold.' },
  condition: { type: 'comparison', signal: { tagId: 'SG-A-PRESS' }, operator: '>', value: 0, unit: 'MPa' },
  windowSeconds: 120,
  comparisons: [{ signal: { tagId: 'SG-A-PRESS' }, statistic: 'minimum', operator: '>', value: 0, unit: 'MPa' }],
})
const sample = (seconds: number, measured = value, sequence = seconds + 1): RecordedSample => ({
  runtimeId: processPlantSimRuntimeId, seriesId, sequence, observedAt: at(seconds), simulationTime: at(seconds), elapsedMs: seconds * 1000, value: measured, quality: 'good',
})
const config = (samples: ReadonlyArray<RecordedSample> = [sample(0), sample(60), sample(120)]) => ({
  plant, input, simulationTime: at(120), recordingIntervalMs: 1000, recordedSeriesIds: new Set([seriesId]), recordedHistory: { read: () => samples },
})
/** Test fixture supplies both current receipt index and recent presentation log explicitly. */
const operationsFrom = (log: ReadonlyArray<OperationRecord>) => createPlantOperations({ graph: compiled.graph,
  restored: { log: [...log], latestByPath: [...new Map(log.map(record => [record.path, record])).values()], proposals: [] } })

describe('explicitly sampled Plant response', () => {
  test('retains endpoint, envelope, timestamps, compression and current proof without changing physical state', () => {
    const before = plant.runtime.checkpoint()
    const response = evaluateProcessPlantResponse(config())
    expect(response.status).toBe('satisfied')
    expect(response.interpretation).toContain('no uninterrupted hold')
    expect(response.recordings[0]).toMatchObject({ storedSampleCount: 3, sampleTimestampOrigin: at(0), sampleOffsetsMs: [0, 60_000, 120_000], maximumGapMs: 60_000,
      minimum: value, maximum: value, change: 0, elapsedSeconds: 120, endpointRatePerSecond: 0, recordingRelativeDeadband: 1e-5,
      first: { simulationTime: at(0), elapsedMs: 0, value }, current: { simulationTime: at(120), elapsedMs: 120_000, value } })
    expect(response.current.status).toBe('satisfied')
    const recorded = response.recordings[0]!
    expect((recorded.sampleOffsetsMs as number[]).map(offset => new Date(Date.parse(String(recorded.sampleTimestampOrigin)) + offset).toISOString())).toEqual([at(0), at(60), at(120)])
    const raw = evaluateProcessPlantProcedureCondition({ plant, condition: input.condition, basis: input.basis, simulationTime: at(120) })
    const original = raw.evidence[0]!
    if (!('variable' in original) || original.variable === undefined) throw new Error('Expected the actual acquired physical leaf')
    expect(response.current.evidence[0]).toMatchObject({ comparison: original.comparison, reference: original.reference, status: original.status,
      rangeValidity: original.rangeValidity, variable: { path: original.variable.path, value: original.variable.value, canonicalValue: original.variable.canonicalValue,
        unit: original.variable.unit, writable: original.variable.writable } })
    expect(plant.runtime.checkpoint()).toEqual(before)
  })

  test('a middle contradiction cannot be erased by green endpoints; change uses the physical current endpoint', () => {
    const minimum = evaluateProcessPlantResponse(config([sample(0), sample(60, -1), sample(120)]))
    expect(minimum.status).toBe('challenged')
    const changed = { ...input, comparisons: [{ ...input.comparisons[0]!, statistic: 'change' as const, operator: '>' as const, value: 0 }] }
    const response = evaluateProcessPlantResponse({ ...config([sample(0, value - 1), sample(60), sample(120)]), input: changed })
    expect(response.status).toBe('satisfied')
    expect(response.evidence[0]).toMatchObject({ actual: 1 })
    expect(response.recordings[0]).toMatchObject({ change: 1, endpointRatePerSecond: 1 / 120 })
  })

  test('a fresh paused sample does not accumulate duration or make a missing recording into evidence', () => {
    const fresh = instance()
    for (let read = 0; read < 3; read++) expect(evaluateProcessPlantResponse({ ...config(), plant: fresh, simulationTime: at(0) })).toMatchObject({ status: 'unknown', reason: expect.stringContaining('not accumulated') })
    expect(evaluateProcessPlantResponse({ plant, input, simulationTime: at(120) })).toMatchObject({ status: 'unknown', reason: expect.stringContaining('active Plant recording') })
    expect(evaluateProcessPlantResponse({ ...config(), recordedSeriesIds: new Set() })).toMatchObject({ status: 'unknown', evidence: [{ reason: expect.stringContaining('not selected') }] })
  })

  test('ordinary Run-time remainders use the authored integration step rather than assuming elapsed and acquired clocks coincide', () => {
    const partial = instance()
    partial.runtime.tick(120_043)
    const rows = [{ ...sample(0), simulationTime: at(0.011) }, { ...sample(60), simulationTime: at(60.057) }, { ...sample(120), simulationTime: at(120.043) }]
    const response = evaluateProcessPlantResponse({ ...config(rows), plant: partial, simulationTime: at(120.043) })
    expect(response.status).toBe('satisfied')
    expect(response.recordings[0]).toMatchObject({ integratedSpanSeconds: 120, first: { simulationTime: at(0.011) }, current: { simulationTime: at(120.043), elapsedMs: 120_000 } })
    const bad = rows.map(row => ({ ...row, simulationTime: at((row.elapsedMs! + compiled.graph.timestep.fixedStepMs + 1000) / 1000) }))
    expect(evaluateProcessPlantResponse({ ...config(bad), plant: partial, simulationTime: at(120.043) }).status).toBe('unknown')
  })

  test('missing left boundary and long silence stay unknown even with a fresh green endpoint', () => {
    expect(evaluateProcessPlantResponse(config([sample(60), sample(120)]))).toMatchObject({ status: 'unknown', evidence: [{ reason: expect.stringContaining('left boundary') }] })
    expect(evaluateProcessPlantResponse(config([sample(0), sample(120)]))).toMatchObject({ status: 'unknown', evidence: [{ reason: expect.stringContaining('unresolved response gap') }] })
    const retainedBefore = evaluateProcessPlantResponse({ ...config([sample(0), sample(60), sample(120)]), input: { ...input, windowSeconds: 100 } })
    expect(retainedBefore.status).toBe('satisfied')
    expect(retainedBefore.recordings[0]).toMatchObject({ requestedFrom: at(20), first: { simulationTime: at(0) }, elapsedSeconds: 120 })
    const outside = evaluateProcessPlantResponse({ ...config([{ ...sample(0), quality: 'bad' }, sample(60), sample(120)]), input: { ...input, windowSeconds: 60 } })
    expect(outside.status).toBe('satisfied')
    expect(outside.recordings[0]).toMatchObject({ first: { simulationTime: at(60) }, storedSampleCount: 2 })
  })

  test('bad quality, mixed runtime identity, wrong series, reversed time and foreign elapsed epoch are not a sampled trajectory', () => {
    const variants = [
      [sample(0), { ...sample(60), quality: 'bad' as const }, sample(120)],
      [sample(0), { ...sample(60), runtimeId: 'other-runtime' }, sample(120)],
      [sample(0), sample(60), sample(120)].map(row => ({ ...row, runtimeId: 'wrong-only-runtime' })),
      [sample(0), { ...sample(60), seriesId: 'series:other' }, sample(120)],
      [sample(0), sample(80, value, 61), sample(60, value, 81), sample(120)],
      [sample(0), { ...sample(60), elapsedMs: 10_000 }, sample(120)],
    ]
    for (const rows of variants) expect(evaluateProcessPlantResponse(config(rows)).status).toBe('unknown')
    expect(evaluateProcessPlantResponse({ ...config(), input: { ...input, basis: { ...input.basis, modelDigest: 'a'.repeat(64) } } })).toMatchObject({ status: 'unknown', evidence: [] })
  })

  test('command-relative response cannot borrow an improvement before the required accepted operation', () => {
    const control = compiled.graph.signalBindingByTagId.get(processSignalTagIdSchema.parse('SG-A-ARV-SP'))!
    const demand = Number(plant.runtime.readVariable(control.path))
    const receipt = { commandId: 'command:human-before-handoff', path: control.path, value: demand, origin: 'person' as const, actorId: 'person:operator', elapsedMs: 30_000, kind: 'write' as const }
    const operations = operationsFrom([receipt])
    const anchored = { ...input, windowSeconds: 60, afterOperations: [{ signal: { tagId: control.tagId! }, value: demand, unit: control.unit }],
      comparisons: [{ ...input.comparisons[0]!, statistic: 'change' as const, operator: '>' as const, value: 0 }] }
    const beforeActionOnly = [sample(0, value - 1), sample(90), sample(120)]
    const { afterOperations: _anchors, ...unanchored } = anchored
    expect(evaluateProcessPlantResponse({ ...config(beforeActionOnly), input: unanchored }).status).toBe('satisfied')
    expect(evaluateProcessPlantResponse({ ...config(beforeActionOnly), plant: { ...plant, operations }, input: anchored })).toMatchObject({ status: 'unknown', evidence: [{ reason: expect.stringContaining('left boundary') }] })
    const afterAction = evaluateProcessPlantResponse({ ...config([sample(0, value - 1), sample(60, value - 0.25), sample(120)]), plant: { ...plant, operations }, input: anchored })
    expect(afterAction.status).toBe('satisfied')
    expect(afterAction.evidence[0]).toMatchObject({ actual: 0.25 })
    expect(afterAction.recordings[0]).toMatchObject({ first: { simulationTime: at(60) }, notBeforeSimulationTime: at(30) })
    expect(afterAction.afterOperations).toMatchObject([{ receipt: { commandId: receipt.commandId, origin: 'person' } }])
    expect(evaluateProcessPlantResponse({ ...config(), plant: { ...plant, operations }, input: { ...anchored, windowSeconds: 120 } })).toMatchObject({ status: 'unknown', reason: expect.stringContaining('after all required') })
  })

  test('every latest required control receipt must match; an older matching write, unavailable log or ramp target is not an anchor', () => {
    const control = compiled.graph.signalBindingByTagId.get(processSignalTagIdSchema.parse('SG-A-ARV-SP'))!
    const demand = Number(plant.runtime.readVariable(control.path))
    const receipt = { commandId: 'command:target', path: control.path, value: demand, origin: 'ai' as const, actorId: 'agent:operator', elapsedMs: 0, kind: 'write' as const }
    const anchored = { ...input, afterOperations: [{ signal: { tagId: control.tagId! }, value: demand, unit: control.unit }] }
    for (const operations of [undefined, operationsFrom([receipt, { ...receipt, value: demand + 1, elapsedMs: 10_000 }]), operationsFrom([{ ...receipt, kind: 'ramp' }])]) {
      expect(evaluateProcessPlantResponse({ ...config(), plant: { ...plant, ...(operations === undefined ? {} : { operations }) }, input: anchored })).toMatchObject({ status: 'unknown', reason: expect.stringContaining('latest retained accepted') })
    }
    const operations = operationsFrom([receipt])
    const two = processPlantResponseQuerySchema.parse({ ...anchored, afterOperations: [...anchored.afterOperations, { signal: { tagId: 'SG-B-ARV-SP' }, value: demand, unit: control.unit }] })
    expect(evaluateProcessPlantResponse({ ...config(), plant: { ...plant, operations }, input: two }).status).toBe('unknown')
  })

  test('a human intervention remains response evidence after unrelated recent-log eviction and restore', () => {
    const control = compiled.graph.signalBindingByTagId.get(processSignalTagIdSchema.parse('SG-A-ARV-SP'))!
    const unrelated = compiled.graph.signalBindingByTagId.get(processSignalTagIdSchema.parse('SG-B-ARV-SP'))!
    const demand = Number(plant.runtime.readVariable(control.path))
    const receipt: OperationRecord = { commandId: 'command:human-handoff', path: control.path, value: demand, origin: 'person', actorId: 'person:operator', elapsedMs: 0, kind: 'write' }
    const operations = createPlantOperations({ graph: compiled.graph })
    operations.record(receipt, { elapsedMs: 0, wallMs: epoch })
    for (let index = 0; index <= OPERATIONS_KEPT; index++) operations.record({ ...receipt, commandId: `command:unrelated-${index}`, path: unrelated.path, elapsedMs: index + 1 }, { elapsedMs: index + 1, wallMs: epoch + index + 1 })
    expect(operations.log().some(row => row.commandId === receipt.commandId)).toBe(false)
    const restored = createPlantOperations({ graph: compiled.graph, restored: operations.snapshot()! })
    const anchored = { ...input, windowSeconds: 60, afterOperations: [{ signal: { tagId: control.tagId! }, value: demand, unit: control.unit }] }
    const proof = evaluateProcessPlantResponse({ ...config(), plant: { ...plant, operations: restored }, input: anchored })
    expect(proof.status).toBe('satisfied')
    expect(proof.afterOperations).toMatchObject([{ receipt: { commandId: receipt.commandId, actorId: 'person:operator', origin: 'person' } }])
    restored.record({ ...receipt, commandId: 'command:newer-contrary-target', value: demand + 1, elapsedMs: 1000 }, { elapsedMs: 1000, wallMs: epoch + 1000 })
    expect(evaluateProcessPlantResponse({ ...config(), plant: { ...plant, operations: restored }, input: anchored })).toMatchObject({ status: 'unknown', reason: expect.stringContaining('latest retained accepted') })
  })

  test('commands and nonnative units cannot qualify response; hidden fault truth is refused', () => {
    const units = { ...input, comparisons: [{ ...input.comparisons[0]!, unit: 'percent' as const }] }
    expect(evaluateProcessPlantResponse({ ...config(), input: units })).toMatchObject({ status: 'unknown', evidence: [{ reason: expect.stringContaining('native signal unit') }] })
    const command = processPlantResponseQuerySchema.parse({ ...input, comparisons: [{ ...input.comparisons[0]!, signal: { tagId: 'SG-A-ARV' }, unit: 'fraction' }] })
    expect(evaluateProcessPlantResponse({ ...config(), input: command })).toMatchObject({ status: 'unknown', evidence: [{ reason: expect.stringContaining('Writable commands') }] })
    const fault = processPlantResponseQuerySchema.parse({ ...input, comparisons: [{ ...input.comparisons[0]!, signal: { path: 'vessel.primaryLeakFlowKgPerS' }, unit: 'kg/s' }] })
    expect(() => evaluateProcessPlantResponse({ ...config(), input: fault })).toThrow('not a reading')
  })

  test('a currently unpowered indication stays unknown even when its private numeric value and retained response are positive', () => {
    const channel = variablePathSchema.parse('deltaTChannelA.deltaTC')
    const supply = variablePathSchema.parse('deltaTChannelA.supplyAvailable')
    const failed = { ...plant, runtime: { ...plant.runtime, readVariableSnapshot: (path: typeof channel) => {
      const snapshot = plant.runtime.readVariableSnapshot(path)
      return path === supply ? { ...snapshot, value: false, canonicalValue: false } : snapshot
    } } }
    const reading = Number(plant.runtime.readVariable(channel))
    expect(reading).toBeGreaterThan(0)
    const selected = processPlantResponseQuerySchema.parse({ ...input, comparisons: [{ signal: { path: channel }, statistic: 'minimum', operator: '>', value: 0, unit: 'degC' }] })
    const response = evaluateProcessPlantResponse({ ...config(), plant: failed, input: selected, recordedSeriesIds: new Set([recordingSeriesIdFor(compiled.id, channel)]) })
    expect(response.status).toBe('unknown')
    expect(response.evidence[0]).toMatchObject({ status: 'unknown', reason: expect.stringContaining('supply') })
    expect(Number(failed.runtime.readVariable(channel))).toBe(reading)
  })

  test('public discovery, target inspection and strict output validation preserve the sampled proof', () => {
    const capability = processPlantCapabilities.find(candidate => candidate.id === 'world.process-plant.response.evaluate')!
    expect(capability.inspectObjectIds?.(input).map(String)).toEqual([String(compiled.id)])
    expect(capability.input.safeParse({ ...input, extra: true }).success).toBe(false)
    expect(capability.output.parse(answerProcessPlantQuery({ ...config(), request: { capabilityId: capability.id, input }, plants: new Map([[compiled.id, plant]]), objects: new Map() }))).toMatchObject({ status: 'satisfied', targetObjectId: compiled.id })
    expect(capability.output.parse(evaluateProcessPlantResponse(config([sample(60)])))).toMatchObject({ status: 'unknown' })
  })

  test('many authored comparisons share one retained signal window without a comparison quota or repeated sample payload', () => {
    let reads = 0
    const repeated = processPlantResponseQuerySchema.parse({ ...input, comparisons: Array.from({ length: 300 }, () => input.comparisons[0]!) })
    const response = evaluateProcessPlantResponse({ ...config(), input: repeated, recordedHistory: { read: () => { reads++; return [sample(0), sample(60), sample(120)] } } })
    expect(response.status).toBe('satisfied')
    expect(response.evidence).toHaveLength(300)
    expect(response.recordings).toHaveLength(1)
    expect(reads).toBe(1)
    const expanded = { ...response, recordings: undefined, afterOperations: undefined,
      evidence: response.evidence.map(row => ({ ...response.recordings[Number(row.recordingIndex)], ...row, afterOperations: response.afterOperations })) }
    expect(JSON.stringify(response).length).toBeLessThan(JSON.stringify(expanded).length)
  })

  test('actual operations-profile samples survive historian restoration and remain explicitly sampled', () => {
    const live = instance()
    const history = createRunHistorian(':memory:')
    try {
      const plan = createProcessPlantRecordingPlan({ selection: { packId: 'process-plant', profileId: 'operations' }, plants: new Map([[compiled.id, live]]), unitLabels: new Map([[compiled.id, 'Recorded test unit']]) })
      history.record(processPlantSimRuntimeId, { descriptors: [...plan.descriptors], samples: [] })
      for (const seconds of [0, 60, 120]) {
        if (seconds > live.runtime.elapsedMs() / 1000) live.runtime.tick(seconds * 1000 - live.runtime.elapsedMs())
        history.record(processPlantSimRuntimeId, plan.sample({ observedAt: at(seconds), simulationTime: at(seconds) }))
      }
      const checkpoint = live.runtime.checkpoint()
      const restoredRuntime = createProcessPlantRuntime({ system: compiled, restoredCheckpoint: checkpoint })
      const restored = { ...live, runtime: restoredRuntime }
      const response = evaluateProcessPlantResponse({ ...config(), plant: restored, recordedSeriesIds: new Set(history.listSeries().map(series => series.id)), recordedHistory: recordedHistoryOf(history, processPlantSimRuntimeId) })
      expect(response.status).toBe('satisfied')
      expect(response.recordings[0]).toMatchObject({ first: { simulationTime: at(0) }, current: { simulationTime: at(120) } })
      expect(restoredRuntime.checkpoint()).toEqual(checkpoint)
    } finally { history.close() }
  })
})
