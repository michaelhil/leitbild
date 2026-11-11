// The stored plan aggregate: inputs, results and change log. Every object is strict; keys are plan-local.
import { z } from 'zod'
import { planningFactSchema, planningLocatorSchema, workspaceIdSchema, type PlanningFactBasis } from '@leitbild/contracts'
import { isTimeZone } from '../time/zone.ts'
import { convertUnit, gridSlotMs, isTimeUnit, timeUnitMs, type TimeUnit } from '../time/units.ts'

// ───────────── primitives ─────────────
export const keySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
export const labelSchema = z.string().trim().min(1).max(160)
export const wordsSchema = z.string().trim().min(1).max(600)
/** Any offset is accepted; edits store UTC. */
export const instantSchema = z.iso.datetime({ offset: true })
export const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const weekdaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
export const timeUnitSchema = z.enum(['s', 'min', 'h', 'd'])
export const gridSchema = z.enum(['30s', '30min'])
export const amountSchema = z.number().finite().nonnegative()
export const currencySchema = z.string().regex(/^[A-Z]{3}$/)
export const timeZoneSchema = z.string().min(3).max(64).refine(isTimeZone, 'Not a time zone name Intl knows, e.g. Europe/Oslo')
export const actorSchema = z.object({ kind: z.enum(['human', 'agent', 'service']), id: z.string().max(128).optional(), name: z.string().max(128).optional() }).strict()
export const periodSchema = z.object({ start: instantSchema, end: instantSchema }).strict()
  .refine(period => Date.parse(period.start) < Date.parse(period.end), { message: 'A period ends after it starts', path: ['end'] })

// ───────────── where values come from ─────────────
export const worldRefSchema = z.object({ locator: planningLocatorSchema, fact: z.string().min(1).max(512) }).strict()
export type WorldRef = z.infer<typeof worldRefSchema>
/**
 * Who says so: the planner's own value, an assumption (unconfirmed, flagged), or a reference standard
 * declared as this plan's rule, which the note names.
 */
export const sourceSchema = z.object({ by: z.enum(['planner', 'assumption', 'reference']), note: wordsSchema.optional() }).strict()
  .refine(source => source.by !== 'reference' || source.note !== undefined, { message: 'A reference source names its reference in the note', path: ['note'] })
export type Source = z.infer<typeof sourceSchema>
/**
 * A stored value's origin: a person's source, or World facts. A World value is never stored: it is null
 * and computed with combineWorldFacts from inputs.world.facts (the only copy, written by refresh), so a
 * sum of refs takes the weakest basis and the oldest `at`.
 */
export const originSchema = z.discriminatedUnion('by', [
  sourceSchema,
  z.object({ by: z.literal('world'), refs: z.array(worldRefSchema).min(1).max(4) }).strict(),
])
export type Origin = z.infer<typeof originSchema>

// ───────────── inputs ─────────────
/** A person's value is stored; a World origin's value is null and computed from inputs.world.facts. */
const storedValueIssue = (value: number | null, origin: Origin): string | undefined => {
  if (origin.by === 'world' && value !== null) return 'A World value is computed from the read facts, never stored'
  if (origin.by !== 'world' && value === null) return 'A value given by a person is stored'
  return undefined
}
/** A day of working time is ambiguous (one shift or 24 working hours), so working durations use s, min or h. */
const workingDayIssue = (unit: TimeUnit, calendar: 'working' | 'elapsed'): string | undefined =>
  unit === 'd' && calendar === 'working' ? 'Working time is given in s, min or h; d is for elapsed time' : undefined
