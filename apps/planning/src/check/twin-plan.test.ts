import { describe, expect, test } from 'bun:test'
import { checkPlan } from './check.ts'
import { twinPlan, twinV3Options } from '../../tests/harness/twin-plan.ts'
import solutions from '../../tests/harness/fixtures/twin-v3-solutions.json'

// The frozen gate twin v3 as a plan, and or's best-known plans of it judged by the product checker. The
// counts come from maint/twin-v3-spec.md §6; the measures from or's run files.
const text = await Bun.file(new URL('../../tests/harness/fixtures/twin-v3.json', import.meta.url)).text()
const bench = JSON.parse(text)
const plan = twinPlan(bench, twinV3Options(bench))

describe('gate twin v3 as a plan', () => {
  test('the fixture is the frozen twin', () => {
    expect(new Bun.CryptoHasher('sha256').update(text).digest('hex')).toBe('955824a9e7368a4bccad688e5974d8db8a966335e8b081069ab6a91ddb66a047')
  })
  test('330 jobs and 198 links, as the spec counts them', () => {
    expect(plan.inputs.jobs).toHaveLength(330)
    expect(plan.inputs.links).toHaveLength(198)
    // 26 return-to-service tests in the spec; the 20 that close an availability span are tests here, the
    // 6 clearance tests (every 4th clearance) close no span in the twin and stay work
    expect(plan.inputs.jobs.filter(job => job.kind === 'test')).toHaveLength(20)
    // six span limits (COOL, CS, AFW on both units) and seven k-of-G groups, every member named
    expect(plan.inputs.rules.filter(rule => rule.kind === 'span-limit')).toHaveLength(6)
    expect(plan.inputs.rules.filter(rule => rule.kind === 'keep-in-service').map(rule => rule.key).sort()).toEqual(['U1-CP', 'U1-CTF', 'U1-CWP', 'U1-IAC', 'U2-CP', 'U2-CTF', 'U2-IAC'])
  })
  test('the 26 surveillance deadlines are hard due rules, Thu 19 Nov 15:00 CET = 14:00Z', () => {
    const due = plan.inputs.rules.filter(rule => rule.kind === 'due')
    expect(due).toHaveLength(26)
    expect(new Set(due.map(rule => rule.kind === 'due' ? rule.finishBy : ''))).toEqual(new Set(['2026-11-19T14:00:00Z']))
    expect(plan.inputs.jobs.some(job => job.target !== undefined)).toBe(false)
  })
  test('a surveillance job moved past its due time is refused', () => {
    const run = solutions.runs[0]!
    const rule = plan.inputs.rules.find(candidate => candidate.kind === 'due')!
    const job = rule.kind === 'due' ? rule.job : ''
    const rows = plan.rowsOf(run.solution)
    const row = rows.find(entry => entry.job === job)!
    // moved to finish at Thu 19 Nov 15:30 CET = 14:30Z; its own times and uses stay consistent
    const shift = Date.parse('2026-11-19T14:30:00Z') - Date.parse(row.finish)
    const move = (iso: string) => new Date(Date.parse(iso) + shift).toISOString().replace('.000Z', 'Z')
    const moved = rows.map(entry => entry.job === job ? { ...entry, start: move(entry.start), finish: move(entry.finish), uses: entry.uses.map(use => ({ ...use, from: move(use.from), to: move(use.to) })) } : entry)
    const found = checkPlan(plan.inputs, plan.variant, moved).violations.filter(violation => violation.code === 'due')
    expect(found.map(violation => violation.about)).toEqual([[rule.key, job]])
    expect(found[0]?.words).toContain('Thu 19 Nov 15:30')
  })
  test("lane S's compile accepts the twin plan: no bought time overlaps booked time", async () => {
    const { compile } = await import('../solve/compile.ts')
    const compiled = compile(plan.inputs, { methods: [], buy: 'allowed' })
    expect(compiled.ok ? [] : compiled.problems).toEqual([])
  })
  test('supports are read from the spans: CCW A from SW A, RHR A from CCW A', () => {
    const supported = (key: string) => plan.inputs.equipment.find(item => item.key === key)?.supportedBy
    expect(supported('CCWA')).toEqual(['SWA'])
    expect(supported('RHRA')?.sort()).toEqual(['CCWA', 'CCWHXA'])
  })
  for (const run of solutions.runs) {
    test(`${run.file}: no violations, and the measures agree with or's`, () => {
      const result = checkPlan(plan.inputs, plan.variant, plan.rowsOf(run.solution))
      expect(result.violations).toEqual([])
      const goals = result.goals
      const spans = goals[0]
      if (spans?.metric !== 'span-over') throw new Error('the first gate goal is the guideline excess')
      expect(spans.spans.reduce((sum, span) => sum + Math.max(0, span.value - 54), 0)).toBe(run.guidelineH)
      expect(result.metrics.find(item => item.id === 'finish')?.value).toBe(run.finishH)
      expect(result.metrics.find(item => item.id === 'extra-cost')?.value).toBe(run.costNok)
    })
  }
})
