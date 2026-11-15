// The presenter: planner words generated from structure (never stored), and the bounded sections that
// planning.plan.read returns. The UI's format.ts mirrors these rules. Every section fits the 4 KB result.
import { goalResolution, type Certificate, type CertifiedSize, type Plan, type PlanInputs, type Status } from './schema.ts'
import { resultLimitBytes, type OptionWarning, type SectionName } from '../api/contract.ts'
import type { ChangeRecord, Weakening } from './edits.ts'
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

const datedTime = new Map<string, Intl.DateTimeFormat>()
/** "Thu 3 Sep 10:02" in the plan's zone, for read times that can lie outside the plan's week (walk 2, R2-8). */
export const datedWords = (instant: string, zone: string | null): string => {
  const key = zone ?? 'UTC'
  let format = datedTime.get(key)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: key, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    datedTime.set(key, format)
  }
  const part = (type: Intl.DateTimeFormatPartTypes, parts: Intl.DateTimeFormatPart[]) => parts.find(entry => entry.type === type)?.value ?? ''
  const parts = format.formatToParts(new Date(instant))
  const text = `${part('weekday', parts)} ${part('day', parts)} ${part('month', parts)} ${part('hour', parts)}:${part('minute', parts)}`
  return zone === null ? `${text} UTC` : text
}

const grouped = (value: number): string => Math.round(value).toLocaleString('en-US')
export const decimal = (value: number): string => Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 2 : 1).replace(/0+$/, '').replace(/\.$/, '')

/** A value with its unit in planner words: "3.5 h", "NOK 380,000", "2 min 10 s". */
export const valueWords = (value: number, unit: string): string => {
  if (/^[A-Z]{3}$/.test(unit)) return `${unit} ${grouped(value)}`
  if (unit === 's') {
    const minutes = Math.floor(value / 60), seconds = Math.round(value % 60)
    return minutes === 0 ? `${seconds} s` : seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
  }
  return `${decimal(value)} ${unit}`
}

/** A duration in planner words, in whole seconds, never a fraction (walk 5, R4-4-08): "3 min 30 s", "2 h 30 min". */
export const msWords = (ms: number): string => {
  const total = Math.round(ms / 1_000)
  const hours = Math.floor(total / 3_600), minutes = Math.floor(total % 3_600 / 60), seconds = total % 60
  return [hours > 0 ? `${hours} h` : '', minutes > 0 ? `${minutes} min` : '', seconds > 0 ? `${seconds} s` : ''].filter(Boolean).join(' ') || '0 s'
}

/** A duration before it was rounded up: exact when it is whole seconds, else "about 7 min 49 s". */
const beforeRounding = (fromMs: number): string => fromMs % 1_000 === 0 ? msWords(fromMs) : `about ${msWords(fromMs)}`
/** Rounded up by under half a second: in whole seconds its two values read the same, so naming it says nothing. */
const readsTheSame = (fromMs: number, toMs: number): boolean => Math.round(fromMs / 1_000) * 1_000 >= toMs

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

export const names = (inputs: Inputs, keys: readonly string[], limit = 4): string => {
  const shown = keys.slice(0, limit).map(key => nameOf(inputs, key))
  return keys.length > limit ? `${shown.join(', ')} and ${keys.length - limit} more` : shown.join(', ')
}

