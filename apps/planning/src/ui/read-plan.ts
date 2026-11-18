// Reads a plan through planning.plan.read: each section is one Inspection Section whose `id` is the section
// name and whose `data` has the shared shape in api/contract.ts. Every page is followed; the parts are
// assembled and validated once more as one stored plan's inputs.
import type { z } from 'zod'
import type { InspectionView } from '@leitbild/contracts'
import { sectionDataSchemas, summaryDataSchema, type PagedSectionName } from '../api/contract.ts'
import { planInputsSchema, type PlanInputs } from '../plan/schema.ts'
import type { PlanningClient } from './api.ts'
import type { DatedRow, OptionView, PlanModel } from './model.ts'

type Page<S extends PagedSectionName> = z.infer<typeof sectionDataSchemas[S]>

const sectionData = (view: InspectionView, id: string): unknown => {
  const section = view.sections.find(item => item.id === id)
  if (section === undefined) throw new Error(`Planning answered without the ${id} section.`)
  return section.data
}

/** Reads one section, following `more` until the last page. */
export const readAll = async <S extends PagedSectionName>(client: PlanningClient, plan: string, section: S, option?: string): Promise<ReadonlyArray<Page<S>>> => {
  const pages: Array<Page<S>> = []
  let cursor: string | undefined
  do {
    const view = await client.read(plan, { section, ...(option === undefined ? {} : { option }), ...(cursor === undefined ? {} : { cursor }) })
    const page = sectionDataSchemas[section].parse(sectionData(view, section)) as Page<S>
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
    readonly jobs: ReadonlyArray<Page<'jobs'>>
    readonly rules: ReadonlyArray<Page<'rules'>>
    readonly crews: ReadonlyArray<Page<'crews'>>
    readonly sources: ReadonlyArray<Page<'sources'>>
    readonly options: ReadonlyArray<Page<'options'>>
    readonly history?: ReadonlyArray<Page<'history'>>
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
    rows: {}, history: parts.history === undefined ? [] : items(parts.history), refusals: {},
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
