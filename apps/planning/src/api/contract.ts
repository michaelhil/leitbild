// Operation inputs and outputs. The boundary validates with these exact schemas; what is published to
// Host and the Assistant is stripForPublication(exact).
import { z } from 'zod'
import { workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { editSchema, sourceInputSchema } from '../plan/edit-schema.ts'
import {
  calendarSchema, certifiedSizeSchema, changeSchema, datedRowSchema, dueRuleSchema, equipmentSchema, goalProofBreaks, goalWordSchema, gridSchema, groupSchema, instantSchema, jobSchema,
  caveatSchema, keySchema, labelSchema, leadSchema, linkSchema, methodChoiceSchema, metricSchema, optionLeadIssue, optionLeadRefinement, optionWithoutRowsShape, statusSchema, planInputsSchema, purchaseSchema, resourceSchema, ruleSchema,
  spanLimitRuleSchema, statusWordSchema, timeUnitSchema, wordsSchema, worldFactCopySchema,
} from '../plan/schema.ts'

// ───────────── inputs ─────────────
export const createInputSchema = z.object({
  edits: z.array(editSchema).max(60).optional().describe('Edits applied to the new plan, in order; same vocabulary as planning.plan.edit'),
  // Set once, at create: the edit vocabulary cannot change the grid of a plan with jobs.
  grid: gridSchema.optional().describe('Time step of the plan: 30min for work weeks, 30s for jobs of a few minutes; default 30min'),
}).strict()
export const editInputSchema = z.object({
  edits: z.array(editSchema).min(1).max(60).describe('Applied together or not at all'),
  preview: z.boolean().optional().describe('true: show the consequence and the rule check without saving'),
  option: keySchema.optional().describe('With preview: the option to re-time, as on the timeline; default the recommended one'),
  reason: wordsSchema.optional().describe('Why, for the change log'),
  authority: z.object({ name: labelSchema.describe('The named person who agreed, as they gave their name in this conversation'), reason: wordsSchema.describe('Their reason, in their words') }).strict().optional()
    .describe('A named person\'s agreement to remove or weaken a hard rule, a support, a group membership, a tag-out or test, a precondition or a test minimum, given by that person in the plan screen. An Assistant\'s edit that needs it is refused. Ask them; never fill this in yourself'),
}).strict()
/** A what-if's extra hard rule as Generate takes it: the stored alsoRuleSchema, every field described. */
const ruleWords = wordsSchema.describe('The rule in plain words')
const alsoInputSchema = z.discriminatedUnion('kind', [
  spanLimitRuleSchema.extend({
    kind: spanLimitRuleSchema.shape.kind.describe('span-limit: a shorter outage limit'), key: keySchema.describe('A key no plan rule has'),
    group: keySchema.describe('Function group'),
    limit: z.object({ value: z.number().positive().describe('Value'), unit: timeUnitSchema.describe('Unit') }).strict().describe('Longest outage'),
    singleEntry: z.boolean().describe('One continuous outage'), words: ruleWords, source: sourceInputSchema,
  }),
  dueRuleSchema.extend({
    kind: dueRuleSchema.shape.kind.describe('due: back by a time'), key: keySchema.describe('A key no plan rule has'),
    job: keySchema.describe('The job that must finish'), finishBy: instantSchema.describe('Latest finish, inside the window'), words: ruleWords, source: sourceInputSchema,
  }),
])
export const generateInputSchema = z.object({
  variants: z.array(z.object({
    label: labelSchema.optional().describe('Name for this what-if'),
    methods: z.array(z.object({ choice: keySchema.describe('Method key'), option: keySchema.describe('Option key') }).strict()).max(8).optional().describe('Fix these method choices; others are searched'),
    buy: z.union([z.enum(['allowed', 'none', 'no-extra-crew-hours']), z.array(keySchema)]).optional()
      .describe('Purchases Generate may use. no-extra-crew-hours = "days only": no purchase that adds working time to a crew; rebookings and tool days stay allowed'),
    also: z.array(alsoInputSchema).min(1).max(1).optional().describe('One extra hard rule for this what-if only: a shorter outage limit, or a due time'),
    lead: z.union([
      leadSchema.options[0].extend({ goal: leadSchema.options[0].shape.goal.describe('One of the plan\'s goals, by its id: 0 is the first') }),
      leadSchema.options[1].extend({ group: keySchema.describe('A function group: its outage as short as possible') }),
    ]).optional().describe('Solve this first, for this what-if only; the plan\'s goals are not changed'),
  }).strict()).max(8).optional().describe('What-ifs, without changing the plan; default one per method option'),
  seconds: z.number().int().min(1).max(20).optional().describe('Time budget; default 20'),
  keep: z.literal(true).optional().describe('Add these what-ifs to the options already there, each starting from the best stored option that buys no more'),
}).strict()
export const explainInputSchema = z.object({
  ask: z.enum(['why-start', 'finish', 'refusal', 'recommended', 'versus']).describe('What to explain; versus: what differs from an option of the previous set'),
  option: keySchema.optional().describe('Default: the recommended option'),
  job: keySchema.optional().describe('why-start: the job; finish: the job whose finish (default the last)'),
  versus: z.object({ previous: keySchema.describe('Option key in the previous set') }).strict().optional().describe('versus: the option to compare with'),
  cursor: z.string().max(256).optional().describe('From a previous answer'),
}).strict().refine(input => (input.ask === 'versus') === (input.versus !== undefined), { message: 'versus names the option to compare with, and only for ask versus', path: ['versus'] })
export const readInputSchema = z.object({
  section: z.enum(['summary', 'jobs', 'rules', 'crews', 'sources', 'options', 'schedule', 'history', 'buys', 'previous']).optional().describe('Default summary; buys: what bought crew time gains; previous: the options before the last input change'),
  option: keySchema.optional().describe('schedule: which option; default recommended'),
  cursor: z.string().max(256).optional().describe('From a previous page'),
}).strict()
export const baselineInputSchema = z.object({
  option: keySchema.describe('Option key'),
  name: labelSchema.describe('Baseline name'),
  note: wordsSchema.optional().describe('Hand-over note'),
}).strict()
export const refreshInputSchema = z.object({ plan: z.uuid().describe('The plan whose World values to read again') }).strict()
export const deleteInputSchema = z.object({}).strict()

// ───────────── outputs ─────────────
const lineOut = { word: goalWordSchema, value: z.number().finite(), unit: z.string(), bound: z.number().finite().optional(), gap: z.number().finite().optional() }
/**
 * The status as the Assistant sees it: the plan's own status and goal words, each goal named by the plan's id,
 * in goal order, under the same proof rule as the stored status. A what-if's `lead` is what it solved first: a
 * plan goal by id, or a group's own goal line. Prose is generated beside it, never stored.
 */
export const statusOutSchema = z.object({
  word: statusWordSchema,
  goals: z.array(z.object({ goal: z.number().int().nonnegative(), ...lineOut }).strict()).max(6),
  lead: z.union([z.object({ goal: z.number().int().nonnegative() }).strict(), z.object({ group: keySchema, ...lineOut }).strict()]).optional(),
  cause: z.object({ kind: z.string(), requiredHours: z.number().optional(), availableHours: z.number().optional(), about: z.array(keySchema).max(4) }).strict().optional(),
}).strict().superRefine((status, context) => {
  if (status.word !== 'validated feasible' && status.goals.length > 0) context.addIssue({ code: 'custom', path: ['goals'], message: 'Only a validated feasible option has goal values' })
  if (status.word !== 'validated feasible' && status.lead !== undefined) context.addIssue({ code: 'custom', path: ['lead'], message: 'Only a validated feasible what-if has a leading goal' })
  if ((status.word === 'proven infeasible') !== (status.cause !== undefined)) context.addIssue({ code: 'custom', path: ['cause'], message: 'A cause is given exactly when the option is proven infeasible' })
  const lead = status.lead
  // With a lead this rule replaces the goal-order rule (adversary part 2 check, fix C).
  for (const index of goalProofBreaks(status.goals.map(goal => goal.word), lead)) {
    context.addIssue({ code: 'custom', path: ['goals', index, 'word'], message: lead === undefined ? 'A later goal is proven only when every earlier goal is' : 'With a leading goal, only that goal may be proven' })
  }
  if (lead !== undefined && 'goal' in lead && lead.goal >= status.goals.length) context.addIssue({ code: 'custom', path: ['lead', 'goal'], message: 'The leading goal is one of the plan\'s goals' })
  const lines = [...status.goals.map((goal, index) => ({ line: goal, path: ['goals', index] })), ...(lead !== undefined && 'group' in lead ? [{ line: lead, path: ['lead'] }] : [])]
  status.goals.forEach((goal, index) => {
    if (goal.goal !== index) context.addIssue({ code: 'custom', path: ['goals', index, 'goal'], message: 'Goals are listed in order, by the plan\'s ids' })
  })
  for (const { line, path } of lines) {
    if (line.word === 'proven optimal' && line.bound === undefined) context.addIssue({ code: 'custom', path: [...path, 'bound'], message: 'Proven optimal names its bound' })
    if ((line.bound === undefined) !== (line.gap === undefined)) context.addIssue({ code: 'custom', path: [...path, 'gap'], message: 'A bound comes with its gap' })
  }
})
export type StatusOut = z.infer<typeof statusOutSchema>

export const writeResultSchema = z.object({
  plan: z.object({ id: z.uuid(), title: labelSchema, revision: z.number().int().positive() }).strict(),
  target: z.object({ kind: z.literal('resource'), ref: workspaceResourceReferenceSchema }).strict(),   // the plan, as the next call names it
  changed: z.array(z.string().max(200)).max(12),
  attention: z.array(z.object({ kind: z.enum(['refusal', 'not-ready', 'rule', 'limit', 'world', 'decision', 'stale', 'warning']), text: z.string().max(240), about: z.array(keySchema).max(4) }).strict()).max(6),
  problems: z.array(z.object({ edit: z.number().int().nonnegative().optional(), about: z.array(keySchema).max(4), code: z.string().max(64), text: z.string().max(300), expected: z.unknown().optional() }).strict()).max(8),
  preview: z.object({
    saved: z.literal(false), consequence: z.string().max(300), violations: z.array(z.string().max(600)).max(6), weakens: z.array(keySchema).max(6), nearestAllowed: instantSchema.optional(),
    // What moved and why: each job whose start or finish the re-timing changed, where it goes, and the
    // edits that moved it (indexes into `edits`; applied together, all of them).
    moved: z.array(z.object({ job: keySchema, start: instantSchema, finish: instantSchema, because: z.array(z.number().int().nonnegative()).min(1).max(60) }).strict()).max(6).optional(),
  }).strict().optional(),
}).strict()
/** Every operation result fits 4 KB of JSON. */
export const resultLimitBytes = 4_096
const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length

/**
 * Something about an option a planner should see beside its status, which no hard rule refuses. redundancy:
 * items out together that no keep-in-service rule covers, e.g. "Both MFW pumps A and B are out Tue
 * 08:00-14:00 and no keep-in-service rule covers them". `about` names the jobs and equipment involved.
 * above-certified-size: the option was solved above the certified size (its `sizeCaution`); it keeps every
 * hard rule but may not be near the best. `about` is empty.
 */
export const optionWarningSchema = z.object({
  kind: z.enum(['redundancy', 'above-certified-size']),
  text: z.string().min(1).max(240),
  about: z.array(keySchema).max(4),
}).strict()
export type OptionWarning = z.infer<typeof optionWarningSchema>

export const generateResultSchema = z.object({
  plan: z.object({ id: z.uuid(), revision: z.number().int().positive() }).strict(),
  options: z.array(z.object({
    key: keySchema, label: z.string().max(80), status: statusOutSchema, span: z.number().optional(), cost: z.number().optional(),
    warnings: z.array(optionWarningSchema).max(4),
  }).strict()).max(8),
  recommended: keySchema.optional(),
  text: z.string().max(300),   // one generated sentence for the recommended option
}).strict().refine(result => byteLength(result) <= resultLimitBytes, `A generate result fits ${resultLimitBytes} B; read the options section for the rest`)
/** One cause of a job's time, as explain names it. */
const becauseSchema = z.object({
  kind: z.enum(['link', 'crew', 'tool', 'shift', 'availability', 'span-limit', 'window', 'release', 'lock', 'data-date', 'late-as-possible', 'purchase-not-allowed']),
  // Every name says what it names, so no reader guesses: the screen and the Assistant look it up as that kind.
  about: z.array(z.object({ kind: z.enum(['job', 'resource', 'calendar', 'rule', 'equipment', 'purchase']), key: keySchema }).strict()).max(6), until: instantSchema.optional(),
}).strict()
/** A plan goal by its id, its position in the plan's goals. */
const goalIdSchema = z.number().int().nonnegative()
const distinct = (values: readonly unknown[]): boolean => new Set(values).size === values.length
const ascending = (values: readonly number[]): boolean => values.every((value, index) => index === 0 || values[index - 1]! < value)
type Issue = (path: Array<string | number>, message: string) => void
const issuesOf = (context: z.core.$RefinementCtx): Issue => (path, message) => context.addIssue({ code: 'custom', path, message })

/**
 * explain recommended (decision "Lane P batch 2", 3): why `option` is recommended, against `against`, the best
 * other ranked option (absent: none to compare with). `deciding`: the first goal on which their ranking keys
 * differ. `goals`: each plan goal's value, and the other option's beside it. `caveats`: what each method pick
 * leaves unpriced, with the other option's value for the same caveat. `outage`: the proven floor of the
 * longest outage, in hours, for the outage goal's group, present only when lane K has stored one (fix round
 * G4); without it the outage line is left out. Prose is generated from these, never stored.
 */
export const recommendedFactsSchema = z.object({
  option: keySchema, against: keySchema.optional(), deciding: goalIdSchema.optional(),
  goals: z.array(z.object({ goal: goalIdSchema, value: z.number().finite(), against: z.number().finite().optional(), unit: z.string() }).strict()).max(6),
  caveats: z.array(z.object({
    choice: keySchema, option: keySchema, label: caveatSchema.shape.label, value: z.number().finite().optional(), unit: caveatSchema.shape.unit, against: z.number().finite().optional(),
  }).strict()).max(32),
  outage: z.object({ goal: goalIdSchema, group: keySchema, hours: z.number().finite().nonnegative() }).strict().optional(),
}).strict().superRefine((facts, context) => {
  const issue = issuesOf(context)
  const compared = facts.against !== undefined
  if (facts.against === facts.option) issue(['against'], 'An option is recommended against another option')
  if (facts.deciding !== undefined && !compared) issue(['deciding'], 'A deciding goal needs the option it decides against')
  const ids = facts.goals.map(line => line.goal)
  if (!ascending(ids)) issue(['goals'], 'Goals are listed once each, in the plan\'s order')
  if (facts.deciding !== undefined && !ids.includes(facts.deciding)) issue(['deciding'], 'The deciding goal is one of the goals listed')
  facts.goals.forEach((line, index) => { if ((line.against !== undefined) !== compared) issue(['goals', index, 'against'], 'Each goal gives the other option\'s value exactly when there is one') })
  facts.caveats.forEach((caveat, index) => {
    if ((caveat.value === undefined) !== (caveat.unit === undefined)) issue(['caveats', index, 'unit'], 'A caveat value comes with its unit')
    if (caveat.against !== undefined && (!compared || caveat.value === undefined)) issue(['caveats', index, 'against'], 'The other option\'s caveat value is given only beside a value, against an option')
  })
  const outage = facts.outage
  if (outage !== undefined && !ids.includes(outage.goal)) issue(['outage', 'goal'], 'The outage goal is one of the goals listed')
})
export type RecommendedFacts = z.infer<typeof recommendedFactsSchema>

const timesSchema = z.object({ start: instantSchema, finish: instantSchema }).strict()
/**
 * explain versus {previous} (decision "Lane P batch 2", 3): `option` of the current set against `previous` of
 * the previous set. `from` is the previous option's inputs revision and `to` the plan's; `changes` the change
 * log's own summaries between them, and `complete` whether the log still holds every one. `goals` only when
 * the goals stayed as they were. `outages`: the longest outage of each group with a span rule, now and then,
 * in hours, one entry per group (fix round G5; absent until both options' figures are stored). `methods`
 * the picks that differ; `buys` the purchases added and dropped; `moved` jobs in both at another start or
 * finish (at most 20, `movedMore` counts the rest); `added` and `removed` jobs in only one of the two.
 */
export const versusFactsSchema = z.object({
  option: keySchema, previous: keySchema,
  from: z.number().int().positive(), to: z.number().int().positive(), complete: z.boolean(),
  changes: z.array(z.object({ revision: z.number().int().positive(), summary: changeSchema.shape.summary }).strict()).max(20),
  goals: z.array(z.object({ goal: goalIdSchema, now: z.number().finite(), was: z.number().finite(), unit: z.string() }).strict()).max(6).optional(),
  outages: z.array(z.object({ group: keySchema, now: z.number().finite().nonnegative(), was: z.number().finite().nonnegative() }).strict()).max(64).optional(),
  methods: z.array(z.object({ choice: keySchema, now: keySchema, was: keySchema }).strict()).max(8),
  buys: z.object({ added: z.array(keySchema).max(64), dropped: z.array(keySchema).max(64) }).strict(),
  moved: z.array(z.object({ job: keySchema, now: timesSchema, was: timesSchema }).strict()).max(20),
  movedMore: z.number().int().nonnegative(),
  added: z.array(keySchema).max(64), removed: z.array(keySchema).max(64),
}).strict().superRefine((facts, context) => {
  const issue = issuesOf(context)
  if (!(facts.from < facts.to)) issue(['from'], 'The previous options are from an earlier revision')
  const revisions = facts.changes.map(change => change.revision)
  if (revisions.some((revision, index) => revision <= facts.from || revision > facts.to || (index > 0 && revision < revisions[index - 1]!))) issue(['changes'], 'Changes lie after the previous options\' revision and up to now, in order')
  if (facts.goals !== undefined && !ascending(facts.goals.map(line => line.goal))) issue(['goals'], 'Goals are listed once each, in the plan\'s order')
  if (facts.outages !== undefined && !distinct(facts.outages.map(outage => outage.group))) issue(['outages'], 'Each group\'s outage is listed once')
  if (!distinct(facts.methods.map(method => method.choice))) issue(['methods'], 'Each method choice is listed once')
  facts.methods.forEach((method, index) => { if (method.now === method.was) issue(['methods', index, 'now'], 'Only a pick that differs is listed') })
  const { added, dropped } = facts.buys
  if (!distinct([...added, ...dropped])) issue(['buys'], 'A purchase is added or dropped, once')
  if (!distinct(facts.moved.map(entry => entry.job))) issue(['moved'], 'Each moved job is listed once')
  facts.moved.forEach((entry, index) => {
    if (Date.parse(entry.now.start) === Date.parse(entry.was.start) && Date.parse(entry.now.finish) === Date.parse(entry.was.finish)) issue(['moved', index], 'A moved job starts or finishes at another time')
  })
  if (!distinct([...facts.added, ...facts.removed, ...facts.moved.map(entry => entry.job)])) issue(['added'], 'A job is moved, added or removed, once')
})
export type VersusFacts = z.infer<typeof versusFactsSchema>

export const explainResultSchema = z.object({
  lines: z.array(z.string().max(240)).max(20),
  items: z.array(z.object({
    job: keySchema, start: instantSchema, finish: instantSchema, floatHours: z.number().nonnegative(),
    because: z.array(becauseSchema).min(1).max(4),
    joint: z.boolean(),
  }).strict()).max(20),
  // 'finish' only: what one more unit of the most limiting resource does, checked by lane K's checker on the
  // option's own order decoded again with that unit (no search). gain: the finish is hoursEarlier earlier.
  // no-gain: checked, and the finish does not move in this order. Absent: not computed (the chain names no
  // resource, the solver was busy, or the decode or check failed), so nothing may be said about hours.
  limiting: z.discriminatedUnion('result', [
    z.object({ result: z.literal('gain'), about: z.object({ kind: z.literal('resource'), key: keySchema }).strict(), hoursEarlier: z.number().positive() }).strict(),
    z.object({ result: z.literal('no-gain'), about: z.object({ kind: z.literal('resource'), key: keySchema }).strict() }).strict(),
  ]).optional(),
  // 'recommended' and 'versus' only: the facts the lines are generated from.
  recommended: recommendedFactsSchema.optional(),
  versus: versusFactsSchema.optional(),
  more: z.string().max(256).optional(),
}).strict().refine(result => result.recommended === undefined || result.versus === undefined, { message: 'An answer explains one ask', path: ['versus'] })
// ───────────── read sections ─────────────
// planning.plan.read returns the Host inspection view (@leitbild/contracts inspection); input {} gives the
// summary. Each section's `data` has one of these shapes, shared by the service, the screen and the
// Assistant. Records are the stored plan's own schemas; words come with attention and warnings only. Every
// section but summary pages as {items, more?} within the 4 KB result; `more` is the next read's cursor.
const paged = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), more: z.string().min(1).max(256).optional() }).strict()

