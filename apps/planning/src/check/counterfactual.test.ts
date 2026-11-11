import { describe, expect, test } from 'bun:test'
import { planInputsSchema } from '../plan/schema.ts'
import { counterfactualCheck } from '../../tests/harness/counterfactual.ts'
import type { ExplainItem } from '../../tests/harness/ports.ts'
import type { CheckRow } from './check.ts'

// The harness runs on lane S's explanations at integration (flagship baseline and two edit-replans, zero
// failures). Here it runs against hand-written explanations of a hand-made plan, true and false.
// One operator (count 1, 24/7). A, then B linked finish-to-start, then C free. Window Mon 16 Nov 06:00Z-12:00Z.
const planner = { by: 'planner' as const }
const job = (key: string) => ({ key, title: `Job ${key}`, kind: 'work' as const, equipment: [], isolation: 'none' as const, duration: { value: 1, unit: 'h' as const, calendar: 'working' as const, origin: planner }, durationWith: [], needs: [{ anyOf: ['ops'], amount: 1, handover: false }], continuous: true, checks: [], tags: [] })
const inputs = planInputsSchema.parse({
  settings: { title: 'Counterfactual', timeZone: 'Europe/Oslo', window: { start: '2026-11-16T06:00:00Z', end: '2026-11-16T12:00:00Z' }, dataDate: null, grid: '30min', currency: 'NOK', run: null },
  equipment: [], groups: [],
  calendars: [{ key: 'always', label: 'Always', weekly: [], periods: [{ start: '2026-11-16T06:00:00Z', end: '2026-11-16T12:00:00Z' }], except: [], source: planner }],
  resources: [{ key: 'ops', label: 'Operator', kind: 'crew', count: 1, calendar: 'always', attributes: [], source: planner }],
  purchases: [], methods: [],
  jobs: [job('A'), job('B'), { ...job('C'), notBefore: { at: '2026-11-16T09:00:00Z', words: 'Parts arrive', source: planner } }],
  links: [{ from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'h' } }],
  rules: [], goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }], world: { refreshedAt: null, facts: [] },
})
const variant = { methods: [], purchases: [] }
const one = (key: string, start: string, finish: string): CheckRow => ({ job: key, start, finish, uses: [{ resource: 'ops', from: start, to: finish }] })
// A 06:00Z-07:00Z, B 07:00Z-08:00Z, C 10:00Z-11:00Z (could start at 09:00Z, its release)
const rows = [one('A', '2026-11-16T06:00:00Z', '2026-11-16T07:00:00Z'), one('B', '2026-11-16T07:00:00Z', '2026-11-16T08:00:00Z'), one('C', '2026-11-16T10:00:00Z', '2026-11-16T11:00:00Z')]
const item = (key: string, start: string, because: ExplainItem['because'], joint: boolean): ExplainItem => ({ job: key, start, finish: start, floatHours: 0, because, joint })

describe('the counterfactual check', () => {
  test('B waits for both the link and the one operator: named jointly, it holds', () => {
    const explanation = item('B', '2026-11-16T07:00:00Z', [{ kind: 'link', about: ['A', 'B'] }, { kind: 'crew', about: ['ops'] }], true)
    expect(counterfactualCheck(inputs, variant, rows, [explanation])).toEqual([])
  })
  test('naming only the link fails: with the link gone, the operator still holds B back', () => {
    const explanation = item('B', '2026-11-16T07:00:00Z', [{ kind: 'link', about: ['A', 'B'] }], false)
    expect(counterfactualCheck(inputs, variant, rows, [explanation]).map(failure => failure.reason)).toEqual(['did-not-move'])
  })
  test('two causes claimed as each sufficient fail when they bind only together', () => {
    const explanation = item('B', '2026-11-16T07:00:00Z', [{ kind: 'link', about: ['A', 'B'] }, { kind: 'crew', about: ['ops'] }], false)
    expect(counterfactualCheck(inputs, variant, rows, [explanation])).toHaveLength(2)
  })
  test('C is late by choice: nothing holds it after 09:00Z; the release does not bind its 10:00Z start', () => {
    expect(counterfactualCheck(inputs, variant, rows, [item('C', '2026-11-16T10:00:00Z', [{ kind: 'late-as-possible', about: [] }], false)])).toEqual([])
    expect(counterfactualCheck(inputs, variant, rows, [item('B', '2026-11-16T07:00:00Z', [{ kind: 'late-as-possible', about: [] }], false)]).map(failure => failure.reason)).toEqual(['did-not-move'])
  })
  test('a C at its release is held by the release, and relaxing it moves C', () => {
    const atRelease = [...rows.slice(0, 2), one('C', '2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z')]
    expect(counterfactualCheck(inputs, variant, atRelease, [item('C', '2026-11-16T09:00:00Z', [{ kind: 'release', about: ['C'] }], false)])).toEqual([])
  })
  test('an explanation that does not describe the dated row, or a schedule that is not feasible, is a failure', () => {
    expect(counterfactualCheck(inputs, variant, rows, [item('B', '2026-11-16T07:30:00Z', [{ kind: 'crew', about: ['ops'] }], false)]).map(failure => failure.reason)).toEqual(['row-mismatch'])
    expect(counterfactualCheck(inputs, variant, rows.slice(1), []).map(failure => failure.reason)).toEqual(['not-feasible-before'])
  })
})