export const durationSchema = z.object({
  value: z.number().finite().nonnegative().nullable(),   // null exactly when the origin is World
  unit: timeUnitSchema,
  calendar: z.enum(['working', 'elapsed']),
  // Read in increment 1 by the job list and job panel (T1 "estimate ranges") and the Train A fidelity test.
  range: z.object({ low: z.number().finite().nonnegative(), high: z.number().finite().positive() }).strict().optional(),
  origin: originSchema,
}).strict().superRefine((duration, context) => {
  const value = storedValueIssue(duration.value, duration.origin)
  if (value !== undefined) context.addIssue({ code: 'custom', path: ['value'], message: value })
  const day = workingDayIssue(duration.unit, duration.calendar)
  if (day !== undefined) context.addIssue({ code: 'custom', path: ['unit'], message: day })
})
export const weeklySchema = z.object({ days: z.array(weekdaySchema).min(1).max(7), from: localTimeSchema, to: localTimeSchema }).strict()   // to <= from ends next day
export const calendarSchema = z.object({
  key: keySchema, label: labelSchema, weekly: z.array(weeklySchema).max(14), periods: z.array(periodSchema).max(64), except: z.array(periodSchema).max(64),
  source: sourceSchema,
}).strict()
export const equipmentSchema = z.object({
  key: keySchema, label: labelSchema,
  group: keySchema.optional(),                      // function group for span limits; changing it needs authority
  supportedBy: z.array(keySchema).max(16),          // out while any supporter is out
  locator: planningLocatorSchema.optional(),        // World item; its values live in inputs.world.facts
  // Items that back each other up share one function key, e.g. MFW A and MFW B both 'main-feedwater'.
  // Items of one train in series, such as a cooling chain, do not share a key. Changing it on covered equipment needs authority.
  function: keySchema.optional(),
  source: sourceSchema.optional(),                  // who declares what World does not read: the item itself, or its function
}).strict()
export const groupSchema = z.object({ key: keySchema, label: labelSchema }).strict()
export const attributeSchema = z.object({
  key: keySchema, label: labelSchema,
  value: z.number().finite().nullable(),            // null exactly when the origin is World
  unit: z.string().min(1).max(32),
  changes: z.array(z.object({ at: instantSchema, value: z.number().finite() }).strict()).max(8),   // announced changes
  origin: originSchema,
}).strict().superRefine((attribute, context) => {
  const value = storedValueIssue(attribute.value, attribute.origin)
  if (value !== undefined) context.addIssue({ code: 'custom', path: ['value'], message: value })
})
export const resourceSchema = z.object({
  key: keySchema, label: labelSchema,
  kind: z.enum(['crew', 'tool']),
  count: z.number().int().min(1).max(500),
  crewSize: z.number().int().min(1).max(50).optional(),   // persons per crew, for per-person-hour prices
  calendar: keySchema,
  attributes: z.array(attributeSchema).max(24),
  maxJobs: z.number().int().min(1).optional(),            // plan at most this many jobs ahead for it
  locator: planningLocatorSchema.optional(),
  words: wordsSchema.optional(),                    // shown with the crew or tool (T1), e.g. "Workshop rebuild and tube cleaning only."
  source: sourceSchema,
}).strict()
/** Purchasable capacity: overtime, contractor nights (one purchase, several periods), a tool day, a rebooking. */
export const purchaseSchema = z.object({
  key: keySchema, label: labelSchema, resource: keySchema,
  adds: z.union([z.object({ calendar: keySchema }).strict(), z.object({ periods: z.array(periodSchema).min(1).max(32) }).strict()]),
  replaces: z.array(periodSchema).max(8),           // a rebooking: the booked period is unusable once used
  price: z.object({ perPersonHour: amountSchema.optional(), perPeriodUsed: amountSchema.optional(), once: amountSchema.optional() }).strict(),
  orderBy: instantSchema.optional(),                // unordered past orderBy at the data date: unavailable
  ordered: z.object({ at: instantSchema, by: actorSchema }).strict().optional(),   // charged whether used or not
  allowed: z.boolean(),
}).strict()
export const needSchema = z.object({
  anyOf: z.array(keySchema).min(1).max(8), amount: z.number().int().min(1).max(20),
  where: z.object({ attribute: keySchema, atLeast: z.number().finite(), unit: z.string().min(1).max(32) }).strict().optional(),  // value in force at the job's start
  handover: z.boolean(),
}).strict()
/**
 * A different duration per chosen resource, in the job's unit and calendar: a value, or summed World refs.
 * `source` says who stands behind it, e.g. an assumption when another unit's World values are used.
 */