/**
 * "What overtime buys" (design §4.1): the rungs of bought crew time and the rows between two rungs solved
 * on the same revision and formulation. A rung's `buy` is the list its Generate sends; `option` is its stored
 * option, fresh on the current revision and formulation (absent: still to solve there); `bought` are that
 * option's own 'bought:<purchase>' metrics. A row's word comes from this list, never "buys nothing".
 *
 * One ladder per method (U3): a rung's `methods` are the method picks it was solved for, and a row names the
 * picks its two rungs share, so it never compares rungs of two methods. Rungs are numbered within each method,
 * in the order they are offered, from 0, with no gaps: rung 0 buys no crew time, and each next rung adds the
 * crew-time purchases of one more price form (per person-hour first, then the rest). A plan with crew time in
 * one price form only offers rungs 0 and 1, and its rung 1 buys all of it. A row compares two adjacent
 * offered rungs of its method, so `to` is always `from + 1`.
 */
export const buysWordSchema = z.enum(['makes it possible', 'not solved', 'proven: no gain', 'found', 'proven', 'not found better'])
const rungSchema = z.number().int().min(0).max(2)
/** Method picks, each choice once; empty when the request fixes no method (or the plan has no method choice). */
const rungMethodsSchema = z.array(z.object({ choice: keySchema, option: keySchema }).strict()).max(8)
  .refine(picks => distinct(picks.map(pick => pick.choice)), 'Each method choice is picked once')
