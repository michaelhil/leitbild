// "Why it starts then" and "what sets the finish", generated from planning.plan.explain's structure.
import type { z } from 'zod'
import type { explainResultSchema } from '../api/contract.ts'
import type { PlanInputs } from '../plan/schema.ts'
import { expandCalendar } from '../time/calendar.ts'
import { gridSlotMs } from '../time/units.ts'
import { hoursText } from './format.ts'
import type { DatedRow } from './model.ts'
import type { Context } from './status-text.ts'

export type ExplainResult = z.infer<typeof explainResultSchema>
export type ExplainItem = ExplainResult['items'][number]
type Because = ExplainItem['because'][number]

const until = (because: Because, context: Context): string => because.until === undefined ? '' : ` until ${context.format.clock(because.until)}`

const at = (because: Because, context: Context): string => because.until === undefined ? 'then' : `at ${context.format.clock(because.until)}`

/** A named thing in an explanation: shown by its name, and a link that selects it. */
export type NameKind = Because['about'][number]['kind']
export type Part = string | { readonly name: string; readonly kind: NameKind; readonly key: string }

/** Parts as plain words, for reading aloud and for tests. */
export const partsText = (parts: readonly Part[]): string => parts.map(part => typeof part === 'string' ? part : part.name).join('')

const joinParts = (named: readonly Part[]): Part[] =>
  named.flatMap((part, index) => index === 0 ? [part] : [index === named.length - 1 ? ' and ' : ', ', part])

