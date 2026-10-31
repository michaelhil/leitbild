import { describe, expect, test } from 'bun:test'
import { answerProcessPlantQuery, compileProcessPlant, createProcessPlantRampRunner, createProcessPlantRuntime, createProcessPlantProtectionRunner, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { processPlantSignalReferenceSchema } from '../src/packs/process-plant/signals.ts'
import { evaluateProcessPlantProcedureCondition, processPlantProcedureConditionSchema, type ProcessPlantProcedureCondition } from '../src/packs/process-plant/condition-evidence.ts'
import { evaluateProcessPlantAssessments } from '../src/packs/process-plant/assessments.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import { createProcessPlantRecordingPlan } from '../src/packs/process-plant/recording.ts'
import { isoTimestampSchema, objectIdSchema } from '../src/core/model/index.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:procedure-evidence', loopCount: 2 }))
const runtime = createProcessPlantRuntime({ system: compiled })
const plant: ProcessPlantRuntimeInstance = { plant: compiled, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() }
const basis = { modelRef: compiled.modelRef, modelDigest: compiled.modelDigest, source: 'source:apps/world/src/packs/process-plant/specs/pwr-reference-template.graph.json', description: 'A bounded model comparison; no CSF adequacy claim.' }
const power = (value: number, operator: '>' | '<' = '>'): ProcessPlantProcedureCondition => ({ type: 'comparison', signal: processPlantSignalReferenceSchema.parse({ path: 'core.powerMw' }), operator, value, unit: 'MW' })
const missing: ProcessPlantProcedureCondition = { type: 'comparison', signal: processPlantSignalReferenceSchema.parse({ tagId: 'UNINSTALLED-NI' }), operator: '>', value: 0, unit: 'MW' }
const evaluate = (condition: ProcessPlantProcedureCondition, target = plant) => evaluateProcessPlantProcedureCondition({ plant: target, condition, basis })

