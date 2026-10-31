import { describe, expect, test } from 'bun:test'
import { decodeProcessPlantSampleTimeRuns, encodeProcessPlantSampleTimeRuns, processPlantSampleTimeRunSchema, normalizeProcessPlantProcedureEvidence, expandProcessPlantProcedureEvidence, readProcessPlantProcedureEvidence, type ProcessPlantProcedureEvidenceFrame } from '../src/packs/process-plant/procedure-evidence-facts.ts'
import type { ProcessPlantProcedureEvidence, ProcessPlantProcedureIcEvidence } from '../src/packs/process-plant/condition-evidence.ts'
import { variablePathSchema } from '../src/packs/process-plant/graph/index.ts'

describe('frame-local complete acquired facts', () => {
  const path = variablePathSchema.parse('pressure.value')
  const base: ProcessPlantProcedureEvidence = {
    reference: { path }, signal: { path, label: 'Measured pressure', unit: 'MPa', writable: false, published: true, limits: { hardRange: { min: 0, max: 20 } } },
    variable: { path, value: 10, canonicalValue: 10, unit: 'MPa', writable: false, published: true, limits: { hardRange: { min: 0, max: 20 } } },
    quality: { status: 'good' }, rangeValidity: 'within-declared-range', provenance: 'runtime-model', instrumentationValidity: 'not-established',
    comparison: { operator: '<', value: 11, unit: 'MPa' }, status: 'satisfied',
  }

  test('shares identical acquisitions while preserving every comparison and independent metadata disagreement exactly', () => {
    const rows: ProcessPlantProcedureEvidence[] = [base, { ...base, comparison: { operator: '>=', value: 11, unit: 'MPa' }, status: 'challenged' },
      { ...base, variable: { ...base.variable!, canonicalValue: 0.01, unit: 'Pa', writable: true }, status: 'unknown', reason: 'Acquired unit and writability disagree.' },
      { ...base, signal: { ...base.signal!, simulatorOnly: true } },
      { ...base, quality: { status: 'unavailable', reason: 'No supply' }, status: 'unknown', reason: 'No supply' },
      { ...base, variable: { ...base.variable!, limits: { hardRange: { min: 0, max: 5 } } }, rangeValidity: 'outside-declared-range', status: 'unknown' },
      { ...base, signal: { ...base.signal!, label: 'Another declared label' } },
    ]
    const frame = normalizeProcessPlantProcedureEvidence(rows)
    expect(frame.readings).toHaveLength(rows.length - 1)
    expect(frame.evidence.map(row => 'readingIndex' in row ? row.readingIndex : undefined)).toEqual([0, 0, 1, 2, 3, 4, 5])
    expect(expandProcessPlantProcedureEvidence(frame)).toEqual(rows)
    expect(frame.readings[1]).toMatchObject({ signal: { unit: 'MPa', writable: false }, variable: { canonicalValue: 0.01, unit: 'Pa', writable: true } })
  })

  test('missing identities and unavailable acquisitions remain present; I&C state leaves remain unchanged', () => {
    const { variable: _variable, ...withoutVariable } = base
    const unavailable: ProcessPlantProcedureEvidence = { ...withoutVariable, quality: { status: 'unavailable', reason: 'Acquisition failed' },
      rangeValidity: 'unavailable', status: 'unknown', reason: 'Acquisition failed' }
    const { signal: _signal, ...withoutSignal } = unavailable
    const missingA: ProcessPlantProcedureEvidence = { ...withoutSignal, reference: { path: variablePathSchema.parse('uninstalled.a') } }
    const missingB: ProcessPlantProcedureEvidence = { ...missingA, reference: { path: variablePathSchema.parse('uninstalled.b') } }
    const ic: ProcessPlantProcedureIcEvidence = { type: 'ic-rule-state', ruleId: 'safety-injection-manual', field: 'latched', expected: false, value: true, source: 'source.md#si', status: 'challenged' }
    const rows = [unavailable, missingA, missingB, ic]
    const frame = normalizeProcessPlantProcedureEvidence(rows)
    expect(frame.readings).toHaveLength(3)
    expect(frame.readings[1]?.unresolvedReference).toEqual(missingA.reference)
    expect(frame.readings[2]?.unresolvedReference).toEqual(missingB.reference)
    expect(frame.evidence[3]).toBe(ic)
    expect(expandProcessPlantProcedureEvidence(frame)).toEqual(rows)
  })

  test('deduplication never conflates distinct nonfinite acquisitions or signed zero', () => {
    const rows = [NaN, Infinity, -Infinity, -0, 0].map(value => ({ ...base, variable: { ...base.variable!, value, canonicalValue: value }, status: 'unknown' as const }))
    const frame = normalizeProcessPlantProcedureEvidence(rows)
    expect(frame.readings).toHaveLength(5)
    expect(expandProcessPlantProcedureEvidence(frame)).toEqual(rows)
  })

  test('rejects absent, fractional, foreign and out-of-frame indices without a legacy-format fallback', () => {
    const frame = normalizeProcessPlantProcedureEvidence([base])
    for (const index of [-1, 0.5, 1, NaN, Infinity]) expect(() => readProcessPlantProcedureEvidence(frame, index)).toThrow('this frame')
    expect(() => expandProcessPlantProcedureEvidence({ evidence: [base] } as unknown as ProcessPlantProcedureEvidenceFrame)).toThrow('readings')
    const row = frame.evidence[0]!
    expect(() => expandProcessPlantProcedureEvidence({ ...frame, evidence: [{ ...row, reference: { path: variablePathSchema.parse('foreign.value') } } as typeof row] })).toThrow('path')
    const { signal: _signal, variable: _variable, ...unresolvedFacts } = base
    const unresolved = normalizeProcessPlantProcedureEvidence([unresolvedFacts])
    expect(() => expandProcessPlantProcedureEvidence({ ...unresolved, evidence: [{ ...unresolved.evidence[0]!, reference: { path: variablePathSchema.parse('foreign.value') } } as typeof row] })).toThrow('reference')
  })
})

