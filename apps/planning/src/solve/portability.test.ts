import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { planInputsSchema, type PlanInputs } from '../plan/schema.ts'
import supplyRunJson from '../plan/fixtures/supply-run.case2.json'
import { compile } from './compile.ts'
import { makeExplainer } from './explain.ts'
import { prepare } from './decode.ts'
import { totalFloat } from './float.ts'
import { generate } from './generate.ts'
import { searchEngine } from './search.ts'
import { checkDouble } from './fixtures/check-double.ts'

// The Supply run (maint/case2.json, sha256 7339108b…, converted by lane A) solved by the same core.
// World values are never stored, so this test supplies a recorded-facts fixture. These are TEST INPUTS
// (not World recordings, not schedule numbers): every truck's on-scene time is 180 s as in the
// Scenario; arrival seconds below are chosen for the test. Expected times are worked out by hand.
const arrivals: Record<string, number> = {
  'unit:truck-4/arrival-seconds/task:sports-hall-tank': 120,
  'unit:truck-1/arrival-seconds/task:sports-hall-tank': 300,
  'unit:truck-3/arrival-seconds/task:field-kitchen': 240,
  'unit:truck-4/arrival-seconds/task:field-kitchen': 200,
  'unit:truck-1/arrival-seconds/task:field-kitchen': 360,
}
const payloads: Record<string, number> = { 'unit:truck-1/property/payloadKg': 300, 'unit:truck-3/property/payloadKg': 800, 'unit:truck-4/property/payloadKg': 1_500 }
const base = planInputsSchema.parse(supplyRunJson)
const refs = [...new Set(JSON.stringify(base).match(/"locator":"[^"]+","fact":"[^"]+"/g) ?? [])].map(text => JSON.parse(`{${text}}`) as { locator: string; fact: string })
const facts = refs.map(ref => {
  const value = ref.fact.endsWith('/service-seconds') ? 180 : arrivals[ref.fact] ?? payloads[ref.fact]
  if (value === undefined) throw new Error(`The facts fixture lacks ${ref.fact}`)
  return { locator: ref.locator, id: ref.fact, label: ref.fact, quantity: ref.fact.includes('payload') ? 'mass' : 'duration', unit: ref.fact.includes('payload') ? 'kg' : 's', value, basis: ref.fact.includes('payload') ? 'configured' : 'owner-estimate', at: '2026-09-03T08:00:00Z' }
})
const withFacts = (inputs: PlanInputs): PlanInputs => planInputsSchema.parse({ ...inputs, world: { refreshedAt: '2026-09-03T08:00:00Z', facts } })
const supplyRun = withFacts(base)
/** VS1: Truck 2 is announced late and joins at 08:05:00. */
const lateTruck = planInputsSchema.parse({ ...supplyRun, calendars: supplyRun.calendars.map(calendar => (calendar.key === 'joins-0802' ? { ...calendar, periods: [{ start: '2026-09-03T08:05:00Z', end: '2026-09-03T08:30:00Z' }] } : calendar)) })
/** VS2: the coverage rule lifted (with authority, by lane P's edit). */
const lifted = planInputsSchema.parse({ ...supplyRun, rules: [] })

const run = async (inputs: PlanInputs) => {
  const result = await generate({ engine: searchEngine(), check: checkDouble() }, { inputs, revision: 1, previous: null, input: { seconds: 2 }, by: { kind: 'agent' }, signal: new AbortController().signal })
  const option = result.optionSet.options[0]!
  const row = (job: string) => option.rows.find(entry => entry.job === job)!
  return { option, row }
}

