// The presenter: planner words generated from structure (never stored), and the bounded sections that
// planning.plan.read returns. The UI's format.ts mirrors these rules. Every section fits the 4 KB result.
import type { Certificate, CertifiedSize, Plan, PlanInputs, Status } from './schema.ts'
import { resultLimitBytes, type OptionWarning, type SectionName } from '../api/contract.ts'
import type { ChangeRecord } from './edits.ts'
import type { OutTogether, Precondition, ReadinessItem } from './readiness.ts'

type Inputs = PlanInputs
type Option = NonNullable<Plan['options']>['options'][number]

export { resultLimitBytes }
export const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

// ───────────── words for values ─────────────

const weekdayTime = new Map<string, Intl.DateTimeFormat>()
/** "Thu 10:02" in the plan's zone; "Thu 10:02 UTC" when the plan has none yet. */
export const timeWords = (instant: string, zone: string | null): string => {
  const key = zone ?? 'UTC'
  let format = weekdayTime.get(key)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: key, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    weekdayTime.set(key, format)
  }
  const text = format.format(new Date(instant)).replace(',', '')
  return zone === null ? `${text} UTC` : text
}

const grouped = (value: number): string => Math.round(value).toLocaleString('en-US')
const decimal = (value: number): string => Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 2 : 1).replace(/0+$/, '').replace(/\.$/, '')

/** A value with its unit in planner words: "3.5 h", "NOK 380,000", "2 min 10 s". */
export const valueWords = (value: number, unit: string): string => {
  if (/^[A-Z]{3}$/.test(unit)) return `${unit} ${grouped(value)}`
  if (unit === 's') {
    const minutes = Math.floor(value / 60), seconds = Math.round(value % 60)
    return minutes === 0 ? `${seconds} s` : seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
  }
  return `${decimal(value)} ${unit}`
}

export const basisWords: Readonly<Record<string, string>> = { design: 'design', configured: 'configured', observed: 'observed', 'owner-estimate': 'owner estimate' }

const goalWords: Readonly<Record<Inputs['goals'][number]['metric'], string>> = {
  'span-over': 'outage time over target', finish: 'finish', 'extra-cost': 'extra cost', 'unavailable-hours': 'hours out of service', lateness: 'lateness',
}

// ───────────── names ─────────────

/** The name a person knows a plan key by. */
export const nameOf = (inputs: Inputs, key: string): string =>
  inputs.jobs.find(job => job.key === key)?.title
  ?? inputs.equipment.find(item => item.key === key)?.label
  ?? inputs.resources.find(resource => resource.key === key)?.label
  ?? inputs.purchases.find(purchase => purchase.key === key)?.label
  ?? inputs.calendars.find(calendar => calendar.key === key)?.label
  ?? inputs.groups.find(group => group.key === key)?.label
  ?? inputs.methods.find(method => method.key === key)?.label
  ?? inputs.rules.find(rule => rule.key === key)?.words
  ?? key

const names = (inputs: Inputs, keys: readonly string[], limit = 4): string => {
  const shown = keys.slice(0, limit).map(key => nameOf(inputs, key))
  return keys.length > limit ? `${shown.join(', ')} and ${keys.length - limit} more` : shown.join(', ')
}