export const durationWithSchema = z.union([
  z.object({ resource: keySchema, value: z.number().finite().nonnegative(), source: sourceSchema.optional() }).strict(),
  z.object({ resource: keySchema, refs: z.array(worldRefSchema).min(1).max(4), source: sourceSchema.optional() }).strict(),
])
export const jobSchema = z.object({
  key: keySchema, title: labelSchema,
  kind: z.enum(['tag-out', 'work', 'test']),        // test = restore and return-to-service test (mandatory)
  equipment: z.array(keySchema).max(8),             // tag-out/test: what it isolates or restores; work: at most one
  isolation: z.enum(['inside', 'none']),            // work: bracketed by covering tag-outs and tests, or done off the item
  duration: durationSchema,
  durationWith: z.array(durationWithSchema).max(16),
  minimum: z.object({ value: z.number().positive(), unit: timeUnitSchema, words: wordsSchema }).strict().optional(),   // tests only; below needs authority
  needs: z.array(needSchema).max(4),
  continuous: z.boolean(),
  method: z.object({ choice: keySchema, option: keySchema }).strict().optional(),
  notBefore: z.object({ at: instantSchema, words: wordsSchema, source: sourceSchema }).strict().optional(),   // an assumption is scheduled at it and flagged
  target: z.object({ finishBy: instantSchema, words: wordsSchema }).strict().optional(),                      // soft, for the lateness goal
  checks: z.array(z.object({ equipment: keySchema, fact: z.string().min(1).max(512), expect: z.union([z.boolean(), z.string(), z.number()]), words: wordsSchema }).strict()).max(4),   // preconditions at read time
  lock: z.object({ start: instantSchema, words: wordsSchema.optional() }).strict().optional(),
  tags: z.array(keySchema).max(8),
  locator: planningLocatorSchema.optional(),        // the World item the job serves; read in the same request as its resources
}).strict().superRefine((job, context) => {
  if (job.minimum && job.kind !== 'test') context.addIssue({ code: 'custom', path: ['minimum'], message: 'A minimum is declared only on mandatory return-to-service tests' })
  const day = job.minimum && workingDayIssue(job.minimum.unit, job.duration.calendar)
  if (day) context.addIssue({ code: 'custom', path: ['minimum', 'unit'], message: day })
})
/**
 * Identity is (from, to, type). The lag depends on the type:
 * - FS: clock time from the earlier job's finish to the later job's start;
 * - SS: the later job may start once the earlier job has done this much of its own working time;
 * - FF: at least this much of the later job's working time falls after the earlier job's finish.
 */
