// Operation inputs and outputs. The boundary validates with these exact schemas; what is published to
// Host and the Assistant is stripForPublication(exact).
import { z } from 'zod'
import { workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { editSchema, sourceInputSchema } from '../plan/edit-schema.ts'
import {
  calendarSchema, certifiedSizeSchema, changeSchema, datedRowSchema, dueRuleSchema, equipmentSchema, goalProofBreaks, goalWordSchema, gridSchema, groupSchema, instantSchema, jobSchema,
  keySchema, labelSchema, leadSchema, linkSchema, methodChoiceSchema, metricSchema, optionLeadRefinement, optionWithoutRowsShape, planInputsSchema, purchaseSchema, resourceSchema, ruleSchema,
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
  section: z.enum(['summary', 'jobs', 'rules', 'crews', 'sources', 'options', 'schedule', 'history', 'buys']).optional().describe('Default summary; buys: what bought crew time gains'),
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
  more: z.string().max(256).optional(),
}).strict()
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
 */
export const buysWordSchema = z.enum(['makes it possible', 'not solved', 'proven: no gain', 'found', 'proven', 'not found better'])
const rungSchema = z.number().int().min(0).max(2)
export const buysRungSchema = z.object({
  rung: rungSchema, buy: z.array(keySchema).max(64), option: keySchema.optional(), bought: z.array(metricSchema).max(64),
}).strict()
/**
 * outage: the higher rung's longest outage minus the lower's, in h; cost: its extra cost minus the lower's, in
 * the plan currency. With "proven: no gain", `finish` is the higher rung's first cause of what sets the finish.
 */
export const buysRowSchema = z.object({
  from: rungSchema, to: rungSchema, word: buysWordSchema,
  outage: z.number().finite().optional(), cost: z.number().finite().optional(), finish: becauseSchema.optional(),
}).strict().superRefine((row, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message })
  if (row.to !== row.from + 1) issue('to', 'A row compares a rung with the one above it')
  const compared = row.word !== 'makes it possible' && row.word !== 'not solved'
  if (compared !== (row.outage !== undefined && row.cost !== undefined)) issue('outage', 'A row gives both differences exactly when both rungs are solved and comparable')
  if ((row.word === 'proven: no gain') !== (row.finish !== undefined)) issue('finish', '"Proven: no gain" names what sets the finish, and only it does')
  if (row.outage === undefined) return
  if (row.word === 'proven: no gain' && row.outage !== 0) issue('outage', '"Proven: no gain" means both outages are equal')
  if ((row.word === 'found' || row.word === 'proven') && !(row.outage < 0)) issue('outage', 'A gain is a shorter outage on the higher rung')
  if (row.word === 'not found better' && row.outage < 0) issue('outage', 'A shorter outage on the higher rung is a gain')
})

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
  options: paged(optionWithoutRowsShape.extend({ fresh: z.boolean(), warnings: z.array(optionWarningSchema).max(4) }).strict().superRefine(optionLeadRefinement))
    .extend({ at: instantSchema.nullable(), recommended: keySchema.nullable() }).strict(),
  schedule: paged(datedRowSchema).extend({ option: keySchema }).strict(),
  history: paged(changeSchema),
  buys: paged(z.union([z.object({ rung: buysRungSchema }).strict(), z.object({ row: buysRowSchema }).strict()])),
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
