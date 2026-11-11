// planning.plan.read sections as the screen reads them. Each section is one Inspection Section whose `id`
// is the section name and whose `data` is validated here with the stored plan's own schemas. Every
// section but `summary` pages at 4 KB: `{items, more?}`, and `more` is the next read's cursor.
import { z } from 'zod'
import type { InspectionView } from '@leitbild/contracts'
import { writeResultSchema } from '../api/contract.ts'
import {
  calendarSchema, certifiedSizeSchema, changeSchema, datedRowSchema, equipmentSchema, groupSchema, instantSchema, jobSchema, keySchema,
  labelSchema, linkSchema, methodChoiceSchema, optionSchema, planInputsSchema, purchaseSchema, resourceSchema, ruleSchema, worldFactCopySchema,
  type PlanInputs,
} from '../plan/schema.ts'
import type { PlanningClient } from './api.ts'
import type { DatedRow, OptionView, PlanModel } from './model.ts'

const paged = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), more: z.string().min(1).max(256).optional() }).strict()

export const summaryDataSchema = z.object({
  plan: z.object({ id: z.uuid(), title: labelSchema, revision: z.number().int().positive(), updatedAt: instantSchema }).strict(),
  settings: planInputsSchema.shape.settings,
  goals: planInputsSchema.shape.goals,
  refreshedAt: instantSchema.nullable(),
  attention: writeResultSchema.shape.attention,
  certifiedSize: certifiedSizeSchema.nullable(),
}).strict()

export const sectionSchemas = {
  jobs: paged(z.union([z.object({ job: jobSchema }).strict(), z.object({ link: linkSchema }).strict(), z.object({ method: methodChoiceSchema }).strict()])),
  rules: paged(z.object({ rule: ruleSchema }).strict()),
  crews: paged(z.union([z.object({ calendar: calendarSchema }).strict(), z.object({ resource: resourceSchema }).strict(), z.object({ purchase: purchaseSchema }).strict()])),
  sources: paged(z.union([z.object({ equipment: equipmentSchema }).strict(), z.object({ group: groupSchema }).strict(), z.object({ fact: worldFactCopySchema }).strict()])),
  options: paged(optionSchema.omit({ rows: true }).extend({
    fresh: z.boolean(),
    warnings: z.array(z.object({ text: z.string().max(240), about: z.array(keySchema).max(4) }).strict()).max(4),
  }).strict()).extend({ at: instantSchema.nullable(), recommended: keySchema.nullable() }).strict(),
  schedule: paged(datedRowSchema).extend({ option: keySchema }).strict(),
  history: paged(changeSchema),
} as const
export type PagedSection = keyof typeof sectionSchemas

const sectionData = (view: InspectionView, id: string): unknown => {
  const section = view.sections.find(item => item.id === id)
  if (section === undefined) throw new Error(`Planning answered without the ${id} section.`)
  return section.data
}

/** Reads one section, following `more` until the last page. */
export const readAll = async <S extends PagedSection>(client: PlanningClient, plan: string, section: S, option?: string): Promise<ReadonlyArray<z.infer<typeof sectionSchemas[S]>>> => {
  const pages: Array<z.infer<typeof sectionSchemas[S]>> = []
  let cursor: string | undefined
  do {
    const view = await client.read(plan, { section, ...(option === undefined ? {} : { option }), ...(cursor === undefined ? {} : { cursor }) })
    const page = sectionSchemas[section].parse(sectionData(view, section)) as z.infer<typeof sectionSchemas[S]>
    pages.push(page)
    cursor = page.more
  } while (cursor !== undefined && pages.length < 200)
  if (cursor !== undefined) throw new Error('Planning kept answering with more pages; the plan was not read.')
  return pages
}

/** Assembles the screen's model from the sections; the inputs are validated as one stored plan's inputs. */
export const assemblePlan = (
  summary: z.infer<typeof summaryDataSchema>,
  parts: {
    readonly jobs: ReadonlyArray<z.infer<typeof sectionSchemas.jobs>>
    readonly rules: ReadonlyArray<z.infer<typeof sectionSchemas.rules>>
    readonly crews: ReadonlyArray<z.infer<typeof sectionSchemas.crews>>
    readonly sources: ReadonlyArray<z.infer<typeof sectionSchemas.sources>>
    readonly options: ReadonlyArray<z.infer<typeof sectionSchemas.options>>
    readonly history?: ReadonlyArray<z.infer<typeof sectionSchemas.history>>
  },
): PlanModel => {
  const items = <T>(pages: ReadonlyArray<{ readonly items: readonly T[] }>): readonly T[] => pages.flatMap(page => page.items)
  const pick = <T, K extends string>(list: readonly T[], key: K) => list.flatMap(item => key in (item as object) ? [(item as Record<K, unknown>)[key]] : [])
  const jobItems = items(parts.jobs), crewItems = items(parts.crews), sourceItems = items(parts.sources)
  const inputs: PlanInputs = planInputsSchema.parse({
    settings: summary.settings,
    equipment: pick(sourceItems, 'equipment'), groups: pick(sourceItems, 'group'),
    calendars: pick(crewItems, 'calendar'), resources: pick(crewItems, 'resource'), purchases: pick(crewItems, 'purchase'),
    methods: pick(jobItems, 'method'), jobs: pick(jobItems, 'job'), links: pick(jobItems, 'link'),
    rules: pick(items(parts.rules), 'rule'), goals: summary.goals,
    world: { refreshedAt: summary.refreshedAt, facts: pick(sourceItems, 'fact') },
  })
  const firstOptions = parts.options[0]
  const options: OptionView[] = [...items(parts.options)]
  return {
    id: summary.plan.id, title: summary.plan.title, revision: summary.plan.revision, updatedAt: summary.plan.updatedAt,
    inputs, attention: summary.attention, certifiedSize: summary.certifiedSize,
    options: firstOptions === undefined || firstOptions.at === null ? null : { at: firstOptions.at, recommended: firstOptions.recommended, items: options },
    rows: {}, history: parts.history === undefined ? [] : items(parts.history),
  }
}

export const loadPlan = async (client: PlanningClient, plan: string): Promise<PlanModel> => {
  const summary = summaryDataSchema.parse(sectionData(await client.read(plan, { section: 'summary' }), 'summary'))
  const [jobs, rules, crews, sources, options] = await Promise.all([
    readAll(client, plan, 'jobs'), readAll(client, plan, 'rules'), readAll(client, plan, 'crews'), readAll(client, plan, 'sources'), readAll(client, plan, 'options'),
  ])
  const model = assemblePlan(summary, { jobs, rules, crews, sources, options })
  const recommended = model.options?.recommended
  return recommended === null || recommended === undefined ? model : { ...model, rows: { [recommended]: await loadRows(client, plan, recommended) } }
}

export const loadRows = async (client: PlanningClient, plan: string, option: string): Promise<readonly DatedRow[]> =>
  (await readAll(client, plan, 'schedule', option)).flatMap(page => page.items)

export const loadHistory = async (client: PlanningClient, plan: string) =>
  (await readAll(client, plan, 'history')).flatMap(page => page.items)