/** The ladder a rung or row belongs to: its picks, in choice order, so equal picks give an equal key. */
const ladderKey = (picks: ReadonlyArray<{ readonly choice: string; readonly option: string }>): string =>
  JSON.stringify(picks.toSorted((left, right) => left.choice.localeCompare(right.choice)).map(pick => [pick.choice, pick.option]))
export const buysRungSchema = z.object({
  rung: rungSchema, methods: rungMethodsSchema, buy: z.array(keySchema).max(64), option: keySchema.optional(), bought: z.array(metricSchema).max(64),
}).strict()
/**
 * Where a row's rung stands: proven, found (validated feasible, not proven), refused (proven infeasible, with
 * a certificate) or unsolved (any other status: stopped, unresolved, cancelled, invalid input).
 * Proven: validated feasible, and its proof fixes the outage the row compares: the proven goal covers one
 * group, its value is the checker's own figure for that group, and that figure is above the goal's threshold
 * (or the threshold is 0). A span-over goal proven at 0 under its threshold does not prove the outage, so
 * that rung is found. Lane K's rungStanding derives every end; nothing else does.
 */
export const buysEndSchema = z.enum(['proven', 'found', 'refused', 'unsolved'])
type BuysEnd = z.infer<typeof buysEndSchema>
const solved = (end: BuysEnd): boolean => end === 'proven' || end === 'found'
/**
 * Each word stands only on its ends: "makes it possible" a refused lower rung and a solved higher one;
 * "proven" and "proven: no gain" both ends proven; "found" both solved and at least one not proven; "not
 * solved" an unsolved end; "not found better" both solved and no shorter outage above. No word fits two
 * refused rungs, or a solved rung below a refused one, so no such row is shown.
 * outage: the higher rung's longest outage minus the lower's, in h; cost: its extra cost minus the lower's, in
 * the plan currency; both exactly when both ends are solved. `finish` is the higher rung's first cause of what
 * sets the finish: allowed on any row whose two ends are solved, and required with "proven: no gain" (fix
 * round G3). A "no gain" without its cause reads "not found better".
 */
