// The presenter: planner words generated from structure (never stored), and the bounded sections that
// planning.plan.read returns. The UI's format.ts mirrors these rules. Every section fits the 4 KB result.
import { combineWorldFacts, type Certificate, type CertifiedSize, type Origin, type Plan, type PlanInputs, type Status } from './schema.ts'
import type { ChangeRecord } from './edits.ts'
import type { OptionWarning, Precondition, ReadinessItem } from './readiness.ts'

type Inputs = PlanInputs
type Option = NonNullable<Plan['options']>['options'][number]

export const resultLimitBytes = 4_096
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

export const optionWarningText = (warning: OptionWarning, inputs: Inputs): string =>
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

export interface OptionState {
  readonly stale: boolean
  readonly reason?: 'revision' | 'formulation' | 'recheck'
  readonly warnings: readonly OptionWarning[]
}

export interface SectionContext {
  readonly plan: Plan
  readonly readiness: readonly ReadinessItem[]
  readonly preconditions: readonly Precondition[]
  readonly options: ReadonlyMap<string, OptionState>
  readonly certifiedSize: CertifiedSize
}

export interface Section { readonly id: string; readonly title: string; readonly description?: string; readonly data: unknown }

const metric = (option: Option, id: string): number | undefined => option.metrics.find(entry => entry.id === id)?.value

/** What a person sees of an option: its status in words, beside its warnings, stale or not. */
export const optionLine = (option: Option, state: OptionState | undefined, inputs: Inputs) => ({
  key: option.key, label: option.label, status: option.status.word,
  words: state?.stale ? `Out of date: ${state.reason === 'formulation' ? 'the solver changed' : state.reason === 'recheck' ? 'the re-check against the current plan failed' : 'the plan changed'} since it was generated.` : statusSentence(option.status, inputs),
  stale: state?.stale ?? true,
  ...(state === undefined || state.warnings.length === 0 ? {} : { warnings: state.warnings.map(warning => optionWarningText(warning, inputs)) }),
  ...(metric(option, 'span') === undefined ? {} : { spanHours: metric(option, 'span') }),
  ...(metric(option, 'extra-cost') === undefined ? {} : { cost: metric(option, 'extra-cost') }),
})

/** Takes items from `offset` while the section stays inside `budget` bytes; `more` continues it. */
export const page = <T>(items: readonly T[], offset: number, budget: number, wrap: (shown: readonly T[], more: string | undefined) => unknown): unknown => {
  let count = 0
  let best = wrap([], items.length > offset ? String(offset) : undefined)
  while (offset + count < items.length) {
    const shown = items.slice(offset, offset + count + 1)
    const more = offset + count + 1 < items.length ? String(offset + count + 1) : undefined
    const candidate = wrap(shown, more)
    if (byteLength(candidate) > budget) break
    best = candidate
    count += 1
  }
  return best
}

/** A stored value, or a World value computed from the read facts with its basis and read time. */
export const valueOf = (value: number | null, unit: string, origin: Origin, inputs: Inputs): string => {
  if (origin.by !== 'world') return value === null ? 'not given' : valueWords(value, unit)
  const combined = combineWorldFacts(origin.refs, inputs.world.facts, unit)
  return combined.ok ? `${valueWords(combined.value, unit)} · ${basisWords[combined.basis]} · read ${timeWords(combined.at, inputs.settings.timeZone)}` : 'not read yet'
}

// Reads duration.range (T1 "estimate ranges").
const durationLine = (job: Inputs['jobs'][number], inputs: Inputs) =>
  `${valueOf(job.duration.value, job.duration.unit, job.duration.origin, inputs)}${job.duration.range === undefined ? '' : ` (${decimal(job.duration.range.low)}–${decimal(job.duration.range.high)} ${job.duration.unit})`}${job.duration.calendar === 'working' ? ' working' : ''}`

const sourceWords = (origin: Origin): string =>
  origin.by === 'world' ? 'from World' : origin.by === 'reference' ? `reference: ${origin.note ?? ''}` : origin.by === 'assumption' ? `assumption${origin.note === undefined ? '' : `: ${origin.note}`}` : origin.note ?? 'planner'

