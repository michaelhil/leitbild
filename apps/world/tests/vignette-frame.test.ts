import { describe, expect, test } from 'bun:test'
import { safetyFunctionReading } from '../src/packs/process-plant/observation/safety-function-reading.ts'
import type { SafetyFunctionEvaluation } from '../src/packs/process-plant/safety-functions.ts'

// A vignette's frame (plan v5 W4.1): the per-sample pointer and path the
// Plant reads its safety functions' states with.

describe('the safety function reading (W4.1, per sample)', () => {
  const step = (question: string, answer: 'yes' | 'no', signal: string, value: number) =>
    ({ question, basis: '', answer, comparisons: [{ reads: [{ signal, path: signal, label: signal, value, unit: 'percent' }], operator: '>' as const, threshold: 10, unit: 'percent', answer }] })
  const evaluation = (fields: Partial<SafetyFunctionEvaluation>): SafetyFunctionEvaluation => ({
    id: 'heat-sink', label: 'Heat sink', shortLabel: 'HEAT SINK', basis: '', status: 'green', meaning: 'The heat sink is satisfied.', path: [], checks: [], expected: [], missingSignals: [], ...fields,
  })

  test('challenged: coloured at its challenge, its procedure the pointer, its path with the readings that answered each question', () => {
    expect(safetyFunctionReading(evaluation({ status: 'red', procedure: 'FR-H.1', meaning: 'No feed.', path: [step('Level above 10 % in a steam generator', 'no', 'SG-A-LVL-NR', 4.2)] }))).toEqual({
      value: 'red', quality: 'good', priority: 'alarm', note: 'FR-H.1', why: 'Level above 10 % in a steam generator: no (SG-A-LVL-NR 4.20 %) · RED · FR-H.1: No feed.',
    })
  })

  test('not judged reads outside its validity; one that cannot be judged is uncertain; satisfied has no pointer', () => {
    expect(safetyFunctionReading(evaluation({ status: 'not-monitored', meaning: 'Judged once a trip is demanded.' }))).toEqual({ value: 'not-monitored', quality: 'not-applicable', priority: 'none', why: 'NOT JUDGED: Judged once a trip is demanded.' })
    expect(safetyFunctionReading(evaluation({ status: 'unknown' }))).toMatchObject({ quality: 'uncertain', priority: 'none' })
    expect(safetyFunctionReading(evaluation({})).note).toBeUndefined()
  })

  test('within 300 characters the earliest questions give way first, so what the path ends in is always said', () => {
    const long = Array.from({ length: 8 }, (_, at) => step(`Question ${at} about a steam generator's narrow-range level on span`, 'yes', `SG-${at}-LVL-NR`, 55))
    const why = safetyFunctionReading(evaluation({ path: long })).why!
    expect(why.length).toBeLessThanOrEqual(300)
    expect(why.startsWith('… · ')).toBe(true)
    expect(why.endsWith('GREEN: The heat sink is satisfied.')).toBe(true)
    expect(why).toContain('Question 7')
  })
})
