import { describe, expect, test } from 'bun:test'
import { checkPlan, prepare, type CheckRow } from './check.ts'
import { propagate, worldsOf } from './propagate.ts'
import { trainAInputs } from '../../tests/harness/train-a-case.ts'
import { progressOf, type OrRunExtract } from '../../tests/harness/or-runs.ts'
import caseJson from '../../tests/harness/fixtures/train-a-case-v0.2.json'
import extracted from '../../tests/harness/fixtures/or-v02-runs.json'

// or's ten v0.2 schedules (three base options, seven replans), each judged by the product checker on plan
// inputs converted from the frozen case. Every expected value comes from or's own run file.
const runs = extracted.runs as unknown as OrRunExtract[]
const caseText = await Bun.file(new URL('../../tests/harness/fixtures/train-a-case-v0.2.json', import.meta.url)).text()
const inputsOf = (run: OrRunExtract) => trainAInputs(caseJson, run.choices, progressOf(caseJson, run))
const metric = (result: ReturnType<typeof checkPlan>, id: string) => result.metrics.find(item => item.id === id)?.value

describe("or's v0.2 schedules", () => {
  test('the case fixture is the frozen case', () => {
    expect(new Bun.CryptoHasher('sha256').update(caseText).digest('hex')).toBe('a552c921c58fe982c3d413fe7ccd8ae505b9f312949f804f541706e6460ed9b1')
    expect(runs.map(run => run.name)).toEqual([
      'v02-base-M1-ot1-n4', 'v02-base-M2-ot1-n0', 'v02-base-M2-ot1-n4',
      'v02-replan-X1-rebuild', 'v02-replan-X1-shift', 'v02-replan-X1', 'v02-replan-X2', 'v02-replan-X3', 'v02-replan-X4', 'v02-replan-X5',
    ])
  })
  for (const run of runs) {
    test(`${run.name}: no violations, and the measures agree with or's`, () => {
      const { inputs, variant } = inputsOf(run)
      const result = checkPlan(inputs, variant, run.rows)
      expect(result.violations).toEqual([])
      for (const [group, hours] of Object.entries(run.claimed.groupSpanHours)) expect(metric(result, `span:${group}`)).toBe(hours)
      const spans = result.goals[0]
      if (spans?.metric !== 'span-over') throw new Error('the first goal is the guideline excess')
      // the guideline excess: the sum over groups of max(0, span - 54 h)
      expect(spans.spans.reduce((sum, span) => sum + Math.max(0, span.value - 54), 0)).toBe(run.claimed.guidelineExcessHours)
      expect(metric(result, 'unavailable-hours')).toBe(run.claimed.unavailableHours)
      expect(metric(result, 'extra-cost')).toBe(run.claimed.extraCost)
    })
  }
})

describe("the checker's time logic is sound on or's schedules", () => {
  // A schedule the checker accepts must lie inside the propagated start windows of its own case (the ECT
  // rebooking taken or not); a window that excluded it would make a false proof possible.
  for (const run of runs) {
    test(`${run.name}: every row starts inside its propagated window`, () => {
      const { inputs, variant } = inputsOf(run)
      const prepared = prepare(inputs, variant)
      if (!prepared.ok) throw new Error('the case does not prepare')
      const context = prepared.context
      const rebooked = run.rows.some(entry => entry.uses.some(use => use.purchase === 'ect-friday'))
      const world = worldsOf(context).find(candidate => [...candidate.values()].every(taken => taken === rebooked))!
      const timed = propagate(context, world)
      expect(timed.ok).toBe(true)
      if (!timed.ok) return
      const outside = run.rows.filter(entry => { const window = timed.windows.get(entry.job)!; const slot = context.slotOf(Date.parse(entry.start)); return slot < window.es || slot > window.ls })
      expect(outside.map(entry => entry.job)).toEqual([])
    })
  }
})

describe("the checker refuses or's best option once it is broken", () => {
  const run = runs.find(candidate => candidate.name === 'v02-base-M2-ot1-n4')!
  const { inputs, variant } = inputsOf(run)
  const codes = (rows: readonly CheckRow[], changed = inputs, changedVariant = variant) => checkPlan(changed, changedVariant, rows).violations.map(item => item.code)
  const shift = (entry: CheckRow, ms: number): CheckRow => {
    const move = (iso: string) => new Date(Date.parse(iso) + ms).toISOString().replace('.000Z', 'Z')
    return { ...entry, start: move(entry.start), finish: move(entry.finish), uses: entry.uses.map(use => ({ ...use, from: move(use.from), to: move(use.to) })) }
  }
  test('a lift without its crane', () => {
    const rows = run.rows.map(entry => entry.job === 'SWA-PUMP-OUT' ? { ...entry, uses: entry.uses.filter(use => use.resource !== 'crane') } : entry)
    expect(codes(rows)).toContain('need-not-served')
  })
  test('CCW A tested back before SW A, which supports it', () => {
    const swa = run.rows.find(entry => entry.job === 'SWA-RTS')!
    const ccwa = run.rows.find(entry => entry.job === 'CCWA-RTS')!
    const rows = run.rows.map(entry => entry.job === 'CCWA-RTS' ? shift(ccwa, Date.parse(swa.start) - Date.parse(ccwa.start) - 3 * 3_600_000) : entry)
    expect(codes(rows)).toContain('support-order')
  })
  test('overtime used when the variant does not allow it', () => {
    expect(codes(run.rows, inputs, { ...variant, purchases: variant.purchases.filter(key => key !== 'ot-mech') })).toContain('purchase-not-allowed')
  })
  test('a tighter outage limit than the cooling-chain span', () => {
    const tighter = { ...inputs, rules: inputs.rules.map(rule => rule.kind === 'span-limit' && rule.group === 'COOL-A' ? { ...rule, limit: { value: 50, unit: 'h' as const } } : rule) }
    expect(codes(run.rows, tighter)).toEqual(['span-limit'])
  })
  test('keep one of CCW A and RHR A in service: RHR A is out with CCW A, which supports it', () => {
    const rule = { kind: 'keep-in-service' as const, key: 'K', members: [{ equipment: 'CCWA' }, { equipment: 'RHRA' }], atLeast: 1, words: 'Keep CCW A or RHR A in service', source: { by: 'planner' as const } }
    expect(codes(run.rows, { ...inputs, rules: [...inputs.rules, rule] })).toEqual(['keep-in-service'])
  })
  test('SW B not running at read time', () => {
    const stopped = { ...inputs, world: { ...inputs.world, facts: inputs.world.facts.map(fact => fact.id.includes('serviceWaterPumpB') ? { ...fact, value: false } : fact) } }
    expect(codes(run.rows, stopped)).toEqual(['precondition-unmet'])
  })
  test('a test started before the last work inside its item ends', () => {
    const work = run.rows.filter(entry => inputs.jobs.find(job => job.key === entry.job)?.equipment.includes('CSA') && inputs.jobs.find(job => job.key === entry.job)?.isolation === 'inside')
    const lastWork = Math.max(...work.map(entry => Date.parse(entry.finish)))
    const test = run.rows.find(entry => entry.job === 'CSA-RTS')!
    const rows = run.rows.map(entry => entry.job === 'CSA-RTS' ? shift(test, lastWork - 1_800_000 - Date.parse(test.start)) : entry)
    expect(codes(rows)).toContain('bracket')
  })
})
