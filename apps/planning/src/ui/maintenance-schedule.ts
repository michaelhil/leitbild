import type { TimeFormat } from './format.ts'
import type { DatedRow, Job, PlanModel } from './model.ts'
import type { ExplainInput, ExplainResult, PlanningClient } from './api.ts'
import { addDays, localParts, localToInstant } from '../time/zone.ts'

export interface ScheduleDay { readonly label: string; readonly left: number; readonly width: number }
export interface ScheduleTick { readonly label: string; readonly left: number }
const hour = 3_600_000

/** Day boundaries are civil days in the plan's zone, including DST changes. */
export const scheduleAxis = (from: number, to: number, time: TimeFormat): { days: readonly ScheduleDay[]; ticks: readonly ScheduleTick[] } => {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) return { days: [], ticks: [] }
  const percent = (at: number): number => (at - from) / (to - from) * 100
  const boundaries = [from]
  for (let date = addDays(localParts(time.zone, from), 1); ; date = addDays(date, 1)) {
    const at = localToInstant(time.zone, { ...date, hour: 0, minute: 0 })
    if (at >= to) break
    if (at > boundaries[boundaries.length - 1]!) boundaries.push(at)
  }
  boundaries.push(to)
  const days = boundaries.slice(0, -1).map((at, index) => ({ label: time.day(at), left: percent(at), width: percent(boundaries[index + 1]!) - percent(at) }))
  const ticks: ScheduleTick[] = [{ label: time.time(from), left: 0 }]
  const step = to - from > 18 * hour ? 6 * hour : 2 * hour
  for (let at = Math.ceil(from / step) * step; at < to; at += step) {
    if (at - from > hour && to - at > hour) ticks.push({ label: time.time(at), left: percent(at) })
  }
  ticks.push({ label: time.time(to), left: 100 })
  return { days, ticks }
}

/** Each scheduled task appears once, with shared gates apart from the asset work. */
export const scheduleTaskGroups = (model: PlanModel, rows: readonly DatedRow[], sharedLabel = 'Shared work'): readonly { readonly label: string; readonly jobs: readonly Job[] }[] => {
  const scheduled = new Set(rows.map(row => row.job))
  const groups = new Map<string | null, { label: string; jobs: Job[] }>()
  for (const job of model.inputs.jobs) {
    if (!scheduled.has(job.key)) continue
    const equipment = job.equipment.length === 1 ? model.inputs.equipment.find(item => item.key === job.equipment[0]) : undefined
    const key = equipment?.key ?? null
    const group = groups.get(key) ?? { label: equipment?.label ?? sharedLabel, jobs: [] }
    group.jobs.push(job)
    groups.set(key, group)
  }
  return [...groups].sort(([left], [right]) => Number(left === null) - Number(right === null)).map(([, group]) => group)
}

export const activeScheduleLinks = (model: PlanModel, option: string, rows: readonly DatedRow[]): PlanModel['inputs']['links'] => {
  const scheduled = new Set(rows.map(row => row.job))
  const methods = model.options?.items.find(item => item.key === option)?.variant.methods ?? []
  return model.inputs.links.filter(link => scheduled.has(link.from) && scheduled.has(link.to)
    && (link.method === undefined || methods.some(method => method.choice === link.method!.choice && method.option === link.method!.option)))
}

/** Every page belongs to the same owner option; retained views guard the complete read. */
export const readScheduleExplanation = async (client: Pick<PlanningClient, 'explain'>, plan: string, option: string, input: ExplainInput, validate: () => Promise<void>): Promise<ExplainResult> => {
  await validate()
  let answer = await client.explain(plan, { ...input, option })
  const first = answer
  const items = [...answer.items], lines = [...answer.lines]
  const cursors = new Set<string>()
  while (answer.more !== undefined) {
    if (cursors.has(answer.more)) throw new Error('Planning returned the same explanation page again. Read the schedule again.')
    cursors.add(answer.more)
    answer = await client.explain(plan, { ...input, option, cursor: answer.more })
    items.push(...answer.items)
    lines.push(...answer.lines)
  }
  await validate()
  return { ...first, items, lines, more: undefined }
}