/** Text within `limit` characters, cut at a word boundary and ended with "…" (walk 2: never mid-word). */
export const clip = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:(–-]+$/, '')}…`
}

// ───────────── changes ─────────────

const whatWords: Readonly<Record<ChangeRecord['what'], string>> = {
  plan: 'plan', equipment: 'equipment', group: 'group', calendar: 'calendar', resource: 'crew or tool', purchase: 'purchase',
  method: 'method', job: 'job', link: 'link', rule: 'rule', goals: 'goals',
}

/** A changed field in planner words: never a schema name such as "dataDate" (walk 3, G2). */
const fieldOverrides: Readonly<Record<string, string>> = {
  dataDate: 'the plan\'s now', timeZone: 'time zone', run: 'linked simulation', needs: 'who does it', durationWith: 'duration per crew or tool',
  supportedBy: 'supported by', groupLabel: 'group name', notBefore: 'earliest start', finishBy: 'latest finish', atLeast: 'how many stay in service',
  maxJobs: 'most jobs ahead', crewSize: 'people per crew', orderBy: 'order by',
}
const fieldWords = (field: string): string => fieldOverrides[field] ?? field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()

/** One line per change, at most 12, the last saying how many more. */
export const changeLines = (changes: readonly ChangeRecord[], inputs: Inputs, limit = 12): readonly string[] => {
  const line = (change: ChangeRecord): string => {
    if (change.what === 'plan') return clip(`Changed the plan: ${change.fields.map(fieldWords).join(', ')}`, 200)
    if (change.what === 'goals') return 'Changed the goal order'
    // A link is named by its jobs, never by keys: "from 'Open the heads' to 'Clean the tubes' (start-start)".
    const linkName = (): string => {
      const [from = '', type = '', to = ''] = change.key.split(' ')
      const kinds: Readonly<Record<string, string>> = { FS: 'finish-start', SS: 'start-start', FF: 'finish-finish' }
      return `from '${nameOf(inputs, from)}' to '${nameOf(inputs, to)}' (${kinds[type] ?? type})`
    }
    const name = change.what === 'link' ? linkName() : `${nameOf(inputs, change.key)}`
    if (change.fields.includes('drafted')) {
      const job = inputs.jobs.find(entry => entry.key === change.key)
      return clip(`Drafted ${job?.kind === 'test' ? 'return-to-service test' : 'tag-out'} '${nameOf(inputs, change.key)}' (${job?.duration.value ?? 1} h, an assumption)`, 200)
    }
    const verb = change.verb === 'added' ? 'Added' : change.verb === 'removed' ? 'Removed' : 'Changed'
    const fields = change.verb === 'changed' && change.fields.length > 0 ? `: ${change.fields.map(fieldWords).join(', ')}` : ''
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

// ───────────── refusals ─────────────

/** A key with its label, for a refusal an Assistant quotes to a person: "'Service Water Pump B' (SWB)". */
export const labelled = (inputs: Inputs, key: string): string => {
  const name = nameOf(inputs, key)
  return name === key ? key : `'${name}' (${key})`
}

/** The rule a weakening edit loosens, in planner words, from the plan as it was before the edit. */
export const weakeningWords = (weakening: Weakening, inputs: Inputs): string => {
  const [first = '', ...rest] = weakening.about
  const name = nameOf(inputs, first)
  const job = inputs.jobs.find(entry => entry.key === first)
  switch (weakening.what) {
    case 'support': return clip(`${name} is out of service whenever ${names(inputs, rest)} is out; removing that support loosens the rules that cover it.`, 240)
    case 'group': return clip(`${name} counts toward the outage limit of ${nameOf(inputs, rest[0] ?? '')}; taking it out of that group loosens the limit.`, 240)
    case 'function': return clip(`${name} backs up the other items of its function; changing that hides a redundancy warning.`, 240)
    case 'locator': return clip(`The rules and outage limits on ${name} apply to its World item; pointing it at another one loosens them.`, 240)
    case 'job-kind': case 'isolation': case 'covering-equipment': case 'covering-job':
      return clip(`${name} brackets the work on ${names(inputs, rest.length > 0 ? rest : job?.equipment ?? [])} with a tag-out or test; changing it loosens that coverage.`, 240)
    case 'precondition': return clip(`${name} may start only when ${job?.checks.map(check => `"${check.words}"`).join(' and ') ?? 'its World precondition holds'}; removing that check drops the precondition.`, 240)
    case 'rule': case 'protected': return clip(inputs.rules.find(rule => rule.key === first)?.words ?? `The rule ${first}`, 240)
    case 'equipment': return clip(`${name} is covered by a rule or an outage limit; removing it loosens that coverage.`, 240)
    case 'minimum': case 'below-minimum': {
      const minimum = job?.minimum
      return clip(minimum === undefined ? `${name} has a declared minimum duration.` : `${name} takes at least ${valueWords(minimum.value, minimum.unit)}: ${minimum.words}.`, 240)
    }
  }
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
      case 'world-unusable': {
        const value = item.label === undefined ? 'a World value' : `'${item.label}' from World`
        const given = item.unit === undefined ? 'has no unit' : item.unit === '1' ? 'is a plain count with no unit' : `is in ${item.unit}`
        return inputs.jobs.some(job => job.key === item.about[0])
          ? `${name}: ${value} ${given}, not a time; take the duration from another value or give your own estimate.`
          : `${name}: ${value} ${given}, which does not convert to ${item.words ?? 'the unit a job asks for'}; change that job's need, or stop using this value.`
      }
      case 'world-duration': return `${name}: taken from '${item.label ?? ''}' (${basisWords[item.basis ?? ''] ?? item.basis}, read ${item.at === undefined ? '' : datedWords(item.at, zone)}, simulation time); check it describes the work.`
      case 'no-crew': {
        const job = inputs.jobs.find(entry => entry.key === item.about[0])
        const what = job?.kind === 'tag-out' ? 'tag-out' : job?.kind === 'test' ? 'return-to-service test' : 'job'
        return item.words === 'drafted' ? `The drafted ${what} '${name}' needs a crew: add one.` : `'${name}' needs a crew or tool: add one.`
      }
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
      case 'assumptions': {
        const parts = [
          ...(item.count === undefined || item.count === 0 ? [] : [item.count === 1 ? 'one planning value is an assumption' : `${item.count} planning values are assumptions`]),
          ...(item.proxies === undefined ? [] : [`${item.proxies} durations are World values that stand in for the work`]),
        ]
        const head = parts.join(' and ')
        return `${head.charAt(0).toUpperCase()}${head.slice(1)}, such as ${names(inputs, item.about, 2)}: review them.`
      }
      case 'rounded': {
        const rounded = item.durations ?? []
        const step = inputs.settings.grid === '30s' ? '30 s' : '30 min'
        const head = `${rounded.length === 1 ? 'One duration was' : `${rounded.length} durations were`} rounded up to the ${step} step`
        // Only a duration whose two values read differently is named (walk 6, item 9); the count stays the whole.
        const each = rounded.filter(entry => !readsTheSame(entry.fromMs, entry.toMs))
          .map(entry => `${nameOf(inputs, entry.job)}${entry.resource === undefined ? '' : ` with ${nameOf(inputs, entry.resource)}`} from ${beforeRounding(entry.fromMs)} to ${msWords(entry.toMs)}`)
        if (each.length === 0) return `${head}, ${rounded.length === 1 ? 'by' : 'each by'} less than a second.`
        // As many as fit whole, at most two; the rest are counted, and the sentence always ends in a full stop.
        for (const count of [2, 1]) {
          const more = rounded.length - Math.min(count, each.length)
          const text = `${head}: ${each.slice(0, count).join('; ')}${more > 0 ? `, and ${more} more` : ''}.`
          if (text.length <= 240) return text
        }
        return `${head}.`
      }
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
    case 'temporal': return cause.steps.length === 0 ? 'links and limits leave no time' : `links and limits leave no time (${names(inputs, cause.steps.map(step => step.job), 3)})`
  }
}