const sectionBuilders = {
  summary: (context: SectionContext, _offset: number, budget: number): Section[] => {
    const { plan } = context
    const inputs = plan.inputs
    const zone = inputs.settings.timeZone
    const recommended = plan.options?.options.find(option => option.key === plan.options?.recommended)
    const status = {
      title: inputs.settings.title, revision: plan.revision,
      ...(inputs.settings.purpose === undefined ? {} : { purpose: inputs.settings.purpose }),
      window: inputs.settings.window === null ? 'not set' : `${timeWords(inputs.settings.window.start, zone)} to ${timeWords(inputs.settings.window.end, zone)}`,
      simulation: inputs.settings.run === null ? 'not linked' : `linked ${timeWords(inputs.settings.run.linkedAt, zone)}${inputs.world.refreshedAt === null ? ', not read yet' : `, read ${timeWords(inputs.world.refreshedAt, zone)}`}`,
      plan: recommended === undefined ? 'Not generated yet.' : optionLine(recommended, context.options.get(recommended.key), inputs).words,
      counts: { jobs: inputs.jobs.length, crewsAndTools: inputs.resources.length, rules: inputs.rules.length, options: plan.options?.options.length ?? 0, baselines: plan.baselines.length },
      ...(context.preconditions.length === 0 ? {} : { preconditions: context.preconditions.slice(0, 4).map(check => preconditionText(check, zone)) }),
    }
    const attention = context.readiness.slice(0, 6).map(item => ({ kind: attentionKind(item), text: readinessText(item, inputs), about: item.about.slice(0, 4) }))
    const options = (plan.options?.options ?? []).map(option => optionLine(option, context.options.get(option.key), inputs))
    const sections = (shownOptions: readonly unknown[], shownAttention: readonly unknown[]): Section[] => [
      { id: 'status', title: 'Status', data: status },
      { id: 'attention', title: 'Needs attention', data: { items: shownAttention, ...(context.readiness.length > shownAttention.length ? { more: context.readiness.length - shownAttention.length } : {}) } },
      { id: 'options', title: 'Options', data: { ...(plan.options?.recommended === undefined ? {} : { recommended: plan.options.recommended }), items: shownOptions, ...(options.length > shownOptions.length ? { more: 'read the options section' } : {}) } },
    ]
    for (let shown = options.length; shown >= 0; shown -= 1) {
      for (let items = attention.length; items >= 0; items -= 1) {
        const candidate = sections(options.slice(0, shown), attention.slice(0, items))
        if (byteLength(candidate) <= budget) return candidate
      }
    }
    return sections([], [])
  },
  jobs: (context: SectionContext, offset: number, budget: number): Section[] => {
    const inputs = context.plan.inputs
    const zone = inputs.settings.timeZone
    const items = inputs.jobs.map(job => ({
      key: job.key, title: job.title, kind: job.kind,
      ...(job.equipment.length === 0 ? {} : { equipment: names(inputs, job.equipment) }),
      duration: durationLine(job, inputs), source: sourceWords(job.duration.origin),
      ...(job.minimum === undefined ? {} : { minimum: valueWords(job.minimum.value, job.minimum.unit) }),
      ...(job.needs.length === 0 ? {} : { needs: job.needs.map(need => `${need.amount} of ${names(inputs, need.anyOf)}`) }),
      ...(job.method === undefined ? {} : { method: `${nameOf(inputs, job.method.choice)}: ${inputs.methods.find(method => method.key === job.method!.choice)?.options.find(option => option.key === job.method!.option)?.label ?? job.method.option}` }),
      ...(job.notBefore === undefined ? {} : { notBefore: `${timeWords(job.notBefore.at, zone)}${job.notBefore.source.by === 'assumption' ? ' (assumption)' : ''}` }),
      ...(job.target === undefined ? {} : { finishBy: timeWords(job.target.finishBy, zone) }),
      ...(job.lock === undefined ? {} : { locked: timeWords(job.lock.start, zone) }),
    }))
    return [{ id: 'jobs', title: 'Jobs', data: page(items, offset, budget, (shown, more) => ({ total: items.length, items: shown, ...(more === undefined ? {} : { more }) })) }]
  },
  rules: (context: SectionContext, offset: number, budget: number): Section[] => {
    const inputs = context.plan.inputs
    const zone = inputs.settings.timeZone
    const items = [
      ...(inputs.settings.window === null ? [] : [{ kind: 'window', words: `Work fits inside ${timeWords(inputs.settings.window.start, zone)} to ${timeWords(inputs.settings.window.end, zone)}`, source: 'setting' }]),
      ...inputs.resources.filter(resource => resource.count === 1 && resource.kind === 'crew').map(resource => ({ kind: 'one at a time', words: `${resource.label}: one at a time`, source: 'crew count' })),
      ...inputs.rules.map(rule => ({
        key: rule.key, kind: rule.kind, words: rule.words,
        source: sourceWords(rule.source),
        about: rule.kind === 'protected' ? names(inputs, rule.equipment, 6)
          : rule.kind === 'keep-in-service' ? `at least ${rule.atLeast} of ${names(inputs, rule.members.map(member => 'equipment' in member ? member.equipment : member.resource), 6)}`
            : rule.kind === 'due' ? `${nameOf(inputs, rule.job)} finished by ${timeWords(rule.finishBy, zone)}`
              : `${nameOf(inputs, rule.group)} within ${valueWords(rule.limit.value, rule.limit.unit)}`,
      })),
    ]
    return [{ id: 'rules', title: 'Rules', data: page(items, offset, budget, (shown, more) => ({ total: items.length, items: shown, ...(more === undefined ? {} : { more }) })) }]
  },
  crews: (context: SectionContext, offset: number, budget: number): Section[] => {
    const inputs = context.plan.inputs
    const zone = inputs.settings.timeZone
    const items = [
      ...inputs.resources.map(resource => ({
        key: resource.key, label: resource.label, kind: resource.kind, count: resource.count,
        ...(resource.crewSize === undefined ? {} : { crewSize: resource.crewSize }),
        calendar: nameOf(inputs, resource.calendar),
        ...(resource.attributes.length === 0 ? {} : { attributes: resource.attributes.map(attribute => `${attribute.label} ${valueOf(attribute.value, attribute.unit, attribute.origin, inputs)}${attribute.changes.length === 0 ? '' : `, changes ${attribute.changes.map(change => `${timeWords(change.at, zone)} to ${valueWords(change.value, attribute.unit)}`).join(', ')}`}`) }),
        ...(resource.source.by === 'planner' ? {} : { source: resource.source.by }),
        ...(resource.words === undefined ? {} : { words: resource.words }),   // reads resource.words (T1)
      })),
      ...inputs.purchases.map(purchase => ({
        key: purchase.key, label: purchase.label, kind: 'purchase', for: nameOf(inputs, purchase.resource),
        price: [purchase.price.perPersonHour === undefined ? undefined : `${valueWords(purchase.price.perPersonHour, inputs.settings.currency)} per person-hour`,
          purchase.price.perPeriodUsed === undefined ? undefined : `${valueWords(purchase.price.perPeriodUsed, inputs.settings.currency)} per period used`,
          purchase.price.once === undefined ? undefined : `${valueWords(purchase.price.once, inputs.settings.currency)} once`].filter(Boolean).join(', '),
        allowed: purchase.allowed,
        ...(purchase.orderBy === undefined ? {} : { orderBy: timeWords(purchase.orderBy, zone) }),
        ...(purchase.ordered === undefined ? {} : { ordered: timeWords(purchase.ordered.at, zone) }),
      })),
    ]
    return [{ id: 'crews', title: 'Crews, tools and purchases', data: page(items, offset, budget, (shown, more) => ({ total: items.length, items: shown, ...(more === undefined ? {} : { more }) })) }]
  },
  sources: (context: SectionContext, offset: number, budget: number): Section[] => {
    const inputs = context.plan.inputs
    const zone = inputs.settings.timeZone
    const owners = new Map([...inputs.equipment, ...inputs.resources].flatMap(item => item.locator === undefined ? [] : [[item.locator, item.label] as const]))
    const items = inputs.world.facts.map(fact => ({
      item: owners.get(fact.locator) ?? fact.locator, value: `${fact.label} ${typeof fact.value === 'number' ? valueWords(fact.value, fact.unit ?? '') : String(fact.value)}`,
      basis: basisWords[fact.basis], read: timeWords(fact.at, zone),
    }))
    return [{ id: 'sources', title: 'World values', data: page(items, offset, budget, (shown, more) => ({
      simulation: inputs.settings.run === null ? 'not linked' : `linked ${timeWords(inputs.settings.run.linkedAt, zone)}`,
      read: inputs.world.refreshedAt === null ? 'not read yet' : timeWords(inputs.world.refreshedAt, zone),
      ...(context.preconditions.length === 0 ? {} : { preconditions: context.preconditions.slice(0, 4).map(check => preconditionText(check, zone)) }),
      total: items.length, items: shown, ...(more === undefined ? {} : { more }),
    })) }]
  },
  options: (context: SectionContext, offset: number, budget: number): Section[] => {
    const { plan } = context
    const items = (plan.options?.options ?? []).map(option => ({
      ...optionLine(option, context.options.get(option.key), plan.inputs),
      variant: { methods: option.variant.methods.map(method => `${nameOf(plan.inputs, method.choice)}: ${method.option}`), purchases: option.variant.purchases.map(key => nameOf(plan.inputs, key)) },
    }))
    return [{ id: 'options', title: 'Options', data: page(items, offset, budget, (shown, more) => ({
      ...(plan.options?.recommended === undefined ? {} : { recommended: plan.options.recommended }),
      certified: certifiedSizeWords(context.certifiedSize),
      total: items.length, items: shown, ...(more === undefined ? {} : { more }),
    })) }]
  },
  history: (context: SectionContext, offset: number, budget: number): Section[] => {
    const { plan } = context
    const zone = plan.inputs.settings.timeZone
    const items = [...plan.changes].reverse().map(change => ({
      revision: change.revision, at: timeWords(change.at, zone), by: change.by.name ?? change.by.kind, summary: change.summary,
      ...(change.reason === undefined ? {} : { reason: change.reason }),
      ...(change.authority === undefined ? {} : { authority: `${change.authority.name}: ${change.authority.reason}` }),
    }))
    return [{ id: 'history', title: 'Change history', data: page(items, offset, budget, (shown, more) => ({
      total: items.length + plan.droppedChanges, items: shown, ...(more === undefined ? {} : { more }),
    })) }]
  },
} as const