describe('read-only procedure condition evidence', () => {
  test('retains actual values, native metadata, model identity and simulation time without accepting any actuation', () => {
    const before = runtime.checkpoint()
    const result = evaluate(power(1))
    expect(result).toMatchObject({ status: 'satisfied', modelRef: compiled.modelRef, modelDigest: compiled.modelDigest, simTimeMs: 0, automaticCsfQualified: false, basis: { ...basis, qualification: 'authored-comparison' } })
    expect(result.evidence[0]).toMatchObject({ provenance: 'runtime-model', instrumentationValidity: 'not-established', variable: { path: 'core.powerMw', value: runtime.readVariable(processPlantSignalReferenceSchema.parse({ path: 'core.powerMw' }).path!), unit: 'MW' }, comparison: { operator: '>', value: 1, unit: 'MW' } })
    expect(runtime.checkpoint()).toEqual(before)
  })

  test('factual evidence preserves every comparison decision and the independently acquired native facts', () => {
    const signal = processPlantSignalReferenceSchema.parse({ path: 'core.powerMw' })
    const binding = compiled.graph.signalBindingByPath.get(signal.path!)!
    const snapshot = runtime.readVariableSnapshot(binding.path)
    const actual = Number(snapshot.value)
    const operators = ['<', '<=', '==', '!=', '>=', '>'] as const
    const expected = (operator: typeof operators[number], threshold: number) => operator === '<' ? actual < threshold : operator === '<=' ? actual <= threshold
      : operator === '==' ? actual === threshold : operator === '!=' ? actual !== threshold : operator === '>=' ? actual >= threshold : actual > threshold
    for (const operator of operators) for (const value of [actual - 1, actual, actual + 1]) {
      const result = evaluate({ type: 'comparison', signal, operator, value, unit: 'MW' })
      expect(result.status).toBe(expected(operator, value) ? 'satisfied' : 'challenged')
      expect(result.evidence[0]).toMatchObject({ reference: signal, comparison: { operator, value, unit: 'MW' }, quality: { status: 'good' },
        signal: { path: binding.path, label: binding.label, unit: binding.unit, writable: binding.writable, published: binding.published },
        variable: { path: snapshot.path, value: snapshot.value, canonicalValue: snapshot.canonicalValue, unit: snapshot.unit, writable: snapshot.writable, published: snapshot.published } })
    }
    // Graph and acquired snapshot are independent evidence. A read must not hide
    // a unit or writability disagreement by merging one over the other.
    const changed = { ...plant, runtime: { ...runtime, readVariableSnapshot: (path: Parameters<typeof runtime.readVariableSnapshot>[0]) => ({ ...runtime.readVariableSnapshot(path),
      canonicalValue: 17, unit: 'kW' as const, writable: true, limits: { hardRange: { min: 0, max: 1e9 } } }) } }
    const result = evaluate(power(1), changed)
    expect(result).toMatchObject({ status: 'unknown', evidence: [{ signal: { unit: 'MW', writable: false },
      variable: { value: actual, canonicalValue: 17, unit: 'kW', writable: true, limits: { hardRange: { min: 0, max: 1e9 } } },
      reason: expect.stringContaining('Writable commands/demands') }] })
  })

  test('unknown units, absent bindings and value types cannot become successful comparisons', () => {
    expect(evaluate({ ...power(1), unit: 'percent' } as ProcessPlantProcedureCondition).evidence[0]?.reason).toContain('native signal unit MW')
    expect(evaluate(missing)).toMatchObject({ status: 'unknown', evidence: [{ status: 'unknown', rangeValidity: 'unavailable', quality: { status: 'unavailable', reason: 'Signal is absent from the current Plant graph.' } }] })
    expect(evaluate({ ...power(1), value: true } as ProcessPlantProcedureCondition)).toMatchObject({ status: 'unknown' })
    expect(evaluate({ type: 'not', condition: missing }).status).toBe('unknown')
  })

  test('all, any and voting retain unknown evidence without short-circuiting the observation frame', () => {
    for (const [type, value, expected] of [ ['all', 0, 'unknown'], ['all', 1e9, 'challenged'], ['any', 0, 'satisfied'], ['any', 1e9, 'unknown'] ] as const) {
      const result = evaluate({ type, conditions: [power(value), missing] })
      expect(result.status).toBe(expected)
      expect(result.evidence).toHaveLength(2)
      expect(result.evidence[1]?.status).toBe('unknown')
    }
    expect(evaluate({ type: 'vote', required: 2, conditions: [power(0), power(0), missing] }).status).toBe('satisfied')
    expect(evaluate({ type: 'vote', required: 2, conditions: [power(0), power(1e9), missing] }).status).toBe('unknown')
    expect(evaluate({ type: 'vote', required: 2, conditions: [power(1e9), power(1e9), missing] }).status).toBe('challenged')
  })

  test('changed model or digest withholds evaluation before reading any signal', () => {
    for (const changed of [{ ...basis, modelRef: 'process-plant.ld01.uninstalled' }, { ...basis, modelDigest: 'a'.repeat(64) }]) {
      expect(evaluateProcessPlantProcedureCondition({ plant, condition: power(0), basis: changed })).toMatchObject({ status: 'unknown', evidence: [], reason: expect.stringContaining('does not match') })
    }
  })

  test('an out-of-range reading is unknown rather than a qualified overrange bound', () => {
    // Test-only failed reading; production variable tables reject invalid writes.
    const failed = { ...plant, runtime: { ...runtime, readVariableSnapshot: (path: Parameters<typeof runtime.readVariableSnapshot>[0]) => ({ ...runtime.readVariableSnapshot(path), value: 5000, limits: { hardRange: { min: 0, max: 4000 } } }) } }
    expect(evaluate(power(1), failed)).toMatchObject({ status: 'unknown', evidence: [{ rangeValidity: 'outside-declared-range', instrumentationValidity: 'not-established',
      variable: { value: 5000, limits: { hardRange: { min: 0, max: 4000 } } }, quality: { status: 'outside-hard-range' } }] })
  })

  test('capability binds the canonical target and validates typed input and full output', () => {
    const capability = processPlantCapabilities.find(item => item.id === 'world.process-plant.procedure-condition.evaluate')!
    const input = { targetObjectId: compiled.id, condition: power(0), basis }
    expect(capability.input.parse(input)).toEqual(input)
    expect(capability.inspectObjectIds?.(capability.input.parse(input))).toEqual([objectIdSchema.parse(compiled.id)])
    expect(capability.inspectObjectIds?.({ ...input, targetObjectId: objectIdSchema.parse('plant:other') })).toEqual([objectIdSchema.parse('plant:other')])
    expect(capability.input.safeParse({ ...input, condition: { ...power(0), unit: undefined } }).success).toBe(false)
    expect(processPlantProcedureConditionSchema.safeParse({ type: 'vote', required: 3, conditions: [power(0)] }).success).toBe(false)
    const result = answerProcessPlantQuery({ request: { capabilityId: capability.id, input }, plants: new Map([[compiled.id, plant]]), objects: new Map() })
    expect(capability.output.parse(result)).toMatchObject({ targetObjectId: compiled.id, status: 'satisfied' })
  })

  test('I&C state reads actual rules and latches; missing state, failures and physical command substitutions remain unknown', () => {
    const protection = createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation })
    const current = { ...plant, protection }
    const inactive = { type: 'ic-rule-state', ruleId: 'safety-injection-manual', field: 'active', value: false, source: '../basis.md#si' } as const
    expect(evaluate(inactive, current).status).toBe('satisfied')
    let snapshotReads = 0
    const counted = { ...current, protection: { ...protection, snapshot: () => { snapshotReads++; return protection.snapshot() } } }
    expect(evaluate({ type: 'all', conditions: [inactive, { ...inactive, field: 'latched' }] }, counted).status).toBe('satisfied')
    expect(snapshotReads).toBe(1)
    expect(evaluate({ ...inactive, ruleId: 'UNMODELED-PHASE-B' }, current).status).toBe('unknown')
    expect(evaluate(inactive, plant).status).toBe('unknown')
    const failed = { ...current, protection: { ...protection, snapshot: () => ({ ...protection.snapshot(), failures: [{ ruleId: inactive.ruleId, elapsedMs: 0, message: 'Acquisition failed' }] }) } }
    expect(evaluate(inactive, failed)).toMatchObject({ status: 'unknown', evidence: [{ reason: expect.stringContaining('Acquisition failed') }] })
    expect(evaluate({ type: 'comparison', signal: processPlantSignalReferenceSchema.parse({ tagId: 'SI-PUMP-A' }), operator: '==', value: true, unit: 'boolean' }, current)).toMatchObject({ status: 'unknown', evidence: [{ reason: expect.stringContaining('Writable commands/demands') }] })
    const latched = { ...current, protection: { ...protection, snapshot: () => ({ ...protection.snapshot(), rules: protection.snapshot().rules.map(rule => rule.ruleId === inactive.ruleId ? { ...rule, active: false, latched: true } : rule) }) } }
    expect(evaluate({ ...inactive, field: 'latched', value: true }, latched)).toMatchObject({ status: 'satisfied', evidence: [{ type: 'ic-rule-state', field: 'latched', value: true }] })
  })

  test('critical safety functions are judged by declared reference-model trees that read the actual loops, never as qualified criteria', () => {
    const rows = evaluateProcessPlantAssessments(plant, undefined)
    expect(rows.map(row => row.id)).toEqual(['subcriticality', 'core-cooling', 'heat-sink', 'rcs-integrity', 'containment', 'rcs-inventory'])
    expect(rows.every(row => row.qualification === 'reference-model-criteria' && row.automaticCsfQualified === false)).toBe(true)
    // The two-loop Plant's heat sink reads its two steam generators' levels, not four.
    const heatSink = rows.find(row => row.id === 'heat-sink') as { path: ReadonlyArray<{ comparisons: ReadonlyArray<unknown> }> }
    expect(heatSink.path[0]!.comparisons).toHaveLength(2)
    expect(rows.every(row => row.modelDigest === compiled.modelDigest)).toBe(true)
  })

  test('bounds hostile recursive input before recursive parsing and retains partial failed observation evidence', () => {
    let deep: unknown = power(0)
    for (let index = 0; index < 2000; index++) deep = { type: 'not', condition: deep }
    const parsed = processPlantProcedureConditionSchema.safeParse(deep)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain('32-level input limit')
    const failed = { ...plant, runtime: { ...runtime, readVariableSnapshot: (path: Parameters<typeof runtime.readVariableSnapshot>[0]) => {
      if (String(path) === 'core.effectiveReactivityPcm') throw new Error('Acquisition failed')
      return runtime.readVariableSnapshot(path)
    } } }
    expect(evaluateProcessPlantAssessments(failed, ['core-cooling'])[0]).toMatchObject({ status: 'green' })
    const reactivity: ProcessPlantProcedureCondition = { type: 'comparison', signal: processPlantSignalReferenceSchema.parse({ path: 'core.effectiveReactivityPcm' }), operator: '<', value: 0, unit: 'pcm' }
    const frame = evaluate({ type: 'all', conditions: [reactivity, power(1e9)] }, failed)
    expect(frame).toMatchObject({ status: 'challenged', evidence: [{ status: 'unknown', rangeValidity: 'unavailable', reason: 'Acquisition failed', quality: { status: 'unavailable', reason: 'Acquisition failed' } }, { status: 'challenged', variable: { unit: 'MW' } }] })
  })

  test('recording preserves a declared range failure instead of marking every sample good', () => {
    const failed = { ...plant, runtime: { ...runtime, readVariableSnapshotHandle: (handle: Parameters<typeof runtime.readVariableSnapshotHandle>[0]) => ({ ...runtime.readVariableSnapshotHandle(handle), ...(String(handle.path) === 'core.powerMw' ? { value: 5000, limits: { hardRange: { min: 0, max: 4000 } } } : {}) }) } }
    const plan = createProcessPlantRecordingPlan({ selection: { packId: 'process-plant', profileId: 'operations' }, plants: new Map([[compiled.id, failed]]), unitLabels: new Map([[compiled.id, 'Test Unit']]) })
    const timestamp = isoTimestampSchema.parse('2026-10-02T10:00:00.000Z')
    const descriptor = plan.descriptors.find(row => row.signalId === 'core.powerMw')!
    const batch = plan.sample({ observedAt: timestamp, simulationTime: timestamp })
    expect(batch.samples.find(row => row.seriesId === descriptor.id)).toMatchObject({ value: 5000, quality: 'bad', elapsedMs: 0, observedAt: timestamp, simulationTime: timestamp })
    expect(batch.samples.some(row => row.quality === 'good')).toBe(true)
  })
})