describe('the Supply run solves on the same core', () => {
  test('without World facts it is refused, naming the unread value', () => {
    const compiled = compile(base, { methods: [], buy: 'allowed' })
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.problems[0]!.code).toBe('world_value_unread')
  })

  test('base: U-1 on Truck 4 from 08:02 on target, R-1 on Truck 3 from 08:00', async () => {
    const { option, row } = await run(supplyRun)
    expect(option.status.word).toBe('validated feasible')
    // Truck 4 must stay free until Truck 2 joins at 08:02 (keep one heavy truck free). Only Trucks 2 and 4
    // carry 1,000 kg. Truck 4: 120 + 180 s = 5 min, 08:02-08:07, on target (finish by 08:07). Truck 2 would
    // use Truck 1's 300 s + 180 s = 8 min, 08:02-08:10: 3 min late. So Truck 4.
    expect([row('U-1').start, row('U-1').finish, row('U-1').uses.map(use => use.resource)]).toEqual(['2026-09-03T08:02:00.000Z', '2026-09-03T08:07:00.000Z', ['truck-4']])
    // R-1 needs 500 kg and has several on-target choices, all equal for the goals: Truck 3 (800 kg)
    // 240 + 180 s = 7 min from 08:00 ends 08:07; Truck 1 only from 08:03 (600 kg after its upgrade),
    // 360 + 180 s = 9 min, ends 08:12. Either ends by 08:13; payload is checked at the start.
    const r1 = row('R-1')
    expect(Date.parse(r1.finish)).toBeLessThanOrEqual(Date.parse('2026-09-03T08:13:00Z'))
    if (r1.uses[0]!.resource === 'truck-1') expect(Date.parse(r1.start)).toBeGreaterThanOrEqual(Date.parse('2026-09-03T08:03:00Z'))
    expect(['truck-1', 'truck-3', 'truck-4', 'truck-2', 'truck-5']).toContain(r1.uses[0]!.resource)
    expect(option.status.word === 'validated feasible' && option.status.goals.map(goal => goal.value)).toEqual([0, 0])
  })

  test('VS1: Truck 2 joins at 08:05; U-1 is late and the cause names the coverage rule and the join', async () => {
    const { option, row } = await run(lateTruck)
    expect(option.status.word).toBe('validated feasible')
    // Truck 4 is held free until 08:05, then serves U-1 08:05-08:10: 3 min past 08:07. Truck 2 from 08:05
    // would end 08:13, 6 min late.
    expect([row('U-1').start, row('U-1').finish]).toEqual(['2026-09-03T08:05:00.000Z', '2026-09-03T08:10:00.000Z'])
    expect(option.status.word === 'validated feasible' && option.status.goals[0]).toMatchObject({ value: 3, unit: 'min' })
    const compiled = compile(lateTruck, { methods: [], buy: 'allowed' })
    if (!compiled.ok) throw new Error('compiles')
    const prep = prepare(compiled.problem)
    const at = (instant: string) => (Date.parse(instant) - compiled.index.origin) / compiled.index.slotMs
    const schedule = {
      start: Int32Array.from(compiled.problem.activities.map(activity => at(option.rows.find(entry => entry.job === activity.id)!.start))),
      mode: Int32Array.from(compiled.problem.activities.map(activity => activity.modes.findIndex(mode => mode.demands.some(d => compiled.index.resources[d.resource] === option.rows.find(entry => entry.job === activity.id)!.uses[0]!.resource)))),
    }
    const explainer = makeExplainer({ prep, index: compiled.index, schedule, floats: totalFloat(prep, compiled.index, schedule) })
    const why = explainer.whyStart(compiled.index.jobs.indexOf('U-1'))
    expect(why.because).toContainEqual({ kind: 'availability', about: ['heavy-free'], until: '2026-09-03T08:05:00.000Z' })
    expect(why.because).toContainEqual({ kind: 'shift', about: ['truck-2'], until: '2026-09-03T08:05:00.000Z' })
    expect(why.because.map(cause => cause.kind)).not.toContain('late-as-possible')
  })

  test('VS2: with the rule lifted (a comparison), Truck 4 serves U-1 from 08:00', async () => {
    const { row } = await run(lifted)
    expect([row('U-1').start, row('U-1').finish]).toEqual(['2026-09-03T08:00:00.000Z', '2026-09-03T08:05:00.000Z'])
  })

  test('the solver has no domain branch', async () => {
    const words = /\b(truck|payload|pump|reactor|nuclear|einsatz|process-plant|crane|eddy|tag-?out|PWR|SWA|COOL-A)\b/i
    const offenders: string[] = []
    for await (const file of new Glob('*.ts').scan({ cwd: new URL('.', import.meta.url).pathname })) {
      if (file.endsWith('.test.ts')) continue
      const text = await Bun.file(new URL(file, import.meta.url)).text()
      // Job kinds are the plan schema's own words ('tag-out', 'test'); everything else must be generic.
      const code = text.replace(/'tag-out'/g, '').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
      if (words.test(code)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
