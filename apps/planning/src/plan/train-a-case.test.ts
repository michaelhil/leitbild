import { describe, expect, test } from 'bun:test'
import { checkPlan, inputCodes } from '../check/check.ts'
import { trainAInputs as laneSInputs } from '../solve/fixtures/train-a-case.ts'
import { trainAInputs as laneKInputs } from '../../tests/harness/train-a-case.ts'
import laneKCase from '../../tests/harness/fixtures/train-a-case-v0.2.json'
import { TRAIN_A_CASE_SHA256, trainACase } from './fixtures/train-a-case.convert.ts'
import { planInputsSchema, type PlanInputs } from './schema.ts'

const fixture = planInputsSchema.parse(await Bun.file(new URL('./fixtures/train-a.case.json', import.meta.url)).json())
const sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')

// Three conversions of the frozen case exist: this fixture (the product's), lane K's harness and lane S's
// test support. Each value they all carry must agree; names that differ by design are mapped first.
//
// Where the fixture differs from the others, and why:
// - Every lane: function keys, test minimums, duration and link words, origin notes, the CCW HX A source
//   and labels are this fixture's (coordinator decisions and the case's own text); the others omit them.
// - Lane K keys protected items by World component id ("serviceWaterPumpB") and the method options by case id
//   ("M1-rebuild"), labels protected items "Protected <id>", ranks span over all three groups with a zero cost
//   step (or's run setup), and stands in a World read of SW B and CCW B running. The fixture ranks the
//   cooling chain only, as the case policy states, steps cost by NOK 25,000 and holds no World value.
// - Lane S builds on train-a.fragment.json, so it shares the fragment's keys; its CS-A and AFW-A limits
//   copy R2's words, and it names the electrical overtime "ot-elec-station".
type Inputs = PlanInputs
const protectedName: Readonly<Record<string, string>> = {
  serviceWaterPumpB: 'SWB', componentCoolingWaterPumpB: 'CCWB', rhrPumpB: 'RHRB', safetyInjectionPumpB: 'HHSIB', containmentSprayPumpB: 'CSB',
  auxFeedwaterPumpMotorB: 'AFWB', auxFeedwaterPumpTurbine: 'AFWTD', dieselGeneratorB: 'EDGB', safetyBusB: 'BUSB', switchyard: 'SWYD',
}
const caseOption: Readonly<Record<string, string>> = { 'M1-rebuild': 'rebuild', 'M2-swap': 'swap' }
const purchaseName: Readonly<Record<string, string>> = { 'ot-elec-station': 'ot-elec' }
const item = (key: string) => protectedName[key] ?? key
const option = (key: string | undefined) => key === undefined ? undefined : caseOption[key] ?? key

/** The values all three conversions carry, keyed and named alike. */
const shared = (inputs: Inputs) => ({
  settings: [inputs.settings.timeZone, inputs.settings.window, inputs.settings.dataDate, inputs.settings.grid, inputs.settings.currency],
  equipment: Object.fromEntries(inputs.equipment.map(entry => [item(entry.key), [entry.group, entry.supportedBy.map(item), entry.locator]])),
  groups: inputs.groups.map(group => group.key),
  calendars: Object.fromEntries(inputs.calendars.map(calendar => [calendar.key, [calendar.weekly, calendar.periods, calendar.except]])),
  resources: Object.fromEntries(inputs.resources.map(resource => [resource.key, [resource.kind, resource.count, resource.crewSize, resource.calendar]])),
  purchases: Object.fromEntries(inputs.purchases.map(purchase => [purchaseName[purchase.key] ?? purchase.key, [purchase.resource, purchase.adds, purchase.replaces, purchase.price, purchase.orderBy, purchase.allowed]])),
  methods: inputs.methods.map(method => Object.fromEntries(method.options.map(entry => [option(entry.key), entry.fixedCost]))),
  jobs: Object.fromEntries(inputs.jobs.map(job => [job.key, {
    kind: job.kind, equipment: job.equipment.map(item).sort(), isolation: job.isolation,
    duration: [job.duration.value, job.duration.unit, job.duration.calendar, job.duration.range], durationWith: job.durationWith,
    needs: job.needs, continuous: job.continuous, method: option(job.method?.option), notBefore: [job.notBefore?.at, job.notBefore?.source.by],
    checks: job.checks.map(check => [item(check.equipment), check.fact, check.expect]),
  }])),
  links: Object.fromEntries(inputs.links.map(link => [`${link.from} ${link.type} ${link.to}`, [link.lag, option(link.method?.option)]])),
  protected: inputs.rules.flatMap(rule => rule.kind === 'protected' ? rule.equipment.map(item) : []).sort(),
  spanLimits: Object.fromEntries(inputs.rules.flatMap(rule => rule.kind === 'span-limit' ? [[rule.group, [rule.limit, rule.singleEntry]]] : [])),
  firstGoal: [inputs.goals[0]?.metric, inputs.goals[0]?.threshold], laterGoals: inputs.goals.slice(1).map(goal => goal.metric),
})

describe('train-a.case.json, the full frozen flagship', () => {
  test('is the deterministic conversion of case v0.2 (a552c921)', async () => {
    expect(sha(await Bun.file(new URL('../solve/fixtures/train-a-case-v0.2.json', import.meta.url)).text())).toBe(TRAIN_A_CASE_SHA256)
    expect((await Bun.file(new URL('./fixtures/train-a.case.sha256', import.meta.url)).text()).trim().split(/\s+/)).toEqual([TRAIN_A_CASE_SHA256, 'case-v0.2.json'])
    expect(trainACase()).toEqual(fixture)
    expect([fixture.jobs.length, fixture.links.length, fixture.resources.length, fixture.purchases.length]).toEqual([34, 41, 7, 5])
  })

  test('is valid input for the checker under both SW A methods', () => {
    for (const choice of fixture.methods[0]!.options) {
      const result = checkPlan(fixture, { methods: [{ choice: fixture.methods[0]!.key, option: choice.key }], purchases: fixture.purchases.map(purchase => purchase.key) }, [])
      expect({ option: choice.key, problems: result.violations.filter(violation => inputCodes.has(violation.code)).map(violation => violation.words) }).toEqual({ option: choice.key, problems: [] })
    }
  })

  test("agrees with lane K's harness on every value both carry", () => {
    const laneK = laneKInputs(laneKCase, { method: 'M2-swap', overtime: true, nights: [], craneFriday: true, ectFriday: true }).inputs
    const mine = shared(fixture), theirs = shared(laneK)
    // Lane K ranks every group with a zero cost step and orders its equipment by case then protected items.
    const { firstGoal: _mineGoal, ...mineRest } = mine
    const { firstGoal: _theirGoal, ...theirRest } = theirs
    expect(theirRest).toEqual(mineRest)
    expect(theirs.firstGoal[1]).toEqual(mine.firstGoal[1])
  })

  test("agrees with lane S's test support on every value both carry", () => {
    expect(shared(laneSInputs())).toEqual(shared(fixture))
  })
})
