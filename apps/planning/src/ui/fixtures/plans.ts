// Test-only plans for the screen's presenters (this folder does not ship). Inputs are lane A's
// fixtures. Every schedule number below is a hand calculation from those fixtures, written out here;
// nothing is typed in as a result. These rows are presenter input, not solver output.
import { planInputsSchema, statusSchema, type PlanInputs, type Status, type WorldFactCopy } from '../../plan/schema.ts'
import { timeUnitMs } from '../../time/units.ts'
import type { DatedRow, OptionView, PlanModel } from '../model.ts'

export const hourMs = timeUnitMs.h
const iso = (ms: number): string => new Date(ms).toISOString()

const fixture = async (name: string): Promise<unknown> => Bun.file(new URL(`../../plan/fixtures/${name}`, import.meta.url)).json()
const trainAJson = await fixture('train-a.fragment.json')
const supplyRunJson = await fixture('supply-run.case2.json')

export const trainAInputs = (): PlanInputs => planInputsSchema.parse(trainAJson)
export const supplyRunInputs = (): PlanInputs => planInputsSchema.parse(supplyRunJson)

export const modelOf = (inputs: PlanInputs, extra: Partial<PlanModel> = {}): PlanModel => ({
  id: '0b4b9a52-2f7e-4c1a-9d3e-0000000000aa', title: inputs.settings.title, revision: 3, updatedAt: '2026-11-12T09:00:00.000Z',
  inputs, attention: [], certifiedSize: null, options: null, rows: {}, history: [], refusals: {}, ...extra,
})

export const runBasis = (grid: PlanInputs['settings']['grid']) => ({
  grid, engine: 'presenter fixture', formulation: 'presenter fixture', seed: 1,
  budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done' as const, evals: 1, cpuMs: 9_000,
})

export const status = (value: unknown): Status => statusSchema.parse(value)

export const optionOf = (key: string, label: string, optionStatus: Status, extra: Partial<OptionView> = {}): OptionView => ({
  key, label, variant: { methods: [], purchases: [] }, status: optionStatus, metrics: [], inputsRevision: 3, fresh: true, warnings: [], ...extra,
})

const durationOf = (inputs: PlanInputs, key: string): number => {
  const job = inputs.jobs.find(item => item.key === key)
  if (job === undefined || job.duration.value === null) throw new Error(`No hand duration for ${key}`)
  return job.duration.value * timeUnitMs[job.duration.unit]
}

/**
 * Train A, three hand-placed jobs on SW A:
 * - the tag-out starts when the window opens (Mon 07:00 local) and takes its 3 h on the 24/7 work-control
 *   calendar, so it ends Mon 10:00;
 * - the pump pull needs the crane, whose first lit period opens Tue 07:00; it takes 5 h, so it ends Tue 12:00;
 * - the return-to-service test follows at once and takes 3.5 h on 24/7 calendars, ending Tue 15:30.
 * SW A (and CCW A, HX A, RHR A, HHSI A, which it supports) is out from Mon 07:00 to Tue 15:30: 24 h + 5 h + 3.5 h = 32.5 h.
 * Float is written as the clock hours from each finish to the window end (an upper bound, for the presenter).
 */
export const trainARows = (inputs: PlanInputs): readonly DatedRow[] => {
  const windowStart = Date.parse(inputs.settings.window!.start)
  const windowEnd = Date.parse(inputs.settings.window!.end)
  const craneOpens = Date.parse(inputs.calendars.find(calendar => calendar.key === 'crane')!.periods[0]!.start)
  const tagEnd = windowStart + durationOf(inputs, 'SWA-TAG')
  const pullEnd = craneOpens + durationOf(inputs, 'SWA-PUMP-OUT')
  const testEnd = pullEnd + durationOf(inputs, 'SWA-RTS')
  const float = (finish: number) => ({ workingHours: (windowEnd - finish) / hourMs, limitedBy: { kind: 'window-end' as const } })
  return [
    { job: 'SWA-TAG', start: iso(windowStart), finish: iso(tagEnd), uses: [{ resource: 'work-control', from: iso(windowStart), to: iso(tagEnd) }], float: float(tagEnd) },
    { job: 'SWA-PUMP-OUT', start: iso(craneOpens), finish: iso(pullEnd), uses: [{ resource: 'mech-station', from: iso(craneOpens), to: iso(pullEnd) }, { resource: 'crane', from: iso(craneOpens), to: iso(pullEnd) }], float: float(pullEnd) },
    { job: 'SWA-RTS', start: iso(pullEnd), finish: iso(testEnd), uses: [{ resource: 'work-control', from: iso(pullEnd), to: iso(testEnd) }, { resource: 'test-team', from: iso(pullEnd), to: iso(testEnd) }], float: float(testEnd) },
  ]
}

/** Train A with the three hand-placed rows as its one validated option; goal 1 is 0 h over 54 h (32.5 h is under it). */
export const trainAPlanned = (): PlanModel => {
  const inputs = trainAInputs()
  const optionStatus = status({
    word: 'validated feasible', run: runBasis(inputs.settings.grid),
    goals: [
      { word: 'proven optimal', goal: 0, value: 0, unit: 'h', bound: { value: 0, source: 'logic+calendars', certificate: { kind: 'zero' } } },
      { word: 'best found under budget', goal: 1, value: 0, unit: 'NOK' },
    ],
  })
  return modelOf(inputs, {
    options: { at: '2026-11-12T09:05:00.000Z', recommended: 'opt-1', items: [optionOf('opt-1', 'Option 1', optionStatus)] },
    rows: { 'opt-1': trainARows(inputs) },
  })
}