const clip = (text: string, limit: number): string => text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`

// ───────────── changes ─────────────

const whatWords: Readonly<Record<ChangeRecord['what'], string>> = {
  plan: 'plan', equipment: 'equipment', group: 'group', calendar: 'calendar', resource: 'crew or tool', purchase: 'purchase',
  method: 'method', job: 'job', link: 'link', rule: 'rule', goals: 'goals',
}

/** One line per change, at most 12, the last saying how many more. */
export const changeLines = (changes: readonly ChangeRecord[], inputs: Inputs, limit = 12): readonly string[] => {
  const line = (change: ChangeRecord): string => {
    if (change.what === 'plan') return clip(`Changed the plan: ${change.fields.join(', ')}`, 200)
    if (change.what === 'goals') return 'Changed the goal order'
    const name = change.what === 'link' ? change.key : `${nameOf(inputs, change.key)}`
    const verb = change.verb === 'added' ? 'Added' : change.verb === 'removed' ? 'Removed' : 'Changed'
    const fields = change.verb === 'changed' && change.fields.length > 0 ? `: ${change.fields.join(', ')}` : ''
    return clip(`${verb} ${whatWords[change.what]} ${name}${fields}`, 200)
  }
  if (changes.length <= limit) return changes.map(line)
  return [...changes.slice(0, limit - 1).map(line), `…and ${changes.length - limit + 1} more changes`]
}

export const changeSummary = (changes: readonly ChangeRecord[], inputs: Inputs): string => {
  if (changes.length === 0) return 'No change'
  const lines = changeLines(changes, inputs, 3)
  return clip(lines.join('; '), 240)
}

// ───────────── readiness ─────────────

/** One readiness item in planner words, at most 240 characters. */
export const readinessText = (item: ReadinessItem, inputs: Inputs): string => {
  const zone = inputs.settings.timeZone
  const name = item.about[0] === undefined ? '' : nameOf(inputs, item.about[0])
  const at = item.at === undefined ? '' : timeWords(item.at, zone)
  const text = (() => {
    switch (item.code) {
      case 'link-run': return item.label === undefined
        ? 'Link a running simulation so the plan can read World values.'
        : `Start the '${item.label}' simulation in World, then link it here.`
      case 'world-unread': return inputs.settings.run === null
        ? `${name}: ${item.count === 1 ? 'a World value is' : `${item.count} World values are`} not read yet; link the simulation and refresh.`
        : `${name}: ${item.count === 1 ? 'a World value is' : `${item.count} World values are`} not read yet; refresh.`
      case 'world-unusable': return `${name}: a World value is in ${item.unit ?? 'a unit'} Planning cannot use here.`
      case 'world-duration': return `${name}: taken from '${item.label ?? ''}' (${basisWords[item.basis ?? ''] ?? item.basis}, read ${at}); check it describes the work.`
      case 'no-crew': return `${name}: no crew or tool is named to do it.`
      case 'no-tag-out': return `${name}: worked on inside but never tagged out.`
      case 'no-test': return `${name}: worked on inside but never tested back into service.`
      case 'not-returned': return `${name}: tagged out but never tested back into service.`
      case 'precondition-unmet': return `Not ready at read time (${at}): ${item.words ?? ''} is not so.`
      case 'precondition-unread': return `${item.words ?? ''}: not read yet.`
      case 'below-minimum': return `${name}: World values would make this test shorter than its declared minimum. Give a value of your own, or have a named person agree to a lower one.`
      case 'order-by': return `Order by ${at}: ${name}.`
      case 'order-passed': return `Order deadline passed (${at}): ${name} can no longer be used.`
      case 'assumption': return item.at !== undefined
        ? `${name}: depends on ${item.words ?? 'an assumption'}, ${at}.`
        : `${names(inputs, item.about, 2)}: an assumption${item.words === undefined ? '' : ` (${item.words})`}; confirm it.`
      case 'redundancy': return `${item.count} items are taken out and no rule keeps any of them in service. If they back each other up, add 'keep at least k of these in service'.`
      case 'options-stale': return `${item.count === 1 ? 'One option no longer matches' : `${item.count} options no longer match`} the plan; generate again.`
    }
  })()
  return clip(text, 240)
}

export const attentionKind = (item: ReadinessItem): 'refusal' | 'not-ready' | 'rule' | 'limit' | 'world' | 'decision' | 'stale' | 'warning' =>
  item.kind === 'not-ready' ? 'not-ready' : item.kind

export const preconditionText = (check: Precondition, zone: string | null): string =>
  check.state === 'unread' ? `${check.words} (not read yet)`
    : `${check.words}${check.state === 'met' ? '' : ': not so'} (at read time, ${timeWords(check.at!, zone)})`

/** The redundancy warning beside an option's status, in words with its keys (api/contract.ts optionWarningSchema). */
export const optionWarning = (warning: OutTogether, inputs: Inputs): OptionWarning => ({ kind: warning.kind, text: optionWarningText(warning, inputs), about: [...warning.about.slice(0, 4)] })

export const optionWarningText = (warning: OutTogether, inputs: Inputs): string =>
  clip(`${names(inputs, warning.about)} are out together (${timeWords(warning.from, inputs.settings.timeZone)} to ${timeWords(warning.to, inputs.settings.timeZone)}) and no rule keeps any of them in service.`, 240)

// ───────────── status ─────────────

const certificateWords = (cause: Certificate, inputs: Inputs): string => {
  const zone = inputs.settings.timeZone
  switch (cause.kind) {
    case 'chain': return `the chain ${names(inputs, cause.jobs, 3)} needs ${decimal(cause.workHours)} h of work, but only ${decimal(cause.availableHours)} h are available from ${timeWords(cause.from, zone)} to ${timeWords(cause.by, zone)}`
    case 'energy': return `${names(inputs, cause.resources, 3)} would need ${decimal(cause.requiredHours)} h between ${timeWords(cause.from, zone)} and ${timeWords(cause.to, zone)}, but at most ${decimal(cause.availableHours)} h exist`
    case 'availability': return `${nameOf(inputs, cause.rule)} cannot be kept from ${timeWords(cause.from, zone)} to ${timeWords(cause.to, zone)}`
    case 'temporal': return `links and limits leave no time (${names(inputs, cause.steps.map(step => step.job), 3)})`
  }
}

/** The status in words, generated from the structured status. */
export const statusSentence = (status: Status, inputs: Inputs): string => {
  switch (status.word) {
    case 'validated feasible': {
      const goals = status.goals.map(goal => `${goalWords[inputs.goals[goal.goal]?.metric ?? 'finish']} ${valueWords(goal.value, goal.unit)} (${goal.word})`)
      return clip(`Validated feasible${goals.length === 0 ? '' : `: ${goals.join('; ')}`}.`, 300)
    }
    case 'proven infeasible': return clip(`Proven infeasible: ${certificateWords(status.cause, inputs)}.`, 300)
    case 'invalid input': return clip(`Invalid input: ${status.problems.map(problem => `${problem.code.replaceAll('_', ' ')}${problem.about.length === 0 ? '' : ` (${names(inputs, problem.about, 2)})`}`).join('; ')}.`, 300)
    case 'unsupported feature': return clip(`Unsupported feature: ${status.problems.map(problem => problem.code.replaceAll('_', ' ')).join('; ')}.`, 300)
    case 'cancelled': return 'Stopped before any plan was found.'
    case 'unresolved': return clip(`Unresolved, not proof: no plan within the window was found in the time allowed${status.attempt === undefined ? '' : `; the best attempt finishes ${nameOf(inputs, status.attempt.job)} ${decimal(status.attempt.pastWindowHours)} h past the window`}.`, 300)
  }
}

/** "certified for single-train work weeks up to 100 jobs; measured 11 Nov". */
export const certifiedSizeWords = (size: CertifiedSize): string => `certified for ${size.family} up to ${size.maxJobs} jobs; ${size.evidence}`

// ───────────── read sections ─────────────
// The `data` of each planning.plan.read section, in the shapes of api/contract.ts sectionDataSchemas, which
// the service, the screen and the Assistant share. Records are the stored plan's own schemas; words come
// with attention and warnings only. Every section but summary pages within the 4 KB result.

export interface OptionState {
  readonly stale: boolean
  readonly reason?: 'revision' | 'formulation' | 'recheck'
  readonly warnings: readonly OptionWarning[]
}

export interface SectionContext {
  readonly plan: Plan
  readonly readiness: readonly ReadinessItem[]
  readonly options: ReadonlyMap<string, OptionState>
  readonly certifiedSize: CertifiedSize
}

export interface Section { readonly id: string; readonly title: string; readonly description?: string; readonly data: unknown }

/** Takes items from `offset` while the section data stays inside `budget` bytes; `more` continues it. */
export const page = <T>(items: readonly T[], offset: number, budget: number, wrap: (shown: readonly T[], more: string | undefined) => unknown): unknown => {
  if (offset > items.length) throw new RangeError('The cursor is past the end of this section')
  let count = 0
  let best = wrap([], offset < items.length ? String(offset) : undefined)
  while (offset + count < items.length) {
    const more = offset + count + 1 < items.length ? String(offset + count + 1) : undefined
    const candidate = wrap(items.slice(offset, offset + count + 1), more)
    if (byteLength(candidate) > budget) break
    best = candidate
    count += 1
  }
  if (count === 0 && offset < items.length) throw new RangeError('One record of this section is larger than a page')
  return best
}

const titles: Readonly<Record<SectionName, string>> = {
  summary: 'Summary', jobs: 'Jobs, links and methods', rules: 'Rules', crews: 'Calendars, crews, tools and purchases',
  sources: 'Equipment, groups and World values', options: 'Options', schedule: 'Schedule', history: 'Change history',
}

const pagedSection = (name: SectionName, items: readonly unknown[], offset: number, budget: number, extra: Record<string, unknown> = {}): Section[] =>
  [{ id: name, title: titles[name], data: page(items, offset, budget, (shown, more) => ({ ...extra, items: shown, ...(more === undefined ? {} : { more }) })) }]

/** The summary: the plan's frame, settings and goals, what needs attention, and the certified size. */
const summarySection = (context: SectionContext, budget: number): Section[] => {
  const { plan } = context
  const attention = context.readiness.slice(0, 6).map(item => ({ kind: attentionKind(item), text: readinessText(item, plan.inputs), about: [...item.about.slice(0, 4)] }))
  const data = (shown: number) => ({
    plan: { id: plan.id, title: plan.inputs.settings.title, revision: plan.revision, updatedAt: plan.updatedAt },
    settings: plan.inputs.settings, goals: plan.inputs.goals, refreshedAt: plan.inputs.world.refreshedAt,
    attention: attention.slice(0, shown), certifiedSize: context.certifiedSize,
  })
  for (let shown = attention.length; shown >= 0; shown -= 1) if (byteLength(data(shown)) <= budget) return [{ id: 'summary', title: titles.summary, data: data(shown) }]
  throw new RangeError('The plan summary does not fit a page')
}

/** One section of planning.plan.read. `option` names the schedule's option. */
export const buildSection = (name: SectionName, context: SectionContext, offset: number, budget: number, option?: Option): Section[] => {
  const { plan } = context
  const inputs = plan.inputs
  switch (name) {
    case 'summary': return summarySection(context, budget)
    case 'jobs': return pagedSection(name, [...inputs.jobs.map(job => ({ job })), ...inputs.links.map(link => ({ link })), ...inputs.methods.map(method => ({ method }))], offset, budget)
    case 'rules': return pagedSection(name, inputs.rules.map(rule => ({ rule })), offset, budget)
    case 'crews': return pagedSection(name, [...inputs.calendars.map(calendar => ({ calendar })), ...inputs.resources.map(resource => ({ resource })), ...inputs.purchases.map(purchase => ({ purchase }))], offset, budget)
    case 'sources': return pagedSection(name, [...inputs.equipment.map(equipment => ({ equipment })), ...inputs.groups.map(group => ({ group })), ...inputs.world.facts.map(fact => ({ fact }))], offset, budget)
    case 'options': return pagedSection(name, (plan.options?.options ?? []).map(({ rows: _rows, ...rest }) => {
      const state = context.options.get(rest.key)
      return { ...rest, fresh: state !== undefined && !state.stale, warnings: [...(state?.warnings ?? []).slice(0, 4)] }
    }), offset, budget, { at: plan.options?.at ?? null, recommended: plan.options?.recommended ?? null })
    case 'schedule': {
      if (option === undefined) throw new RangeError('A schedule names its option')
      return pagedSection(name, [...option.rows].sort((left, right) => left.start.localeCompare(right.start) || left.job.localeCompare(right.job)), offset, budget, { option: option.key })
    }
    case 'history': return pagedSection(name, [...plan.changes].reverse(), offset, budget)
  }
}
