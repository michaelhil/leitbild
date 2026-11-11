// What a plan still needs before it can be trusted (T2): warnings and not-ready items, never a score.
// Items are structure; summary.ts words them. `blocks` marks what makes Generate answer "invalid input".
import type { PlanningFactBasis } from '@leitbild/contracts'
import { combineWorldFacts, type Plan, type PlanInputs, type WorldFactCopy, type WorldRef } from './schema.ts'
import { belowMinimum } from './edits.ts'

type Inputs = PlanInputs
type Option = NonNullable<Plan['options']>['options'][number]

export type ReadinessKind = 'not-ready' | 'warning' | 'world' | 'decision' | 'stale'
export type ReadinessCode =
  | 'link-run' | 'world-unread' | 'world-unusable' | 'world-duration'
  | 'no-crew' | 'no-tag-out' | 'no-test' | 'not-returned'
  | 'precondition-unmet' | 'precondition-unread' | 'below-minimum'
  | 'order-by' | 'order-passed' | 'assumption' | 'redundancy' | 'options-stale'

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
  readonly unit?: string
}

const order: Readonly<Record<ReadinessCode, number>> = {
  // Out-of-date options come right after the link card: every status shown depends on them.
  'link-run': 0, 'options-stale': 1, 'world-unread': 2, 'world-unusable': 2, 'below-minimum': 2, 'no-tag-out': 3, 'no-test': 3, 'not-returned': 4,
  'precondition-unmet': 5, 'precondition-unread': 5, 'order-passed': 6, 'order-by': 7, 'no-crew': 8,
  'assumption': 9, 'redundancy': 10, 'world-duration': 11,
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

/** Equipment a plan takes out of service: what its tag-outs isolate. */
export const takenOut = (inputs: Inputs): readonly string[] =>
  [...new Set(inputs.jobs.filter(job => job.kind === 'tag-out').flatMap(job => job.equipment))]

const ruleNamed = (inputs: Inputs): ReadonlySet<string> => new Set(inputs.rules.flatMap(rule =>
  rule.kind === 'protected' ? rule.equipment : rule.kind === 'keep-in-service' ? rule.members.flatMap(member => 'equipment' in member ? [member.equipment] : []) : []))

/** Two or more items taken out and no keep-in-service or protected rule names any of them (A3). */
const redundancy = (inputs: Inputs): ReadinessItem | undefined => {
  const out = takenOut(inputs)
  const named = ruleNamed(inputs)
  if (out.length < 2 || out.some(key => named.has(key))) return undefined
  return { kind: 'warning', code: 'redundancy', about: out.slice(0, 4), blocks: false, count: out.length }
}

const sourced = (inputs: Inputs): ReadinessItem[] => {
  const items: ReadinessItem[] = []
  const assumption = (about: string[], words?: string, at?: string): void => {
    items.push({ kind: 'warning', code: 'assumption', about, blocks: false, ...(words === undefined ? {} : { words }), ...(at === undefined ? {} : { at }) })
  }
  for (const job of inputs.jobs) {
    if (job.notBefore?.source.by === 'assumption') assumption([job.key], job.notBefore.source.note ?? job.notBefore.words, job.notBefore.at)
    if (job.duration.origin.by === 'assumption') assumption([job.key], job.duration.origin.note)
    for (const entry of job.durationWith) if (entry.source?.by === 'assumption') assumption([job.key, entry.resource], entry.source.note)
  }
  for (const calendar of inputs.calendars) if (calendar.source.by === 'assumption') assumption([calendar.key], calendar.source.note)
  for (const resource of inputs.resources) {
    if (resource.source.by === 'assumption') assumption([resource.key], resource.source.note)
    for (const attribute of resource.attributes) if (attribute.origin.by === 'assumption') assumption([resource.key, attribute.key], attribute.origin.note)
  }
  for (const rule of inputs.rules) if (rule.source.by === 'assumption') assumption([rule.key], rule.source.note)
  return items
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
    if (combined.ok) items.push({ kind: 'warning', code: 'world-duration', about: [job.key], blocks: false, label: first?.label ?? job.duration.origin.refs[0]!.fact, basis: combined.basis, at: combined.at })
  }
  // A World value can put a test under its declared minimum without anyone editing: Generate waits for a person.
  for (const key of belowMinimum(inputs, 'world')) items.push({ kind: 'not-ready', code: 'below-minimum', about: [key], blocks: true })
  for (const job of inputs.jobs) if (job.needs.length === 0) items.push({ kind: 'warning', code: 'no-crew', about: [job.key], blocks: false })
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
  items.push(...sourced(inputs))
  const warning = redundancy(inputs)
  if (warning !== undefined) items.push(warning)
  if (context.staleOptions.length > 0) items.push({ kind: 'stale', code: 'options-stale', about: context.staleOptions.slice(0, 4), blocks: false, count: context.staleOptions.length })
  return items.map((item, at) => ({ item, at })).sort((left, right) => order[left.item.code] - order[right.item.code] || left.at - right.at).map(entry => entry.item)
}