export const buysRowSchema = z.object({
  methods: rungMethodsSchema, from: rungSchema, to: rungSchema, ends: z.object({ from: buysEndSchema, to: buysEndSchema }).strict(), word: buysWordSchema,
  outage: z.number().finite().optional(), cost: z.number().finite().optional(), finish: becauseSchema.optional(),
}).strict().superRefine((row, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message })
  if (row.to !== row.from + 1) issue('to', 'A row compares a rung with the next one offered')
  const { from, to } = row.ends
  const both = solved(from) && solved(to)
  const stands: Readonly<Record<z.infer<typeof buysWordSchema>, boolean>> = {
    'makes it possible': from === 'refused' && solved(to),
    proven: from === 'proven' && to === 'proven',
    'proven: no gain': from === 'proven' && to === 'proven',
    found: both && (from !== 'proven' || to !== 'proven'),
    'not solved': from === 'unsolved' || to === 'unsolved',
    'not found better': both,
  }
  if (!stands[row.word]) issue('word', `"${row.word}" does not stand on a ${from} lower rung and a ${to} higher one`)
  if (both !== (row.outage !== undefined && row.cost !== undefined)) issue('outage', 'A row gives both differences exactly when both rungs are solved')
  if (row.word === 'proven: no gain' && row.finish === undefined) issue('finish', '"Proven: no gain" names what sets the finish')
  if (row.finish !== undefined && !both) issue('finish', 'What sets the finish is named only between two solved rungs')
  if (row.outage === undefined) return
  if (row.word === 'proven: no gain' && row.outage !== 0) issue('outage', '"Proven: no gain" means both outages are equal')
  if ((row.word === 'found' || row.word === 'proven') && !(row.outage < 0)) issue('outage', 'A gain is a shorter outage on the higher rung')
  if (row.word === 'not found better' && row.outage < 0) issue('outage', 'A shorter outage on the higher rung is a gain')
  if (row.word === 'not found better' && from === 'proven' && to === 'proven' && row.outage === 0) issue('word', 'Two proven rungs with equal outages read "proven: no gain"')
})

