// Operation inputs and outputs. The boundary validates with these exact schemas; what is published to
// Host and the Assistant is stripForPublication(exact).
import { z } from 'zod'
import { workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { editSchema } from '../plan/edit-schema.ts'
import {
  calendarSchema, certifiedSizeSchema, changeSchema, datedRowSchema, equipmentSchema, goalOrderBreaks, goalWordSchema, gridSchema, groupSchema, instantSchema, jobSchema,
  keySchema, labelSchema, linkSchema, methodChoiceSchema, optionSchema, planInputsSchema, purchaseSchema, resourceSchema, ruleSchema, statusWordSchema,
  wordsSchema, worldFactCopySchema,
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
export const generateInputSchema = z.object({
  variants: z.array(z.object({
    label: labelSchema.optional().describe('Name for this what-if'),
    methods: z.array(z.object({ choice: keySchema.describe('Method key'), option: keySchema.describe('Option key') }).strict()).max(8).optional().describe('Fix these method choices; others are searched'),
    buy: z.union([z.enum(['allowed', 'none', 'no-extra-crew-hours']), z.array(keySchema)]).optional()
      .describe('Purchases Generate may use. no-extra-crew-hours = "days only": no purchase that adds working time to a crew; rebookings and tool days stay allowed'),
  }).strict()).max(8).optional().describe('What-ifs, without changing the plan; default one per method option'),
  seconds: z.number().int().min(1).max(20).optional().describe('Time budget; default 20'),
}).strict()
export const explainInputSchema = z.object({
  ask: z.enum(['why-start', 'finish', 'refusal']).describe('What to explain'),
  option: keySchema.optional().describe('Default: the recommended option'),
  job: keySchema.optional().describe('why-start: the job; finish: the job whose finish (default the last)'),
  cursor: z.string().max(256).optional().describe('From a previous answer'),
}).strict()
export const readInputSchema = z.object({
  section: z.enum(['summary', 'jobs', 'rules', 'crews', 'sources', 'options', 'schedule', 'history']).optional().describe('Default summary'),
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
/**
 * The status as the Assistant sees it: the plan's own status and goal words, in goal order, with the same
 * order rule as the stored status. Prose is generated beside it, never stored.
 */
export const statusOutSchema = z.object({
  word: statusWordSchema,
  goals: z.array(z.object({
    word: goalWordSchema, value: z.number().finite(), unit: z.string(),
    bound: z.number().finite().optional(), gap: z.number().finite().optional(),
  }).strict()).max(6),
  cause: z.object({ kind: z.string(), requiredHours: z.number().optional(), availableHours: z.number().optional(), about: z.array(keySchema).max(4) }).strict().optional(),
}).strict().superRefine((status, context) => {
  if (status.word !== 'validated feasible' && status.goals.length > 0) context.addIssue({ code: 'custom', path: ['goals'], message: 'Only a validated feasible option has goal values' })
  if ((status.word === 'proven infeasible') !== (status.cause !== undefined)) context.addIssue({ code: 'custom', path: ['cause'], message: 'A cause is given exactly when the option is proven infeasible' })
  for (const index of goalOrderBreaks(status.goals.map(goal => goal.word))) {
    context.addIssue({ code: 'custom', path: ['goals', index, 'word'], message: 'A later goal is proven only when every earlier goal is' })
  }
  status.goals.forEach((goal, index) => {
    if (goal.word === 'proven optimal' && goal.bound === undefined) context.addIssue({ code: 'custom', path: ['goals', index, 'bound'], message: 'Proven optimal names its bound' })
    if ((goal.bound === undefined) !== (goal.gap === undefined)) context.addIssue({ code: 'custom', path: ['goals', index, 'gap'], message: 'A bound comes with its gap' })
  })
})
export type StatusOut = z.infer<typeof statusOutSchema>

export const writeResultSchema = z.object({
  plan: z.object({ id: z.uuid(), title: labelSchema, revision: z.number().int().positive() }).strict(),
  target: z.object({ kind: z.literal('resource'), ref: workspaceResourceReferenceSchema }).strict(),   // the plan, as the next call names it
  changed: z.array(z.string().max(200)).max(12),
  attention: z.array(z.object({ kind: z.enum(['refusal', 'not-ready', 'rule', 'limit', 'world', 'decision', 'stale', 'warning']), text: z.string().max(240), about: z.array(keySchema).max(4) }).strict()).max(6),
  problems: z.array(z.object({ edit: z.number().int().nonnegative().optional(), about: z.array(keySchema).max(4), code: z.string().max(64), text: z.string().max(300), expected: z.unknown().optional() }).strict()).max(8),
  preview: z.object({
    saved: z.literal(false), consequence: z.string().max(300), violations: z.array(z.string().max(200)).max(6), weakens: z.array(keySchema).max(6), nearestAllowed: instantSchema.optional(),
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
 */
export const optionWarningSchema = z.object({
  kind: z.enum(['redundancy']),
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
export const explainResultSchema = z.object({
  lines: z.array(z.string().max(240)).max(20),
  items: z.array(z.object({
    job: keySchema, start: instantSchema, finish: instantSchema, floatHours: z.number().nonnegative(),
    because: z.array(z.object({
      kind: z.enum(['link', 'crew', 'tool', 'shift', 'availability', 'span-limit', 'window', 'release', 'lock', 'data-date', 'late-as-possible', 'purchase-not-allowed']),
      // Every name says what it names, so no reader guesses: the screen and the Assistant look it up as that kind.
      about: z.array(z.object({ kind: z.enum(['job', 'resource', 'calendar', 'rule', 'equipment', 'purchase']), key: keySchema }).strict()).max(6), until: instantSchema.optional(),
    }).strict()).min(1).max(4),
    joint: z.boolean(),
  }).strict()).max(20),
  more: z.string().max(256).optional(),
}).strict()
// ───────────── read sections ─────────────
// planning.plan.read returns the Host inspection view (@leitbild/contracts inspection); input {} gives the
// summary. Each section's `data` has one of these shapes, shared by the service, the screen and the
// Assistant. Records are the stored plan's own schemas; words come with attention and warnings only. Every
// section but summary pages as {items, more?} within the 4 KB result; `more` is the next read's cursor.
const paged = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), more: z.string().min(1).max(256).optional() }).strict()

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
  options: paged(optionSchema.omit({ rows: true }).extend({ fresh: z.boolean(), warnings: z.array(optionWarningSchema).max(4) }).strict())
    .extend({ at: instantSchema.nullable(), recommended: keySchema.nullable() }).strict(),
  schedule: paged(datedRowSchema).extend({ option: keySchema }).strict(),
  history: paged(changeSchema),
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