export const linkSchema = z.object({
  from: keySchema, to: keySchema, type: z.enum(['FS', 'SS', 'FF']),
  lag: z.object({ value: z.number().finite().nonnegative(), unit: timeUnitSchema }).strict(),
  method: z.object({ choice: keySchema, option: keySchema }).strict().optional(),
  words: wordsSchema.optional(),
}).strict()
export const methodChoiceSchema = z.object({
  key: keySchema, label: labelSchema,
  options: z.array(z.object({ key: keySchema, label: labelSchema, fixedCost: amountSchema, words: wordsSchema.optional() }).strict()).min(2).max(4),
}).strict()
// The window is settings.window; "one at a time" is a count-1 resource. Neither is a rule.
export const ruleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('protected'), key: keySchema, equipment: z.array(keySchema).min(1).max(64), words: wordsSchema, source: sourceSchema }).strict(),
  z.object({
    kind: z.literal('keep-in-service'), key: keySchema,
    members: z.array(z.union([z.object({ equipment: keySchema }).strict(), z.object({ resource: keySchema }).strict()])).min(2).max(32),
    atLeast: z.number().int().min(1), during: periodSchema.optional(), words: wordsSchema, source: sourceSchema,
  }).strict().superRefine((rule, context) => {
    const names = rule.members.map(member => 'equipment' in member ? `equipment ${member.equipment}` : `resource ${member.resource}`)
    if (new Set(names).size !== names.length) context.addIssue({ code: 'custom', path: ['members'], message: 'Each member is named once' })
    if (rule.atLeast > rule.members.length) context.addIssue({ code: 'custom', path: ['atLeast'], message: `At least ${rule.atLeast} of ${rule.members.length} members cannot be kept in service` })
  }),
  z.object({
    kind: z.literal('span-limit'), key: keySchema, group: keySchema, limit: z.object({ value: z.number().positive(), unit: timeUnitSchema }).strict(),
    singleEntry: z.boolean(), words: wordsSchema, source: sourceSchema,
  }).strict(),
  // A hard deadline, e.g. a surveillance due: no plan that finishes the job after finishBy is feasible.
  // The same word as the soft job.target.finishBy, which only feeds the lateness goal.
  z.object({ kind: z.literal('due'), key: keySchema, job: keySchema, finishBy: instantSchema, words: wordsSchema, source: sourceSchema }).strict(),
])
export const goalMetricSchema = z.enum(['span-over', 'finish', 'extra-cost', 'unavailable-hours', 'lateness'])
export type GoalMetric = z.infer<typeof goalMetricSchema>
/** extra-cost is counted in a currency; every other goal is time, in h, min or s. */
export const goalUnitIssue = (metric: GoalMetric, unit: string): string | undefined => {
  if (metric === 'extra-cost') return currencySchema.safeParse(unit).success ? undefined : `${metric} is counted in a currency such as NOK, not ${unit}`
  return ['h', 'min', 's'].includes(unit) ? undefined : `${metric} is counted in h, min or s, not ${unit}`
}
export const goalSchema = z.object({
  metric: goalMetricSchema,
  scope: z.object({ groups: z.array(keySchema).max(16).optional(), tags: z.array(keySchema).max(8).optional() }).strict().optional(),
  threshold: z.object({ value: z.number().finite().nonnegative(), unit: z.string().min(1).max(8) }).strict().optional(),
  tolerance: z.object({ value: z.number().finite().nonnegative(), unit: z.string().min(1).max(8) }).strict(),
}).strict().superRefine((goal, context) => {
  for (const field of ['threshold', 'tolerance'] as const) {
    const unit = goal[field]?.unit
    const issue = unit === undefined ? undefined : goalUnitIssue(goal.metric, unit)
    if (issue !== undefined) context.addIssue({ code: 'custom', path: [field, 'unit'], message: issue })
  }
})
export const worldFactCopySchema = planningFactSchema.extend({ locator: planningLocatorSchema }).strict()
export type WorldFactCopy = z.infer<typeof worldFactCopySchema>