/** A span refusal as an item gives it: the rule, the least span lane K proved and the limit, in h. */
export const spanSummarySchema = z.object({ rule: keySchema, leastHours: z.number().finite().nonnegative(), limitHours: z.number().finite().positive() }).strict()
const [feasibleStatusSchema, refusalStatusSchema, invalidStatusSchema, unsupportedStatusSchema, cancelledStatusSchema, unresolvedStatusSchema] = statusSchema.options
/**
 * A refusal as the options and previous sections page it (coordinator, shape E): the option's own method's
 * cause as stored and its span as a summary; per method combination one `line` of at most 200 characters, the
 * figures first and then the method's name, the option's own first and the rest in the plan's combination
 * order. Each combination's picks, purchases, cause and full proof (the path, the later start, the energy
 * proof) stay in storage, worded only by explain refusal.
 */
export const compactRefusalSchema = z.object({
  ...refusalStatusSchema.shape,
  span: spanSummarySchema.optional(),
  byMethod: z.array(z.object({ line: z.string().min(1).max(200) }).strict()).min(2).max(8).optional(),
}).strict()
/** An item's status: the stored status, with a refusal in its compact form. */
export const itemStatusSchema = z.discriminatedUnion('word', [feasibleStatusSchema, compactRefusalSchema, invalidStatusSchema, unsupportedStatusSchema, cancelledStatusSchema, unresolvedStatusSchema])
export type ItemStatus = z.infer<typeof itemStatusSchema>
/** The item rule: a what-if's lead as optionLeadIssue. */
const itemRefinement = (item: { readonly variant: z.infer<typeof optionWithoutRowsShape>['variant']; readonly status: ItemStatus }, context: z.core.$RefinementCtx): void => {
  if (item.status.word !== 'validated feasible') return
  const issue = optionLeadIssue({ variant: item.variant, status: item.status })
  if (issue !== undefined) context.addIssue({ code: 'custom', path: ['status', 'lead'], message: issue })
}