/** The schedule of one option: dated rows with float, paged. */
export const scheduleSection = (context: SectionContext, option: Option, offset: number, budget: number): Section[] => {
  const inputs = context.plan.inputs
  const zone = inputs.settings.timeZone
  const state = context.options.get(option.key)
  const items = [...option.rows].sort((left, right) => left.start.localeCompare(right.start) || left.job.localeCompare(right.job)).map(row => ({
    job: row.job, title: nameOf(inputs, row.job), start: timeWords(row.start, zone), finish: timeWords(row.finish, zone),
    floatHours: row.float.workingHours,
    floatTo: row.float.limitedBy.kind === 'window-end' ? 'window end' : nameOf(inputs, row.float.limitedBy.rule),
    by: [...new Set(row.uses.map(use => nameOf(inputs, use.resource)))].join(', '),
  }))
  return [{
    id: 'schedule', title: `Schedule: ${option.label}`,
    description: 'Float to the window end: logic and calendars; crews and outage limits not included.',
    data: page(items, offset, budget, (shown, more) => ({
      option: option.key, status: optionLine(option, state, inputs).words,
      total: items.length, items: shown, ...(more === undefined ? {} : { more }),
    })),
  }]
}

export type SectionName = keyof typeof sectionBuilders
export const buildSection = (name: SectionName, context: SectionContext, offset: number, budget: number): Section[] => sectionBuilders[name](context, offset, budget)