// ───────────── the redundancy warning on an option (adversary item 7) ─────────────
// summary.ts words it into the option's `warnings` (api/contract.ts optionWarningSchema).

export interface OutTogether {
  readonly kind: 'redundancy'
  /** Items out of service together in this option with no keep-in-service or protected rule naming any of them. */
  readonly about: readonly string[]
  readonly from: string
  readonly to: string
}

/**
 * Items this option takes out at the same time when no keep-in-service or protected rule names any of
 * them. An item is out from its first tag-out start to its last test finish, and while any supporter is
 * out. The status may stay "validated feasible"; the warning is shown beside it.
 */
export const outTogether = (inputs: Inputs, option: Option): readonly OutTogether[] => {
  const rows = new Map(option.rows.map(row => [row.job, row]))
  const jobs = new Map(inputs.jobs.map(job => [job.key, job]))
  // An item never tested again stays out to the window end (or the option's last finish without a window).
  const windowEnd = inputs.settings.window === null ? Math.max(...option.rows.map(row => Date.parse(row.finish))) : Date.parse(inputs.settings.window.end)
  const own = new Map<string, { from: number; to: number }>()
  for (const item of inputs.equipment) {
    const tagged = option.rows.filter(row => jobs.get(row.job)?.kind === 'tag-out' && jobs.get(row.job)!.equipment.includes(item.key))
    if (tagged.length === 0) continue
    const tested = option.rows.filter(row => jobs.get(row.job)?.kind === 'test' && jobs.get(row.job)!.equipment.includes(item.key))
    own.set(item.key, {
      from: Math.min(...tagged.map(row => Date.parse(row.start))),
      to: tested.length === 0 ? windowEnd : Math.max(...tested.map(row => Date.parse(row.finish))),
    })
  }
  if (rows.size === 0 || own.size === 0) return []
  const supporters = new Map(inputs.equipment.map(item => [item.key, item.supportedBy]))
  const outIntervals = (key: string, seen: ReadonlySet<string> = new Set()): ReadonlyArray<{ from: number; to: number }> => {
    if (seen.has(key)) return []
    const next = new Set([...seen, key])
    return [...(own.has(key) ? [own.get(key)!] : []), ...(supporters.get(key) ?? []).flatMap(supporter => outIntervals(supporter, next))]
  }
  const named = ruleNamed(inputs)
  const candidates = inputs.equipment.map(item => item.key).filter(key => !named.has(key)).map(key => ({ key, intervals: outIntervals(key) })).filter(entry => entry.intervals.length > 0)
  if (candidates.length < 2 || [...own.keys()].some(key => named.has(key))) return []
  let together: { readonly keys: string[]; readonly from: number; readonly to: number } | undefined
  for (const [index, left] of candidates.entries()) for (const right of candidates.slice(index + 1)) {
    for (const a of left.intervals) for (const b of right.intervals) {
      const from = Math.max(a.from, b.from), to = Math.min(a.to, b.to)
      if (from >= to) continue
      if (together === undefined) together = { keys: [left.key, right.key], from, to }
      else if (from < together.to && to > together.from) {
        for (const key of [left.key, right.key]) if (!together.keys.includes(key)) together.keys.push(key)
        together = { keys: together.keys, from: Math.max(together.from, from), to: Math.min(together.to, to) }
      }
    }
  }
  if (together === undefined) return []
  return [{ kind: 'redundancy', about: together.keys.slice(0, 8), from: new Date(together.from).toISOString(), to: new Date(together.to).toISOString() }]
}