/** A sentence's full stop, unless its last words (a rule quoted whole) already end with one. */
const ended = (parts: readonly Part[]): Part[] => /\.[”"']?$/.test(partsText(parts)) ? [...parts] : [...parts, '.']

/**
 * When the shift that a crew or tool works at `at` begins, read from its own calendar: the start of the
 * working time that holds `at`, or of the next one. Null when the calendar cannot be read.
 */
export const shiftStart = (inputs: PlanInputs, resource: string, at: number): number | null => {
  const calendar = inputs.calendars.find(item => item.key === inputs.resources.find(entry => entry.key === resource)?.calendar)
  const window = inputs.settings.window
  if (calendar === undefined || window === null || !Number.isFinite(at)) return null
  const slotMs = gridSlotMs[inputs.settings.grid]
  const origin = Math.floor(Math.min(Date.parse(window.start), at) / slotMs) * slotMs
  const slots = Math.ceil((Math.max(Date.parse(window.end), at + slotMs) - origin) / slotMs)
  const expanded = expandCalendar(calendar, { zone: inputs.settings.timeZone, slotMs, origin, slots })
  if (!expanded.ok) return null
  let slot = Math.floor((at - origin) / slotMs)
  while (slot < slots && expanded.work[slot] === 0) slot += 1
  if (slot >= slots) return null
  while (slot > 0 && expanded.work[slot - 1] === 1) slot -= 1
  return origin + slot * slotMs
}

/** "Truck 2 is not on shift before Thu 10:02": the time is the cause's own, or read from the calendar. */
const shiftParts = (because: Because, context: Context, start: string | undefined, said: (entries: Because['about']) => Part[]): Part[] => {
  const calendars = because.about.filter(entry => entry.kind === 'calendar'), crews = because.about.filter(entry => entry.kind === 'resource')
  const starts = start === undefined ? [] : crews.map(crew => shiftStart(context.inputs, crew.key, Date.parse(start))).filter(at => at !== null)
  const at = because.until !== undefined ? context.format.clock(because.until) : starts.length > 0 ? context.format.clock(Math.max(...starts)) : null
  const before = at === null ? ' before then' : ` before ${at}`
  return crews.length > 0
    ? [...said(crews), crews.length === 1 ? ' is not on shift' : ' are not on shift', before]
    : [...said(calendars), calendars.length === 1 ? ' has no working time' : ' have no working time', before]
}

/**
 * One cause in words. Every name in `about` says what it names (a job, a crew, a rule…), and is shown by that
 * thing's name only: a crew or tool cause names the resource and the jobs holding it; a shift cause names
 * the resources off duty. Each name is a part the screen turns into a link.
 */
export const causeParts = (because: Because, context: Context, start?: string): readonly Part[] => {
  const { names } = context
  const of = (kinds: readonly NameKind[]) => because.about.filter(entry => kinds.includes(entry.kind))
  const said = (entries: Because['about']): Part[] => joinParts(entries.map(entry => ({ name: names[entry.kind](entry.key), kind: entry.kind, key: entry.key })))
  // A rule is named in quote marks that belong to the link, so the marks never sit apart from its words.
  const quoted = (entries: Because['about']): Part[] => joinParts(entries.map(entry => ({ name: `“${names[entry.kind](entry.key)}”`, kind: entry.kind, key: entry.key })))
  const holders = of(['job'])
  const holding: Part[] = holders.length === 0 ? [] : [' with ', ...said(holders)]
  const time = until(because, context)
  switch (because.kind) {
    case 'link': return ['it follows ', ...said(because.about), time]
    case 'crew': return [...said(of(['resource'])), of(['resource']).length === 1 ? ' is busy' : ' are busy', ...holding, time]
    case 'tool': return [...said(of(['resource'])), of(['resource']).length === 1 ? ' is in use' : ' are in use', ...holding, time]
    case 'shift': return shiftParts(because, context, start, said)
    case 'availability': return ['starting earlier would break ', ...quoted(because.about)]
    case 'span-limit': return ['starting earlier would stretch the outage past ', ...quoted(because.about)]
    case 'window': return [`the window opens ${at(because, context)}`]
    case 'release': return [`it cannot start before ${at(because, context)}`]
    case 'lock': return ['you fixed its start']
    case 'data-date': return [`nothing starts before the plan's "now", ${at(because, context)}`]
    case 'late-as-possible': return ['it is placed as late as its successors allow, to keep equipment in service']
    case 'purchase-not-allowed': return [...said(because.about), because.about.length === 1 ? ' is not allowed' : ' are not allowed']
  }
}

export const causeText = (because: Because, context: Context, start?: string): string => partsText(causeParts(because, context, start))

/**
 * A step's causes as one plain sentence for the list of what sets the finish: "waits for the work-control
 * operator, busy with the HHSI A breaker test until Thu 02:30". Links are said once ("follows A and B"),
 * crews held by the same jobs until the same time are said together, and causes that all hold at once end
 * with "(together)".
 */
export const stepParts = (item: ExplainItem, context: Context): readonly Part[] => {
  const { names, format } = context
  const said = (entries: Because['about']): Part[] => joinParts(entries.map(entry => ({ name: names[entry.kind](entry.key), kind: entry.kind, key: entry.key })))
  const distinct = (entries: Because['about']): Because['about'] => entries.filter((entry, index) => entries.findIndex(other => other.kind === entry.kind && other.key === entry.key) === index)
  const clauses: Part[][] = []
  const links = item.because.filter(because => because.kind === 'link')
  if (links.length > 0) {
    const from = Math.max(...links.map(link => link.until === undefined ? -Infinity : Date.parse(link.until)))
    clauses.push(['follows ', ...said(distinct(links.flatMap(link => link.about))), ...Number.isFinite(from) && from !== Date.parse(item.start) ? [`, free from ${format.clock(from)}`] : []])
  }
  const held = new Map<string, { kind: 'crew' | 'tool'; who: Because['about'][number][]; holders: Because['about']; until: string | undefined }>()
  for (const because of item.because) {
    if (because.kind !== 'crew' && because.kind !== 'tool') continue
    const holders = because.about.filter(entry => entry.kind === 'job')
    const key = `${because.kind}|${holders.map(entry => entry.key).join(',')}|${because.until ?? ''}`
    const group = held.get(key) ?? { kind: because.kind, who: [], holders, until: because.until }
    group.who.push(...because.about.filter(entry => entry.kind === 'resource'))
    held.set(key, group)
  }
  for (const group of held.values()) {
    const busy = group.kind === 'crew' ? 'busy' : 'in use'
    clauses.push(['waits for ', ...said(distinct(group.who)), `, ${busy}`, ...group.holders.length > 0 ? [' with ', ...said(group.holders)] : [], ...group.until === undefined ? [] : [` until ${format.clock(group.until)}`]])
  }
  for (const because of item.because) {
    if (because.kind === 'link' || because.kind === 'crew' || because.kind === 'tool') continue
    const words: Part[] = because.kind === 'release' ? [`cannot start before ${because.until === undefined ? 'then' : format.clock(because.until)}`]
      : because.kind === 'lock' ? ['its start is fixed']
        : because.kind === 'late-as-possible' ? ['placed as late as its successors allow, to keep equipment in service']
          : [...causeParts(because, context, item.start)]
    clauses.push(words)
  }
  const sentence = clauses.flatMap((clause, index) => index === 0 ? clause : ['; ', ...clause])
  return item.joint && clauses.length > 1 ? [...sentence, ' (together)'] : sentence
}

const dueText = (rule: string, context: Context): string => {
  const due = context.inputs.rules.find(item => item.key === rule)
  return due?.kind === 'due' ? `due ${context.format.clock(due.finishBy)}` : 'a due time no longer in this plan'
}

/** Float with what limits it. Float counts logic and calendars only, and the screen says so. */
export const floatText = (float: DatedRow['float'] | { readonly workingHours: number; readonly limitedBy?: undefined }, context: Context): string => {
  const limit = float.limitedBy === undefined || float.limitedBy.kind === 'window-end'
    ? 'the window end'
    : float.limitedBy.kind === 'due' ? dueText(float.limitedBy.rule, context) : `“${context.names.rule(float.limitedBy.rule)}”`
  // Walk V11: margin in planner words, never "Float 0 s".
  if (float.workingHours <= 0) return 'No margin: any delay here moves the finish.'
  return `${hoursText(float.workingHours)} of margin before the finish moves (limited by ${limit}; crew availability is not counted).`
}

export interface WhyStart {
  readonly job: string
  readonly when: string
  /** "It starts then because …", in parts whose names are links. */
  readonly parts: readonly Part[]
  readonly sentence: string
  readonly causes: readonly string[]
  /** All causes bind together: easing one alone does not move the job. */
  readonly joint: boolean
  readonly float: string
}

const causeList = (item: ExplainItem, context: Context): Part[] =>
  item.because.flatMap((because, index) => [...index === 0 ? [] : ['; '], ...causeParts(because, context, item.start)])

export const whyStart = (item: ExplainItem, context: Context, row?: DatedRow): WhyStart => {
  const joint = item.joint && item.because.length > 1
  const parts: Part[] = ended([joint ? 'It starts then because all of these hold at once (easing only one does not move it): ' : 'It starts then because ', ...causeList(item, context)])
  return {
    job: context.names.job(item.job), when: context.format.range(item.start, item.finish), parts, sentence: partsText(parts),
    causes: item.because.map(because => causeText(because, context, item.start)), joint,
    float: floatText(row?.float ?? { workingHours: item.floatHours }, context),
  }
}

export interface FinishStep {
  readonly job: string
  readonly jobKey: string
  readonly when: string
  /** One plain sentence for the cause, e.g. "waits for X, busy with Y until Thu 02:30". */
  readonly because: string
  readonly becauseParts: readonly Part[]
  /** The job's hard due time, a rule: "Due Thu 15:00: …". */
  readonly due: string | null
}

/** The chain that sets the finish, last job first as explain returns it. */
export const finishChain = (result: ExplainResult, context: Context): readonly FinishStep[] =>
  result.items.map(item => {
    const becauseParts = stepParts(item, context)
    const due = context.inputs.rules.find(rule => rule.kind === 'due' && rule.job === item.job)
    return {
      job: context.names.job(item.job), jobKey: item.job, when: context.format.range(item.start, item.finish),
      because: partsText(becauseParts), becauseParts,
      due: due?.kind === 'due' ? `Due ${context.format.clock(due.finishBy)}: ${due.words}` : null,
    }
  })

/**
 * The one line on what limits the finish most, from lane S's `limiting` (one more unit of that resource,
 * decoded in the option's own order and checked by lane K):
 * - gain: the resource and the hours one more of it gains;
 * - no-gain: what the finish waits for, and that one more of that resource alone does not bring it earlier
 *   in this plan (never that it could not in any plan);
 * - absent (not computed): what the finish waits for, and nothing about hours or one more of anything.
 * "What the finish waits for" is the first cause along the chain that is not just a link.
 */
export const mostLimiting = (result: ExplainResult, context: Context): { readonly parts: readonly Part[] } | null => {
  const limiting = result.limiting
  const named = limiting === undefined ? null : { name: context.names.resource(limiting.about.key), kind: 'resource' as const, key: limiting.about.key }
  if (limiting?.result === 'gain' && named !== null) {
    return { parts: ['Most limiting: ', named, '. One more ', named, ` would allow a finish at least ${hoursText(limiting.hoursEarlier)} earlier.`] }
  }
  for (const item of result.items) {
    const binding = item.because.find(because => because.kind !== 'link')
    if (binding === undefined) continue
    const waits = ended(['Most limiting: the finish waits on ', { name: context.names.job(item.job), kind: 'job', key: item.job }, ': ', ...causeParts(binding, context, item.start)])
    return { parts: named === null ? waits : [...waits, ' One more ', named, ' alone does not bring it earlier in this plan.'] }
  }
  return named === null ? null : { parts: ['Most limiting: one more ', named, ' alone does not bring the finish earlier in this plan.'] }
}
