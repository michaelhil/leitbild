// What a plan still needs before it can be trusted (T2): warnings and not-ready items, never a score.
// Items are structure; summary.ts words them. `blocks` marks what makes Generate answer "invalid input".
import type { PlanningFactBasis } from '@leitbild/contracts'
import { combineWorldFacts, type Plan, type PlanInputs, type WorldFactCopy, type WorldRef } from './schema.ts'
import { belowMinimum, effectiveDurations } from './edits.ts'
import { gridSlotMs } from '../time/units.ts'
import { redundancyWarning, redundantItems } from '../solve/status.ts'

type Inputs = PlanInputs
type Option = NonNullable<Plan['options']>['options'][number]

export type ReadinessKind = 'not-ready' | 'warning' | 'world' | 'decision' | 'stale'
export type ReadinessCode =
  | 'link-run' | 'world-unread' | 'world-unusable' | 'world-duration'
  | 'no-crew' | 'no-tag-out' | 'no-test' | 'not-returned'
  | 'precondition-unmet' | 'precondition-unread' | 'below-minimum'
  | 'order-by' | 'order-passed' | 'assumption' | 'assumptions' | 'redundancy' | 'rounded' | 'options-stale'

export interface ReadinessItem {
  readonly kind: ReadinessKind
  readonly code: ReadinessCode
  /** Plan-local keys, most specific first. */
  readonly about: readonly string[]
  readonly blocks: boolean
  readonly label?: string
  readonly basis?: PlanningFactBasis
  /** A World read time, an order deadline or a promised time. */
  readonly at?: string
  readonly words?: string
  readonly count?: number
  /** assumptions: durations taken from World values that stand in for the work (proxies), grouped here. */
  readonly proxies?: number
  readonly unit?: string
  /** rounded: each duration that does not fit the time step, before and after rounding up. */
  readonly durations?: ReadonlyArray<{ readonly job: string; readonly resource?: string; readonly fromMs: number; readonly toMs: number }>
}

const order: Readonly<Record<ReadinessCode, number>> = {
  // Out-of-date options come right after the link card: every status shown depends on them.
  'link-run': 0, 'options-stale': 1, 'world-unread': 2, 'world-unusable': 2, 'below-minimum': 2, 'no-tag-out': 3, 'no-test': 3, 'not-returned': 4,
  'precondition-unmet': 5, 'precondition-unread': 5, 'order-passed': 6, 'order-by': 7, 'no-crew': 8,
  'assumption': 9, 'redundancy': 10, 'assumptions': 11, 'world-duration': 12, 'rounded': 13,
}

/** Every World reference a plan holds, with the plan item that holds it. */
export const worldRefs = (inputs: Inputs): ReadonlyArray<{ readonly owner: string; readonly ref: WorldRef }> => [
  ...inputs.jobs.flatMap(job => [
    ...(job.duration.origin.by === 'world' ? job.duration.origin.refs : []),
    ...job.durationWith.flatMap(entry => 'refs' in entry ? entry.refs : []),
  ].map(ref => ({ owner: job.key, ref }))),
  ...inputs.resources.flatMap(resource => resource.attributes.flatMap(attribute => attribute.origin.by === 'world' ? attribute.origin.refs : []).map(ref => ({ owner: resource.key, ref }))),
]

/** The World items a refresh reads: every locator the plan stores, and every locator its references name. */
export const worldSubjects = (inputs: Inputs): readonly string[] => [...new Set([
  ...inputs.equipment.flatMap(item => item.locator === undefined ? [] : [item.locator]),
  ...inputs.resources.flatMap(resource => resource.locator === undefined ? [] : [resource.locator]),
  ...inputs.jobs.flatMap(job => job.locator === undefined ? [] : [job.locator]),
  ...worldRefs(inputs).map(entry => entry.ref.locator),
])].sort()

export type PreconditionState = 'met' | 'unmet' | 'unread'
export interface Precondition {
  readonly job: string
  readonly equipment: string
  readonly words: string
  readonly state: PreconditionState
  readonly at?: string
  readonly value?: WorldFactCopy['value']
}

/** Job preconditions evaluated against the World copies, "at read time". */
export const preconditions = (inputs: Inputs): readonly Precondition[] => inputs.jobs.flatMap(job => job.checks.map(check => {
  const locator = inputs.equipment.find(item => item.key === check.equipment)?.locator
  const fact = locator === undefined ? undefined : inputs.world.facts.find(entry => entry.locator === locator && entry.id === check.fact)
  if (fact === undefined) return { job: job.key, equipment: check.equipment, words: check.words, state: 'unread' as const }
  return { job: job.key, equipment: check.equipment, words: check.words, state: fact.value === check.expect ? 'met' as const : 'unmet' as const, at: fact.at, value: fact.value }
}))

/**
 * Durations that do not fit the plan's time step: the solver rounds each up to the next step (design D9).
 * Every duration a job may run with counts: its own and each crew- or tool-specific one, World values once read.
 */