export const planInputsSchema = z.object({
  settings: z.object({
    title: labelSchema, purpose: wordsSchema.optional(),
    timeZone: timeZoneSchema.nullable(), window: periodSchema.nullable(), dataDate: instantSchema.nullable(),
    grid: gridSchema,
    currency: currencySchema,
    run: z.object({ id: z.string().min(1).max(128), linkedAt: instantSchema }).strict().nullable(),
    scenario: z.object({ id: z.string().min(1).max(128), title: labelSchema }).strict().optional(),   // the World Scenario to start and link
  }).strict(),
  equipment: z.array(equipmentSchema).max(500),
  groups: z.array(groupSchema).max(64),
  calendars: z.array(calendarSchema).max(64),
  resources: z.array(resourceSchema).max(100),
  purchases: z.array(purchaseSchema).max(64),
  methods: z.array(methodChoiceSchema).max(8),
  jobs: z.array(jobSchema).max(2_000),
  links: z.array(linkSchema).max(10_000),
  rules: z.array(ruleSchema).max(200),
  goals: z.array(goalSchema).min(1).max(6),
  world: z.object({ refreshedAt: instantSchema.nullable(), facts: z.array(worldFactCopySchema).max(4_000) }).strict(),   // the only copy, written by refresh
}).strict().superRefine((inputs, context) => {
  const window = inputs.settings.window
  if (window === null) return
  inputs.rules.forEach((rule, index) => {
    if (rule.kind !== 'due') return
    const by = Date.parse(rule.finishBy)
    if (!(Date.parse(window.start) < by && by <= Date.parse(window.end))) {
      context.addIssue({ code: 'custom', path: ['rules', index, 'finishBy'], message: 'A due time lies inside the plan window, after its start and no later than its end' })
    }
  })
})
export type PlanInputs = z.infer<typeof planInputsSchema>

// ───────────── results kept in the plan ─────────────
const before = (earlier: string, later: string): boolean => Date.parse(earlier) < Date.parse(later)
/** A certificate proves infeasibility: the work it names exceeds the capacity it names, over a real interval. */
export const certificateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chain'), jobs: z.array(keySchema).min(1).max(64), workHours: z.number().finite(), calendars: z.array(keySchema), availableHours: z.number().finite().nonnegative(), from: instantSchema, by: instantSchema }).strict()
    .superRefine((cause, context) => {
      if (!(cause.workHours > cause.availableHours)) context.addIssue({ code: 'custom', path: ['workHours'], message: 'A chain certificate needs more work than available hours' })
      if (!before(cause.from, cause.by)) context.addIssue({ code: 'custom', path: ['by'], message: 'A chain certificate interval ends after it starts' })
    }),
  z.object({ kind: z.literal('energy'), resources: z.array(keySchema).min(1).max(8), jobs: z.array(keySchema).max(128), requiredHours: z.number().finite(), availableHours: z.number().finite().nonnegative(), from: instantSchema, to: instantSchema, span: keySchema.optional() }).strict()
    .superRefine((cause, context) => {
      if (!(cause.requiredHours > cause.availableHours)) context.addIssue({ code: 'custom', path: ['requiredHours'], message: 'An energy certificate needs more required than available hours' })
      if (!before(cause.from, cause.to)) context.addIssue({ code: 'custom', path: ['to'], message: 'An energy certificate interval ends after it starts' })
    }),
  z.object({ kind: z.literal('availability'), rule: keySchema, items: z.array(keySchema).max(32), from: instantSchema, to: instantSchema }).strict()
    .refine(cause => before(cause.from, cause.to), { message: 'An availability certificate interval ends after it starts', path: ['to'] }),
  z.object({ kind: z.literal('temporal'), steps: z.array(z.object({ job: keySchema, via: z.enum(['link', 'bracket', 'support-order', 'span-limit', 'window', 'due', 'release', 'lock']) }).strict()).max(32) }).strict(),
])
export type Certificate = z.infer<typeof certificateSchema>

const boundSourceSchema = z.enum(['logic+calendars', 'crew-energy', 'availability-rule', 'fixed-costs'])
/**
 * How a goal's lower bound was derived, in plan terms, for the record and the planner's words. Lane K does
 * not trust it: a "proven optimal" stands only when lane K re-derives a bound at least as high (check/optimal.ts).
 * zero: the goal is at 0, below which no goal goes. earliest-finish: these jobs cannot finish earlier (links,
 * releases, the window, calendars). crew-energy: the jobs need the resource in every choice, and its hours from
 * the window start reach the work only at `finish`. fixed-costs: costs every plan pays. least-outage: each item is
 * out at least from its latest first tag-out to its earliest last test. least-span: each group's least span.
 */