/**
 * An option as the options and previous sections page it: no rows; `fresh` (it re-checks on the current
 * revision and formulation), its warnings, and `dominated` when another option of the same set is no worse on
 * every goal and better on one (lead what-ifs are never dominated nor dominate). No option dominates itself.
 */
export const optionItemSchema = optionWithoutRowsShape.extend({
  status: itemStatusSchema, fresh: z.boolean(), warnings: z.array(optionWarningSchema).max(4), dominated: z.object({ by: keySchema }).strict().optional(),
}).strict().superRefine(itemRefinement)
  .refine(item => item.dominated?.by !== item.key, { message: 'An option is not dominated by itself', path: ['dominated', 'by'] })
  .refine(item => item.dominated === undefined || item.variant.lead === undefined, { message: 'A what-if with a leading goal is never dominated', path: ['dominated'] })
const optionsPage = paged(optionItemSchema).extend({ at: instantSchema.nullable(), recommended: keySchema.nullable() }).strict()

export const summaryDataSchema = z.object({
  plan: z.object({ id: z.uuid(), title: labelSchema, revision: z.number().int().positive(), updatedAt: instantSchema }).strict(),
  settings: planInputsSchema.shape.settings,
  goals: planInputsSchema.shape.goals,
  refreshedAt: instantSchema.nullable(),
  attention: writeResultSchema.shape.attention,
  certifiedSize: certifiedSizeSchema.nullable(),
}).strict()