export const roundedDurations = (inputs: Inputs): NonNullable<ReadinessItem['durations']> => {
  const step = gridSlotMs[inputs.settings.grid]
  return inputs.jobs.flatMap(job => effectiveDurations(inputs, job)
    .filter(duration => Math.abs(duration.ms / step - Math.round(duration.ms / step)) > 1e-9)
    .map(duration => {
      const resource = duration.path.startsWith('durationWith ') ? duration.path.slice('durationWith '.length) : undefined
      return { job: job.key, ...(resource === undefined ? {} : { resource }), fromMs: duration.ms, toMs: Math.ceil(duration.ms / step - 1e-9) * step }
    }))
}

/** Equipment a plan takes out of service: what its tag-outs isolate. */
export const takenOut = (inputs: Inputs): readonly string[] =>
  [...new Set(inputs.jobs.filter(job => job.kind === 'tag-out').flatMap(job => job.equipment))]

/** On the plan: redundant items it takes out with no rule keeping one in service. */
const redundancy = (inputs: Inputs): ReadinessItem | undefined => {
  const items = redundantItems(inputs, takenOut(inputs))
  return items === undefined ? undefined : { kind: 'warning', code: 'redundancy', about: items.slice(0, 4), blocks: false, count: items.length }
}

/** On an option: lane S's redundancy rule (solve/status.ts), the Module's one rule, in this file's shape. */
export const outTogether = (inputs: Inputs, rows: ReadonlyArray<{ readonly job: string; readonly start: string; readonly finish: string }>): OutTogether | undefined => {
  const warning = redundancyWarning(inputs, rows)
  return warning === undefined ? undefined : { kind: 'redundancy', about: warning.items, from: warning.from, to: warning.to }
}

/**
 * A promised release (a vendor's date) is its own card: it is scheduled at that time and flagged. Every
 * other value given as an assumption counts toward one card, so assumptions do not flood the column.
 */
const sourced = (inputs: Inputs): ReadinessItem[] => {
  const items: ReadinessItem[] = []
  const owners: string[] = []
  for (const job of inputs.jobs) {
    if (job.notBefore?.source.by === 'assumption') {
      items.push({ kind: 'warning', code: 'assumption', about: [job.key], blocks: false, words: job.notBefore.source.note ?? job.notBefore.words, at: job.notBefore.at })
    }
    if (job.duration.origin.by === 'assumption') owners.push(job.key)
    for (const entry of job.durationWith) if (entry.source?.by === 'assumption') owners.push(job.key)
  }
  for (const calendar of inputs.calendars) if (calendar.source.by === 'assumption') owners.push(calendar.key)
  for (const resource of inputs.resources) {
    if (resource.source.by === 'assumption') owners.push(resource.key)
    for (const attribute of resource.attributes) if (attribute.origin.by === 'assumption') owners.push(resource.key)
  }
  for (const rule of inputs.rules) if (rule.source.by === 'assumption') owners.push(rule.key)
  const distinct = [...new Set(owners)]
  if (owners.length > 0) items.push({ kind: 'warning', code: 'assumptions', about: distinct.slice(0, 4), blocks: false, count: owners.length })
  return items
}

/** Several World stand-in durations are one card with the assumptions: review them together. */
const groupProxies = (assumed: readonly ReadinessItem[], proxies: readonly ReadinessItem[]): readonly ReadinessItem[] => {
  if (proxies.length < 2) return assumed
  const card = assumed.find(item => item.code === 'assumptions')
  const about = [...new Set([...(card?.about ?? []), ...proxies.flatMap(item => item.about)])].slice(0, 4)
  const grouped: ReadinessItem = { kind: 'warning', code: 'assumptions', about, blocks: false, count: card?.count ?? 0, proxies: proxies.length }
  return [...assumed.filter(item => item !== card), grouped]
}

/**
 * The readiness items of a plan, most urgent first. `staleOptions` are the option keys whose proofs no
 * longer apply (the caller re-checks them); `now` stands in for the data date when the plan has none.
 */
