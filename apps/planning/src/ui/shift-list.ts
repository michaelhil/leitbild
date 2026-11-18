// The phone view's schedule: shift by shift, then job by job, with who does it. Shifts are 12-hour
// blocks anchored at the window's start time of day; a window shorter than a shift is one block.
import type { PlanInputs } from '../plan/schema.ts'
import { timeUnitMs } from '../time/units.ts'
import type { TimeFormat } from './format.ts'
import { joinWords, type DatedRow } from './model.ts'
import { jobMark } from './timeline-layout.ts'

export interface ShiftEntry { readonly when: string; readonly mark: string; readonly title: string; readonly who: string }
export interface Shift { readonly title: string; readonly entries: readonly ShiftEntry[] }

const blockMs = 12 * timeUnitMs.h

export const shiftList = (inputs: PlanInputs, rows: readonly DatedRow[], format: TimeFormat): readonly Shift[] => {
  if (rows.length === 0) return []
  const sorted = [...rows].sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
  const anchor = inputs.settings.window === null ? Date.parse(sorted[0]!.start) : Date.parse(inputs.settings.window.start)
  const end = inputs.settings.window === null ? Math.max(...rows.map(row => Date.parse(row.finish))) : Date.parse(inputs.settings.window.end)
  const jobs = new Map(inputs.jobs.map(job => [job.key, job]))
  const resources = new Map(inputs.resources.map(resource => [resource.key, resource.label]))
  const blocks = new Map<number, ShiftEntry[]>()
  for (const row of sorted) {
    const job = jobs.get(row.job)
    if (job === undefined) continue
    const index = Math.max(0, Math.floor((Date.parse(row.start) - anchor) / blockMs))
    const who = joinWords([...new Set(row.uses.map(use => resources.get(use.resource)).filter(label => label !== undefined))])
    const mark = jobMark(job.kind)
    const entries = blocks.get(index) ?? []
    entries.push({ when: format.range(row.start, row.finish), mark: `${mark.shape} ${mark.word}`, title: job.title, who: who === '' ? 'No crew or tool' : who })
    blocks.set(index, entries)
  }
  return [...blocks.entries()].sort(([left], [right]) => left - right).map(([index, entries]) => {
    const start = anchor + index * blockMs
    const stop = Math.min(start + blockMs, Math.max(end, start + 1))
    return { title: format.range(start, stop), entries }
  })
}