export const boundCertificateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('zero') }).strict(),
  z.object({ kind: z.literal('earliest-finish'), jobs: z.array(z.object({ job: keySchema, finish: instantSchema }).strict()).min(1).max(32) }).strict(),
  z.object({ kind: z.literal('crew-energy'), resource: keySchema, jobs: z.array(keySchema).max(128), requiredHours: z.number().finite().nonnegative(), finish: instantSchema }).strict(),
  z.object({ kind: z.literal('fixed-costs'), items: z.array(z.object({ key: keySchema, amount: z.number().finite().nonnegative() }).strict()).max(64) }).strict(),
  z.object({ kind: z.literal('least-outage'), items: z.array(z.object({ item: keySchema, from: instantSchema, to: instantSchema }).strict()).max(64) }).strict(),
  z.object({ kind: z.literal('least-span'), spans: z.array(z.object({ group: keySchema, hours: z.number().finite().nonnegative() }).strict()).max(16) }).strict(),
])
export type BoundCertificate = z.infer<typeof boundCertificateSchema>
const runBasisSchema = z.object({
  grid: gridSchema, engine: z.string(), formulation: z.string(),   // proofs are reused only on an equal inputs revision and formulation
  seed: z.number().int(), budget: z.object({ evals: z.number().int(), cpuMs: z.number().int(), wallMs: z.number().int() }).strict(),
  stoppedBy: z.enum(['done', 'evals', 'cpu', 'wall', 'memory', 'cancelled']), stoppedByWho: z.enum(['person', 'host']).optional(),
  evals: z.number().int(), cpuMs: z.number().int(),
}).strict()

/** The plan's status words. Results and the Assistant use these and no others. */
export const statusWordSchema = z.enum(['validated feasible', 'proven infeasible', 'invalid input', 'unsupported feature', 'cancelled', 'unresolved'])
export type StatusWord = z.infer<typeof statusWordSchema>
/** proven optimal: the value equals its bound at the goal's resolution and every earlier goal is proven. */
export const goalWordSchema = z.enum(['proven optimal', 'best found under budget'])
export type GoalWord = z.infer<typeof goalWordSchema>

/** Goal positions whose "proven optimal" follows a goal that is not proven. */
export const goalOrderBreaks = (words: readonly GoalWord[]): readonly number[] =>
  words.flatMap((word, index) => word === 'proven optimal' && words.slice(0, index).some(earlier => earlier !== 'proven optimal') ? [index] : [])

/**
 * The step at which a goal value is meaningful: the grid for time units, 1 for a currency. Bounds from a
 * MILP carry float noise, so value and bound are compared at this resolution, never exactly.
 */
export const goalResolution = (unit: string, grid: z.infer<typeof gridSchema>): number | undefined => {
  if (isTimeUnit(unit)) return gridSlotMs[grid] / timeUnitMs[unit]
  return currencySchema.safeParse(unit).success ? 1 : undefined
}

const goalStatusSchema = z.discriminatedUnion('word', [
  z.object({ word: z.literal(goalWordSchema.enum['proven optimal']), goal: z.number().int().nonnegative(), value: z.number().finite(), unit: z.string(),
    bound: z.object({ value: z.number().finite(), source: boundSourceSchema, certificate: boundCertificateSchema }).strict() }).strict(),
  z.object({ word: z.literal(goalWordSchema.enum['best found under budget']), goal: z.number().int().nonnegative(), value: z.number().finite(), unit: z.string(),
    bound: z.object({ value: z.number().finite(), source: boundSourceSchema, certificate: boundCertificateSchema.optional() }).strict().optional() }).strict(),
])
const problemSchema = z.object({ about: z.array(keySchema).max(4), code: z.string().max(64) }).strict()   // prose is generated from code + keys