/** Why a search ended before its budget: memory and processor limits, or a stop. The budget's own end is not early. */
const earlyStopWords: Readonly<Partial<Record<string, string>>> = { memory: 'memory limit', cpu: 'processor time limit', cancelled: 'cancelled', ended: 'the solver process ended' }

/** The status in words, generated from the structured status. */
export const statusSentence = (status: Status, inputs: Inputs): string => {
  switch (status.word) {
    case 'validated feasible': {
      // One word per goal (walk 4, R4-3): proven optimal on lane K's bound, else best found with the gap a
      // sound bound leaves; a bound is never called "the best possible".
      const word = (goal: Extract<Status, { word: 'validated feasible' }>['goals'][number]): string => {
        if (goal.word === 'proven optimal') return 'proven optimal'
        const gap = goal.bound === undefined ? undefined : goal.value - goal.bound.value
        return gap === undefined || gap <= (goalResolution(goal.unit, status.run.grid) ?? 0) / 2 ? 'best found' : `best found; could be up to ${valueWords(gap, goal.unit)} better`
      }
      const goals = status.goals.map(goal => `${goalWords[inputs.goals[goal.goal]?.metric ?? 'finish']} ${valueWords(goal.value, goal.unit)} (${word(goal)})`)
      // How the search ended, said once: stopped early (walk 3, R3-3) or ran to the end.
      const early = earlyStopWords[status.run.stoppedBy]
      const ended = early === undefined ? ' The search ran to the end.' : ` The search stopped early (${early}); this option may not be the best.`
      return `${clip(`Validated feasible${goals.length === 0 ? '' : `: ${goals.join('; ')}`}.`, 300 - ended.length)}${ended}`
    }
    case 'proven infeasible': return clip(`Proven infeasible: ${certificateWords(status.cause, inputs)}.`, 300)
    case 'invalid input': return clip(`Invalid input: ${status.problems.map(problem => problem.code === 'working_time_without_resource'
      ? `${names(inputs, problem.about, 2)} ${problem.about.length === 1 ? 'needs' : 'need'} a crew: add one`
      : `${problem.code.replaceAll('_', ' ')}${problem.about.length === 0 ? '' : ` (${names(inputs, problem.about, 2)})`}`).join('; ')}.`, 300)
    case 'unsupported feature': return clip(`Unsupported feature: ${status.problems.map(problem => problem.code.replaceAll('_', ' ')).join('; ')}.`, 300)
    case 'cancelled': return 'Stopped before any plan was found.'
    case 'unresolved': return clip(`Unresolved, not proof: no plan within the window was found in the time allowed${status.attempt === undefined ? '' : `; the best attempt finishes ${nameOf(inputs, status.attempt.job)} ${decimal(status.attempt.pastWindowHours)} h past the window`}.`, 300)
  }
}