describe('lossless sampled-evidence timestamps', () => {
  test('retains ordered irregular, duplicate, negative and reversing times without rounding or discarding samples', () => {
    const cases = [[], [0], [10, 10], [0, 0, 0, 1000, 2000, 2000], [-2000, -1000, 0, 1000],
      [0, 1000, 2100, 3100, 4100, 5001], [0, 1000, 500, 500, 1500], [0, 0.1, 0.2, 0.3, 0.4],
      [Number.MAX_VALUE, -Number.MAX_VALUE, 0], Array.from({ length: 20_001 }, (_, index) => index * 997)]
    for (const offsets of cases) {
      const encoded = encodeProcessPlantSampleTimeRuns(offsets)
      expect(encoded.every(run => processPlantSampleTimeRunSchema.safeParse(run).success)).toBe(true)
      expect(encoded.reduce((count, run) => count + run.count, 0)).toBe(offsets.length)
      expect(decodeProcessPlantSampleTimeRuns(encoded)).toEqual(offsets)
    }
    expect(encodeProcessPlantSampleTimeRuns(cases.at(-1)!)).toEqual([{ firstOffsetMs: 0, stepMs: 997, count: 20_001 }])
  })

  test('arbitrary cadence changes remain lossless rather than projecting onto the configured recording interval', () => {
    let offset = -30_000
    const offsets = Array.from({ length: 8000 }, (_, index) => offset += [0, 7, 1000, 4, 4, 4000, -2][index % 7]!)
    expect(decodeProcessPlantSampleTimeRuns(encodeProcessPlantSampleTimeRuns(offsets))).toEqual(offsets)
    expect(encodeProcessPlantSampleTimeRuns([0, 1000, 2000, 5000, 8000, 11_000])).toEqual([
      { firstOffsetMs: 0, stepMs: 1000, count: 3 }, { firstOffsetMs: 5000, stepMs: 3000, count: 3 },
    ])
  })

  test('refuses nonfinite acquisition values and malformed run records explicitly', () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(() => encodeProcessPlantSampleTimeRuns([0, value])).toThrow('finite')
    for (const run of [{ firstOffsetMs: 0, stepMs: 1, count: 0 }, { firstOffsetMs: 0, stepMs: 1, count: 1.5 },
      { firstOffsetMs: NaN, stepMs: 1, count: 2 }, { firstOffsetMs: 0, stepMs: Infinity, count: 2 },
      { firstOffsetMs: 0, stepMs: 1, count: 2, guessed: true }]) {
      expect(processPlantSampleTimeRunSchema.safeParse(run).success).toBe(false)
    }
  })
})