export const readiness = (plan: Plan, context: { readonly staleOptions: readonly string[]; readonly now: string }): readonly ReadinessItem[] => {
  const inputs = plan.inputs
  const items: ReadinessItem[] = []
  const refs = worldRefs(inputs)
  const located = inputs.equipment.some(item => item.locator !== undefined) || inputs.resources.some(resource => resource.locator !== undefined)
  if (inputs.settings.run === null && (refs.length > 0 || located || inputs.settings.scenario !== undefined)) {
    items.push({ kind: 'world', code: 'link-run', about: [], blocks: false, ...(inputs.settings.scenario === undefined ? {} : { label: inputs.settings.scenario.title }) })
  }
  const unread = new Map<string, string[]>()
  const proxies: ReadinessItem[] = []
  const unusable = new Map<string, { unit?: string }>()
  for (const { owner, ref } of refs) {
    const unit = inputs.jobs.find(job => job.key === owner)?.duration.unit ?? inputs.resources.find(resource => resource.key === owner)?.attributes.find(attribute => attribute.origin.by === 'world' && attribute.origin.refs.includes(ref))?.unit
    const combined = unit === undefined ? undefined : combineWorldFacts([ref], inputs.world.facts, unit)
    if (combined === undefined || combined.ok) continue
    if (combined.code === 'world_value_unread') unread.set(owner, [...(unread.get(owner) ?? []), ref.fact])
    else unusable.set(owner, combined.unit === undefined ? {} : { unit: combined.unit })
  }
  for (const [owner, facts] of unread) items.push({ kind: 'not-ready', code: 'world-unread', about: [owner], blocks: true, count: facts.length })
  for (const [owner, detail] of unusable) items.push({ kind: 'not-ready', code: 'world-unusable', about: [owner], blocks: true, ...detail })
  for (const job of inputs.jobs) {
    if (job.duration.origin.by !== 'world') continue
    const combined = combineWorldFacts(job.duration.origin.refs, inputs.world.facts, job.duration.unit)
    const ref = job.duration.origin.refs[0]!
    const first = inputs.world.facts.find(fact => fact.locator === ref.locator && fact.id === ref.fact)
    if (combined.ok) proxies.push({ kind: 'warning', code: 'world-duration', about: [job.key], blocks: false, label: first?.label ?? job.duration.origin.refs[0]!.fact, basis: combined.basis, at: combined.at })
  }
  // One stand-in alone keeps its own card, with its source in words; several join the assumptions card (walk 2, R2-10).
  if (proxies.length === 1) items.push(proxies[0]!)
  // A World value can put a test under its declared minimum without anyone editing: Generate waits for a person.
  for (const key of belowMinimum(inputs, 'world')) items.push({ kind: 'not-ready', code: 'below-minimum', about: [key], blocks: true })
  // Working time needs someone to work it: Generate refuses such a job, so the item blocks and says what to add.
  for (const job of inputs.jobs) {
    if (job.needs.length > 0) continue
    const working = job.duration.calendar === 'working'
    items.push({ kind: working ? 'not-ready' : 'warning', code: 'no-crew', about: [job.key], blocks: working, ...(plan.drafts?.includes(job.key) === true ? { words: 'drafted' } : {}) })
  }
  for (const item of inputs.equipment) {
    const inside = inputs.jobs.filter(job => job.kind === 'work' && job.isolation === 'inside' && job.equipment.includes(item.key))
    const tagOuts = inputs.jobs.filter(job => job.kind === 'tag-out' && job.equipment.includes(item.key))
    const tests = inputs.jobs.filter(job => job.kind === 'test' && job.equipment.includes(item.key))
    if (inside.length > 0 && tagOuts.length === 0) items.push({ kind: 'not-ready', code: 'no-tag-out', about: [item.key, ...inside.map(job => job.key)].slice(0, 4), blocks: true })
    if (inside.length > 0 && tests.length === 0) items.push({ kind: 'not-ready', code: 'no-test', about: [item.key, ...inside.map(job => job.key)].slice(0, 4), blocks: true })
    else if (inside.length === 0 && tagOuts.length > 0 && tests.length === 0) items.push({ kind: 'not-ready', code: 'not-returned', about: [item.key], blocks: false })
  }
  for (const check of preconditions(inputs)) {
    if (check.state === 'met') continue
    items.push({ kind: 'not-ready', code: check.state === 'unmet' ? 'precondition-unmet' : 'precondition-unread', about: [check.job, check.equipment], blocks: false, words: check.words, ...(check.at === undefined ? {} : { at: check.at }) })
  }
  const dataDate = Date.parse(inputs.settings.dataDate ?? context.now)
  for (const purchase of inputs.purchases) {
    if (purchase.orderBy === undefined || purchase.ordered !== undefined) continue
    items.push(Date.parse(purchase.orderBy) < dataDate
      ? { kind: 'warning', code: 'order-passed', about: [purchase.key], blocks: false, at: purchase.orderBy }
      : { kind: 'decision', code: 'order-by', about: [purchase.key], blocks: false, at: purchase.orderBy })
  }
  items.push(...groupProxies(sourced(inputs), proxies))
  const rounded = roundedDurations(inputs)
  if (rounded.length > 0) items.push({ kind: 'warning', code: 'rounded', about: [...new Set(rounded.map(entry => entry.job))].slice(0, 4), blocks: false, count: rounded.length, durations: rounded })
  const warning = redundancy(inputs)
  if (warning !== undefined) items.push(warning)
  if (context.staleOptions.length > 0) items.push({ kind: 'stale', code: 'options-stale', about: context.staleOptions.slice(0, 4), blocks: false, count: context.staleOptions.length })
  return items.map((item, at) => ({ item, at })).sort((left, right) => order[left.item.code] - order[right.item.code] || left.at - right.at).map(entry => entry.item)
}

// ───────────── the redundancy warning on an option (adversary item 7) ─────────────
// Lane S's redundancyWarning (solve/status.ts) finds it from an option's rows at display time; summary.ts
// words it into the option's `warnings` (api/contract.ts optionWarningSchema).

export interface OutTogether {
  readonly kind: 'redundancy'
  /** Items out of service together in this option with no keep-in-service or protected rule naming any of them. */
  readonly about: readonly string[]
  readonly from: string
  readonly to: string
}