// ───────────── the certified size: counted and said in one place (Generate, the API, the screen) ─────────────

/**
 * The jobs one solve takes, counted as the size measurement counted them: after method selection (every job
 * outside a method, plus the largest option of each method choice), so each method combination is one
 * solve. Plan inputs hold no helper milestones (spans are derived), so every job counts. The flagship's 34
 * job records, with both SW A methods, are 33 per solve.
 */
export const jobsPerSolve = (inputs: Pick<PlanInputs, 'jobs' | 'methods'>): number => {
  const outside = inputs.jobs.filter(job => job.method === undefined).length
  return outside + inputs.methods.reduce((sum, choice) =>
    sum + Math.max(0, ...choice.options.map(option => inputs.jobs.filter(job => job.method?.choice === choice.key && job.method.option === option.key).length)), 0)
}
/** Whether the plan is within the certified size: no solve above `maxJobs`. */
export const withinCertifiedSize = (inputs: Pick<PlanInputs, 'jobs' | 'methods'>, size: CertifiedSize): boolean => jobsPerSolve(inputs) <= size.maxJobs
/**
 * Where a plan's size puts it: certified (up to `maxJobs` jobs in one solve), caution (Generate runs, and
 * every option carries the size caution, up to `limitJobs`), or refused (above `limitJobs`).
 */
export const sizeBand = (inputs: Pick<PlanInputs, 'jobs' | 'methods'>, size: CertifiedSize): 'certified' | 'caution' | 'refused' =>
  jobsPerSolve(inputs) <= size.maxJobs ? 'certified' : jobsPerSolve(inputs) <= size.limitJobs ? 'caution' : 'refused'
/** The caution an option carries when it was solved above the certified size, in planner words. */
export const sizeCautionWords = (size: CertifiedSize): string =>
  `Above the certified size (${size.maxJobs} jobs). This plan keeps every hard rule, but it may not be near the best.`
/** That caution as an option warning, shown beside the option's status. */
export const sizeCautionWarning = (size: CertifiedSize): OptionWarning => ({ kind: 'above-certified-size', text: clip(sizeCautionWords(size), 240), about: [] })
/**
 * The refusal of a plan above `limitJobs` (the 413 of Generate and the API, and the screen's card), in plain
 * words: no "solve", no "system window". The header's size line is the screen's own (ui planSizeLine).
 */
export const sizeRefusalWords = (size: CertifiedSize, inputs: Pick<PlanInputs, 'jobs' | 'methods'>): string =>
  `This plan has ${jobsPerSolve(inputs)} jobs to schedule at once. ${size.decided ? `Planning handles up to ${size.limitJobs}, and is certified for up to ${size.maxJobs}. Split the work into separate plans.` : `Planning has been measured for plans of up to ${size.maxJobs} jobs; larger plans wait for the owner's decision.`}`

// ───────────── read sections ─────────────
// The `data` of each planning.plan.read section, in the shapes of api/contract.ts sectionDataSchemas, which
// the service, the screen and the Assistant share. Records are the stored plan's own schemas; words come
// with attention and warnings only. Every section but summary pages within the 4 KB result.

export interface OptionState {
  readonly stale: boolean
  readonly reason?: 'revision' | 'formulation'
  readonly warnings: readonly OptionWarning[]
  /** The status to show: the stored one, checked by lane K inside Generate, only on its revision and formulation. */
  readonly shown: Status
  readonly baselineAllowed: boolean
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
      return { ...rest, status: state?.shown ?? rest.status, fresh: state !== undefined && !state.stale, warnings: [...(state?.warnings ?? []).slice(0, 4)] }
    }), offset, budget, { at: plan.options?.at ?? null, recommended: plan.options?.recommended ?? null })
    case 'schedule': {
      if (option === undefined) throw new RangeError('A schedule names its option')
      return pagedSection(name, [...option.rows].sort((left, right) => left.start.localeCompare(right.start) || left.job.localeCompare(right.job)), offset, budget, { option: option.key })
    }
    case 'history': return pagedSection(name, [...plan.changes].reverse(), offset, budget)
  }
}