/** A discriminated union that cannot hold a contradiction. Planner prose is generated from it, never stored. */
export const statusSchema = z.discriminatedUnion('word', [
  z.object({ word: z.literal(statusWordSchema.enum['validated feasible']), goals: z.array(goalStatusSchema).max(6), run: runBasisSchema }).strict()
    .superRefine((status, context) => {
      const breaks = new Set(goalOrderBreaks(status.goals.map(goal => goal.word)))
      status.goals.forEach((goal, index) => {
        if (goal.goal !== index) context.addIssue({ code: 'custom', path: ['goals', index, 'goal'], message: 'Goals are listed in order' })
        if (breaks.has(index)) context.addIssue({ code: 'custom', path: ['goals', index, 'word'], message: 'A later goal is proven only when every earlier goal is' })
        const resolution = goalResolution(goal.unit, status.run.grid)
        if (resolution === undefined) {
          context.addIssue({ code: 'custom', path: ['goals', index, 'unit'], message: `No resolution for the goal unit ${goal.unit}` })
          return
        }
        if (goal.word === 'proven optimal' && !(Math.abs(goal.value - goal.bound.value) < resolution / 2)) {
          context.addIssue({ code: 'custom', path: ['goals', index, 'bound'], message: 'Proven optimal means the value equals its bound' })
        }
        if (goal.word === 'best found under budget' && goal.bound !== undefined && !(goal.bound.value - goal.value < resolution / 2)) {
          context.addIssue({ code: 'custom', path: ['goals', index, 'bound'], message: 'A lower bound cannot exceed the value' })
        }
      })
    }),
  z.object({ word: z.literal(statusWordSchema.enum['proven infeasible']), cause: certificateSchema, run: runBasisSchema }).strict(),
  z.object({ word: z.literal(statusWordSchema.enum['invalid input']), problems: z.array(problemSchema).min(1).max(16) }).strict(),
  z.object({ word: z.literal(statusWordSchema.enum['unsupported feature']), problems: z.array(problemSchema).min(1).max(16) }).strict(),   // an unmodelled rule only
  z.object({ word: z.literal(statusWordSchema.enum.cancelled), run: runBasisSchema }).strict(),   // nothing found before the stop
  z.object({ word: z.literal(statusWordSchema.enum.unresolved), run: runBasisSchema,
    attempt: z.object({ job: keySchema, wouldFinish: instantSchema, pastWindowHours: z.number().nonnegative() }).strict().optional() }).strict(),   // not proof
])
export type Status = z.infer<typeof statusSchema>

export const datedRowSchema = z.object({
  job: keySchema, start: instantSchema, finish: instantSchema,
  uses: z.array(z.object({ resource: keySchema, from: instantSchema, to: instantSchema, purchase: keySchema.optional() }).strict()).max(64),   // the checker verifies them
  // Total float to the nearest binding limit, in the job's working hours, and which limit binds.
  float: z.object({
    workingHours: z.number().finite().nonnegative(),
    limitedBy: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('window-end') }).strict(),
      z.object({ kind: z.literal('span-limit'), rule: keySchema }).strict(),
      z.object({ kind: z.literal('due'), rule: keySchema }).strict(),
    ]),
  }).strict(),
}).strict()
export const optionSchema = z.object({
  key: keySchema, label: labelSchema,
  variant: z.object({ methods: z.array(z.object({ choice: keySchema, option: keySchema }).strict()), purchases: z.array(keySchema) }).strict(),
  status: statusSchema,
  rows: z.array(datedRowSchema).max(2_000),
  metrics: z.array(z.object({ id: z.string(), value: z.number(), unit: z.string() }).strict()).max(32),
  inputsRevision: z.number().int().positive(),      // with run.formulation: proofs reused only on an exact match
}).strict()
export const optionSetSchema = z.object({ at: instantSchema, by: actorSchema, options: z.array(optionSchema).max(8), recommended: keySchema.optional() }).strict()
/** The edit kinds of plan/edit-schema.ts (a test keeps the two lists equal). */
export const editKindSchema = z.enum(['plan', 'equipment', 'calendar', 'resource', 'purchase', 'method', 'job', 'link', 'rule', 'goals', 'remove'])
/** What changed the inputs: an edit kind, or a refresh of World facts. */
export const changeKindSchema = z.enum([...editKindSchema.options, 'refresh'])
export const changeSchema = z.object({
  seq: z.number().int().positive(), at: instantSchema, by: actorSchema, revision: z.number().int().positive(),
  summary: z.string().min(1).max(240), kinds: z.array(changeKindSchema).max(16), reason: wordsSchema.optional(),
  authority: z.object({ name: labelSchema, reason: wordsSchema }).strict().optional(),
}).strict()
export const planSchema = z.object({
  id: z.uuid(), workspaceId: workspaceIdSchema, revision: z.number().int().positive(),
  createdAt: instantSchema, updatedAt: instantSchema,
  inputs: planInputsSchema,
  options: optionSetSchema.nullable(),               // the latest set only
  baselines: z.array(z.object({ key: keySchema, name: labelSchema, note: wordsSchema.optional(), at: instantSchema, by: actorSchema, option: optionSchema, inputs: planInputsSchema }).strict()).max(32),
  changes: z.array(changeSchema).max(500), droppedChanges: z.number().int().nonnegative(),
}).strict()
export type Plan = z.infer<typeof planSchema>