/**
 * World facts for the Supply run, as a refresh would copy them. These are TEST INPUTS standing in for a
 * World read, not recorded values: payloads are the Scenario's initial values in case2.json; service
 * 180 s is case2's on-scene time; the two arrival estimates (150 s and 240 s) are chosen for this test.
 */
export const supplyRunFacts = (): readonly WorldFactCopy[] => {
  const at = '2026-09-03T08:00:00Z'
  const unit = (truck: number) => `einsatz/unit/unit%3Atruck-${truck}`
  return [
    { locator: unit(1), id: 'unit:truck-1/property/payloadKg', label: 'Payload', quantity: 'mass', unit: 'kg', value: 300, basis: 'configured', at },
    { locator: unit(3), id: 'unit:truck-3/property/payloadKg', label: 'Payload', quantity: 'mass', unit: 'kg', value: 800, basis: 'configured', at },
    { locator: unit(4), id: 'unit:truck-4/property/payloadKg', label: 'Payload', quantity: 'mass', unit: 'kg', value: 1500, basis: 'configured', at },
    { locator: unit(4), id: 'unit:truck-4/arrival-seconds/task:sports-hall-tank', label: 'Arrival at U-1', quantity: 'duration', unit: 's', value: 150, basis: 'owner-estimate', at },
    { locator: unit(4), id: 'unit:truck-4/service-seconds', label: 'On-scene time', quantity: 'duration', unit: 's', value: 180, basis: 'design', at },
    { locator: unit(3), id: 'unit:truck-3/arrival-seconds/task:field-kitchen', label: 'Arrival at R-1', quantity: 'duration', unit: 's', value: 240, basis: 'owner-estimate', at },
    { locator: unit(3), id: 'unit:truck-3/service-seconds', label: 'On-scene time', quantity: 'duration', unit: 's', value: 180, basis: 'design', at },
  ]
}

/**
 * The Supply run after a refresh, with one hand-placed option:
 * - U-1 needs 1,000 kg: only Trucks 2 and 4 qualify. The coverage rule keeps one of them free, so Truck 4
 *   may leave only when Truck 2 joins at 08:02 (case2.json). U-1 on Truck 4: 08:02 + 150 s + 180 s = 08:07:30,
 *   30 s past its 08:07 target: lateness 0.5 min.
 * - R-1 needs 500 kg: Truck 3 (800 kg) leaves at 08:00. 08:00 + 240 s + 180 s = 08:07, before its 08:13 target.
 */
export const supplyRunPlanned = (): PlanModel => {
  const base = supplyRunInputs()
  const facts = supplyRunFacts()
  const inputs: PlanInputs = { ...base, settings: { ...base.settings, run: { id: 'run-supply', linkedAt: '2026-09-03T08:00:00Z' } }, world: { refreshedAt: '2026-09-03T08:00:00Z', facts: [...facts] } }
  const value = (id: string) => facts.find(fact => fact.id === id)!.value as number
  const truck2Joins = Date.parse(inputs.calendars.find(calendar => calendar.key === 'joins-0802')!.periods[0]!.start)
  const windowStart = Date.parse(inputs.settings.window!.start)
  const windowEnd = Date.parse(inputs.settings.window!.end)
  const u1Finish = truck2Joins + (value('unit:truck-4/arrival-seconds/task:sports-hall-tank') + value('unit:truck-4/service-seconds')) * 1_000
  const r1Finish = windowStart + (value('unit:truck-3/arrival-seconds/task:field-kitchen') + value('unit:truck-3/service-seconds')) * 1_000
  const target = (key: string) => Date.parse(inputs.jobs.find(job => job.key === key)!.target!.finishBy)
  const lateMinutes = (finish: number, key: string) => Math.max(0, finish - target(key)) / timeUnitMs.min
  const float = (finish: number) => ({ workingHours: (windowEnd - finish) / hourMs, limitedBy: { kind: 'window-end' as const } })
  const rows: DatedRow[] = [
    { job: 'R-1', start: iso(windowStart), finish: iso(r1Finish), uses: [{ resource: 'truck-3', from: iso(windowStart), to: iso(r1Finish) }], float: float(r1Finish) },
    { job: 'U-1', start: iso(truck2Joins), finish: iso(u1Finish), uses: [{ resource: 'truck-4', from: iso(truck2Joins), to: iso(u1Finish) }], float: float(u1Finish) },
  ]
  const optionStatus = status({
    word: 'validated feasible', run: runBasis(inputs.settings.grid),
    goals: [
      { word: 'best found under budget', goal: 0, value: lateMinutes(u1Finish, 'U-1'), unit: 'min' },
      { word: 'best found under budget', goal: 1, value: lateMinutes(r1Finish, 'R-1'), unit: 'min' },
    ],
  })
  return modelOf(inputs, {
    title: inputs.settings.title,
    options: { at: '2026-09-03T08:00:30.000Z', recommended: 'opt-1', items: [optionOf('opt-1', 'Option 1', optionStatus)] },
    rows: { 'opt-1': rows },
  })
}

/** Every plan-local key and World locator, for the "no ids on routine screens" check. */
export const identifiers = (inputs: PlanInputs): readonly string[] => [
  ...inputs.equipment.map(item => item.key), ...inputs.groups.map(item => item.key), ...inputs.calendars.map(item => item.key),
  ...inputs.resources.map(item => item.key), ...inputs.purchases.map(item => item.key), ...inputs.methods.flatMap(method => [method.key, ...method.options.map(option => option.key)]),
  ...inputs.jobs.map(item => item.key), ...inputs.rules.map(item => item.key),
  ...inputs.equipment.flatMap(item => item.locator ?? []), ...inputs.resources.flatMap(item => item.locator ?? []), ...inputs.jobs.flatMap(item => item.locator ?? []),
  ...inputs.world.facts.flatMap(fact => [fact.id, fact.locator]),
]