export const sectionDataSchemas = {
  summary: summaryDataSchema,
  jobs: paged(z.union([z.object({ job: jobSchema }).strict(), z.object({ link: linkSchema }).strict(), z.object({ method: methodChoiceSchema }).strict()])),
  rules: paged(z.object({ rule: ruleSchema }).strict()),
  crews: paged(z.union([z.object({ calendar: calendarSchema }).strict(), z.object({ resource: resourceSchema }).strict(), z.object({ purchase: purchaseSchema }).strict()])),
  sources: paged(z.union([z.object({ equipment: equipmentSchema }).strict(), z.object({ group: groupSchema }).strict(), z.object({ fact: worldFactCopySchema }).strict()])),
  // fresh: the option re-checks on the current inputs revision and formulation.
  options: optionsPage,
  schedule: paged(datedRowSchema).extend({ option: keySchema }).strict(),
  history: paged(changeSchema),
  // A rung is listed once in its method's ladder.
  buys: paged(z.union([z.object({ rung: buysRungSchema }).strict(), z.object({ row: buysRowSchema }).strict()])).superRefine((page, context) => {
    const rungs = new Map<string, number>()
    page.items.forEach((item, index) => {
      if (!('rung' in item)) return
      const key = `${ladderKey(item.rung.methods)}#${item.rung.rung}`
      if (rungs.has(key)) context.addIssue({ code: 'custom', path: ['items', index, 'rung'], message: 'A rung is listed once in its method\'s ladder' })
      rungs.set(key, index)
    })
  }),
  previous: optionsPage,
} as const satisfies Record<NonNullable<z.infer<typeof readInputSchema>['section']>, z.ZodType>
export type SectionName = keyof typeof sectionDataSchemas
export type PagedSectionName = Exclude<SectionName, 'summary'>