/**
 * The size of plan Generate takes. Until the owner decides (`decided` false) nothing is certified: planners
 * read "Certified plan size: pending the owner's decision", and `maxJobs` is only where Generate refuses
 * meanwhile. `evidence` is the measurement behind it, detail shown on request.
 */
export const certifiedSizeSchema = z.object({ decided: z.boolean(), family: wordsSchema, maxJobs: z.number().int().positive(), evidence: wordsSchema }).strict()
export type CertifiedSize = z.infer<typeof certifiedSizeSchema>

// ───────────── summed World values ─────────────
/** Weakest first. A sum is only as good as its weakest part. */
const basisStrength: Readonly<Record<PlanningFactBasis, number>> = { 'owner-estimate': 0, configured: 1, design: 2, observed: 3 }

export type CombinedWorldValue =
  | { readonly ok: true; readonly value: number; readonly unit: string; readonly basis: PlanningFactBasis; readonly at: string }
  | { readonly ok: false; readonly code: 'world_value_unread' | 'world_value_ambiguous' | 'world_value_not_number' | 'unit_unknown' | 'unit_mismatch'; readonly ref: WorldRef; readonly unit?: string }

/**
 * Sums the World facts that `refs` name, converted to `unit`. The sum takes the weakest basis
 * (owner-estimate < configured < design < observed) and the oldest `at` of its parts.
 */
export const combineWorldFacts = (refs: readonly WorldRef[], facts: readonly WorldFactCopy[], unit: string): CombinedWorldValue => {
  if (refs.length === 0) throw new RangeError('A World value names at least one fact')
  let value = 0
  let weakest: WorldFactCopy | undefined
  let oldest: WorldFactCopy | undefined
  for (const ref of refs) {
    const matches = facts.filter(fact => fact.locator === ref.locator && fact.id === ref.fact)
    if (matches.length === 0) return { ok: false, code: 'world_value_unread', ref }
    if (matches.length > 1) return { ok: false, code: 'world_value_ambiguous', ref }
    const fact = matches[0]!
    if (typeof fact.value !== 'number' || fact.unit === undefined) return { ok: false, code: 'world_value_not_number', ref }
    const converted = convertUnit(fact.value, fact.unit, unit)
    if (!converted.ok) return { ok: false, code: converted.code, ref, unit: converted.unit }
    value += converted.value
    if (weakest === undefined || basisStrength[fact.basis] < basisStrength[weakest.basis]) weakest = fact
    if (oldest === undefined || Date.parse(fact.at) < Date.parse(oldest.at)) oldest = fact
  }
  return { ok: true, value, unit, basis: weakest!.basis, at: oldest!.at }
}