describe('the harness reads the explainer as it means', () => {
  // Three operators, so only the links hold E. Item X: tag 08:00Z-09:00Z, test 09:00Z-10:00Z.
  const two = planInputsSchema.parse({
    ...inputs,
    equipment: [{ key: 'X', label: 'Item X', supportedBy: [] }],
    resources: [{ key: 'ops', label: 'Operators', kind: 'crew', count: 3, calendar: 'always', attributes: [], source: planner }],
    jobs: [job('A'), job('B'), job('E'), { ...job('X-TAG'), kind: 'tag-out', equipment: ['X'] }, { ...job('X-TEST'), kind: 'test', equipment: ['X'] }],
    links: [{ from: 'A', to: 'E', type: 'FS', lag: { value: 0, unit: 'h' } }, { from: 'B', to: 'E', type: 'FS', lag: { value: 0, unit: 'h' } }],
  })
  const rowsTwo = [one('A', '2026-11-16T06:00:00Z', '2026-11-16T07:00:00Z'), one('B', '2026-11-16T06:00:00Z', '2026-11-16T07:00:00Z'), one('E', '2026-11-16T07:00:00Z', '2026-11-16T08:00:00Z'),
    one('X-TAG', '2026-11-16T08:00:00Z', '2026-11-16T09:00:00Z'), one('X-TEST', '2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z')]
  test('a link cause naming two keys names two predecessors, both lifted', () => {
    expect(counterfactualCheck(two, variant, rowsTwo, [item('E', '2026-11-16T07:00:00Z', [{ kind: 'link', about: ['A', 'B'] }], false)])).toEqual([])
    // naming only one of them is not enough: the other still holds E
    expect(counterfactualCheck(two, variant, rowsTwo, [item('E', '2026-11-16T07:00:00Z', [{ kind: 'link', about: ['A'] }], false)]).map(failure => failure.reason)).toEqual(['did-not-move'])
  })
  test('lifting "test after tag-out" lifts only that order: the item still returns, and the test moves', () => {
    expect(counterfactualCheck(two, variant, rowsTwo, [item('X-TEST', '2026-11-16T09:00:00Z', [{ kind: 'link', about: ['X-TAG'] }], false)])).toEqual([])
  })
})

describe('the data date as a cause', () => {
  // Data date Mon 07:00Z; D (1 h on the operator) starts there, an hour after the window opens.
  const dated = planInputsSchema.parse({ ...inputs, settings: { ...inputs.settings, dataDate: '2026-11-16T07:00:00Z' }, jobs: [job('D')], links: [] })
  const rowsD = [one('D', '2026-11-16T07:00:00Z', '2026-11-16T08:00:00Z')]
  test('relaxing the data date, and nothing else, lets D start earlier', () => {
    expect(counterfactualCheck(dated, variant, rowsD, [item('D', '2026-11-16T07:00:00Z', [{ kind: 'data-date', about: [] }], false)])).toEqual([])
  })
  test('naming the window instead does not move it', () => {
    expect(counterfactualCheck(dated, variant, rowsD, [item('D', '2026-11-16T07:00:00Z', [{ kind: 'window', about: [] }], false)]).map(failure => failure.reason)).toEqual(['did-not-move'])
  })
})

describe('padded explanations are refused', () => {
  test('a joint set with a cause that is not needed fails minimality', () => {
    // B is held by the link and the operator; "placed late" adds nothing to that pair
    const padded = item('B', '2026-11-16T07:00:00Z', [{ kind: 'link', about: ['A'] }, { kind: 'crew', about: ['ops'] }, { kind: 'late-as-possible', about: [] }], true)
    const failures = counterfactualCheck(inputs, variant, rows, [padded])
    expect(failures.map(failure => failure.reason)).toEqual(['not-minimal'])
    expect(failures[0]?.detail).toContain('late-as-possible')
  })
  test('the exact pair is minimal', () => {
    expect(counterfactualCheck(inputs, variant, rows, [item('B', '2026-11-16T07:00:00Z', [{ kind: 'link', about: ['A'] }, { kind: 'crew', about: ['ops'] }], true)])).toEqual([])
  })
  test('a "waits for" naming a job with no order to it is refused, not waived', () => {
    const failures = counterfactualCheck(inputs, variant, rows, [item('B', '2026-11-16T07:00:00Z', [{ kind: 'link', about: ['C'] }, { kind: 'crew', about: ['ops'] }], true)])
    expect(failures.map(failure => [failure.reason, failure.detail])).toEqual([['cannot-relax', 'no link or derived order from C to B']])
  })
})