// ───────────── publication ─────────────
export const strippedKeywords: ReadonlySet<string> = new Set(['pattern', 'format', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems'])
/** Keywords whose value maps field names to schemas. Those names are data (a field may be called "minimum"), never keywords. */
export const schemaMapKeywords: ReadonlySet<string> = new Set(['properties', '$defs', 'definitions'])

const stripMap = (map: unknown): unknown => map === null || typeof map !== 'object' || Array.isArray(map)
  ? stripForPublication(map)
  : Object.fromEntries(Object.entries(map).map(([name, child]) => [name, stripForPublication(child)]))

/** Removes patterns, formats and numeric, length and item bounds; keeps types, enums, required, descriptions, additionalProperties and every field. */
export const stripForPublication = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(stripForPublication)
  if (schema === null || typeof schema !== 'object') return schema
  const node = Object.fromEntries(Object.entries(schema)
    .filter(([name]) => !strippedKeywords.has(name))
    .map(([name, value]) => [name, schemaMapKeywords.has(name) ? stripMap(value) : stripForPublication(value)])) as Record<string, unknown>
  // {anyOf: [{type: T}, {type: 'null'}]} -> {type: [T, 'null']}: the same meaning, fewer bytes
  const branches = node.anyOf as Array<Record<string, unknown>> | undefined
  if (branches?.length === 2 && branches[1]?.type === 'null' && Object.keys(branches[1]).length === 1 && typeof branches[0]?.type === 'string') {
    const { anyOf: _anyOf, ...rest } = node
    return { ...branches[0], type: [branches[0].type, 'null'], ...rest }
  }
  return node
}

/** The JSON Schema published for an operation input, without the dialect line. */
export const publishedInputSchema = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  return stripForPublication(json) as Record<string, unknown>
}
