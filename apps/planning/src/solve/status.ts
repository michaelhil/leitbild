// Status words (A4 and the adversary r2 items 2-3). Only the status schema's words; "proven optimal" at
// the goal's resolution and only when every earlier goal is proven; the gap is in the goal's unit. Every
// status shown is re-checked against the current inputs, and a stored proof is reused only when the
// option's inputs revision and formulation both equal the current ones. Prose is never built here.
import { goalResolution, statusSchema, type Certificate, type GoalWord, type PlanInputs, type Status } from '../plan/schema.ts'
import type { BoundSource } from './problem.ts'
import { goalExcess, type RawMetric } from './rank.ts'
import type { DatedRow } from './date.ts'
import { functionOf } from '../plan/readiness.ts'

type RunBasis = Extract<Status, { word: 'validated feasible' }>['run']
type GoalStatus = Extract<Status, { word: 'validated feasible' }>['goals'][number]
type Option = { readonly key: string; readonly status: Status; readonly rows: readonly DatedRow[]; readonly inputsRevision: number; readonly variant: { readonly methods: ReadonlyArray<{ choice: string; option: string }>; readonly purchases: readonly string[] } }

export interface GoalBound { readonly value: RawMetric; readonly source: BoundSource }

/** What the independent checker answers for a plan (lane K's check port). Raw metrics, no threshold. */
export interface CheckReport {
  readonly violations: ReadonlyArray<{ readonly code: string; readonly about: readonly string[] }>
  /** One raw value per goal, in the goal's unit; span-over gives one span per group in scope. */
  readonly goals: readonly RawMetric[]
}
export type CheckPlan = (plan: { readonly inputs: PlanInputs; readonly variant: Option['variant']; readonly rows: readonly DatedRow[] }) => CheckReport

/**
 * Lane K's certificate re-verification. A refusal is "proven infeasible" only when it `proves`: no problem
 * found and nothing left unverified. Required wherever a proof is stored or shown (adversary fix 6).
 */
export type VerifyCertificate = (inputs: PlanInputs, variant: Option['variant'], cause: Certificate) => { readonly proves: boolean }

/**
 * Checker findings that come from the inputs, not from a schedule: lane K's input codes and the readiness
 * blockers (a precondition not read from World, or not met at read time). They make an option "invalid
 * input" with the finding as its cause, never "unresolved".
 */
export const INPUT_VIOLATIONS: ReadonlySet<string> = new Set([
  'no-window', 'window-off-grid', 'calendar-needs-zone', 'calendar-off-grid', 'unknown-key', 'method-choice', 'support-cycle',
  'bracket-missing', 'equipment-missing', 'world-value-unread', 'below-minimum', 'duration-ambiguous', 'no-working-calendar', 'where-unit',
  'precondition-unread', 'precondition-unmet',
])
/** The input findings of a check, as status problems; empty when none. */
export const inputProblems = (violations: CheckReport['violations']): Array<{ about: string[]; code: string }> =>
  violations.filter(violation => INPUT_VIOLATIONS.has(violation.code)).map(violation => ({ about: violation.about.slice(0, 4), code: violation.code }))

/**
 * Goal words in order. A goal is "proven optimal" when its value equals its bound at the goal's
 * resolution and every earlier goal is proven; otherwise "best found under budget", with the bound
 * when it is a valid lower bound. A bound above the value is not shown (and is reported in `conflicts`).
 */
export const goalStatuses = (goals: PlanInputs['goals'], grid: PlanInputs['settings']['grid'], raw: readonly RawMetric[], bounds: readonly GoalBound[] | undefined) => {
  const conflicts: number[] = []
  let provenSoFar = true
  const statuses: GoalStatus[] = goals.map((goal, k) => {
    const unit = goal.tolerance.unit
    const threshold = goal.threshold === undefined ? 0 : goal.threshold.value
    const value = goalExcess(raw[k] ?? 0, threshold)
    const resolution = goalResolution(unit, grid)
    if (resolution === undefined) throw new RangeError(`No resolution for the goal unit ${unit}`)
    const bound = bounds?.[k]
    const boundValue = bound === undefined ? undefined : goalExcess(bound.value, threshold)
    if (bound === undefined || boundValue === undefined) { provenSoFar = false; return { word: 'best found under budget', goal: k, value, unit } }
    if (boundValue - value >= resolution / 2) { conflicts.push(k); provenSoFar = false; return { word: 'best found under budget', goal: k, value, unit } }
    const word: GoalWord = provenSoFar && Math.abs(value - boundValue) < resolution / 2 ? 'proven optimal' : 'best found under budget'
    if (word !== 'proven optimal') provenSoFar = false
    return { word, goal: k, value, unit, bound: { value: boundValue, source: bound.source } }
  })
  return { goals: statuses, conflicts }
}

/** The gap of a goal in its unit (value minus bound), when a bound is known. */
export const goalGap = (goal: GoalStatus): number | undefined => (goal.bound === undefined ? undefined : Math.max(0, goal.value - goal.bound.value))

const parse = (status: Status): Status => statusSchema.parse(status)

export const feasibleStatus = (goals: PlanInputs['goals'], run: RunBasis, raw: readonly RawMetric[], bounds: readonly GoalBound[] | undefined) => {
  const words = goalStatuses(goals, run.grid, raw, bounds)
  return { status: parse({ word: 'validated feasible', goals: words.goals, run }), conflicts: words.conflicts }
}
export const infeasibleStatus = (cause: Certificate, run: RunBasis): Status => parse({ word: 'proven infeasible', cause, run })
export const unresolvedStatus = (run: RunBasis, attempt?: { job: string; wouldFinish: string; pastWindowHours: number }): Status =>
  parse({ word: 'unresolved', run, ...(attempt === undefined ? {} : { attempt }) })
export const cancelledStatus = (run: RunBasis): Status => parse({ word: 'cancelled', run })
export const refusedStatus = (word: 'invalid input' | 'unsupported feature', problems: ReadonlyArray<{ about: readonly string[]; code: string }>): Status =>
  parse({ word, problems: problems.slice(0, 16).map(problem => ({ about: problem.about.slice(0, 4), code: problem.code })) })

/** A status is a proof claim when it says proven infeasible or proves a goal optimal. */
export const claimsProof = (status: Status): boolean =>
  status.word === 'proven infeasible' || (status.word === 'validated feasible' && status.goals.some(goal => goal.word === 'proven optimal'))

/** Removes proof words: proven goals become best found without their bound; a refusal becomes "unresolved". */
export const withoutProof = (status: Status): Status => {
  if (status.word === 'validated feasible') {
    return parse({ ...status, goals: status.goals.map(goal => (goal.word === 'proven optimal' ? { word: 'best found under budget' as const, goal: goal.goal, value: goal.value, unit: goal.unit } : goal)) })
  }
  if (status.word === 'proven infeasible') return parse({ word: 'unresolved', run: status.run })
  return status
}

export interface RedundancyWarning {
  readonly code: 'redundancy_unruled'
  /** Items out at the same time, none named by a keep-in-service or protected rule. */
  readonly items: readonly string[]
  readonly from: string
  readonly to: string
}

/**
 * Items of one function taken out together with no keep-in-service or protected rule naming any of them
 * (adversary r2 item 7; the same rule as lane P's outTogether, keyed on lane A's equipment function).
 */
export const redundancyWarning = (inputs: PlanInputs, rows: readonly DatedRow[]): RedundancyWarning | undefined => {
  const ruled = new Set(inputs.rules.flatMap(rule => (rule.kind === 'protected' ? rule.equipment : rule.kind === 'keep-in-service' ? rule.members.flatMap(member => ('equipment' in member ? [member.equipment] : [])) : [])))
  const row = new Map(rows.map(entry => [entry.job, entry]))
  const ownOut = (item: string): Array<[number, number]> => {
    const tags = inputs.jobs.filter(job => job.kind === 'tag-out' && job.equipment.includes(item) && row.has(job.key)).map(job => Date.parse(row.get(job.key)!.start))
    if (tags.length === 0) return []
    const tests = inputs.jobs.filter(job => job.kind === 'test' && job.equipment.includes(item) && row.has(job.key)).map(job => Date.parse(row.get(job.key)!.finish))
    return [[Math.min(...tags), tests.length === 0 ? Infinity : Math.max(...tests)]]
  }
  const out = (item: string, seen = new Set<string>()): Array<[number, number]> => {
    const equipment = inputs.equipment.find(entry => entry.key === item)
    const supporters = (equipment?.supportedBy ?? []).filter(key => !seen.has(key))
    for (const key of supporters) seen.add(key)
    return [...ownOut(item), ...supporters.flatMap(key => out(key, seen))]
  }
  const intervals = inputs.equipment.map(item => ({ item: item.key, spans: out(item.key, new Set([item.key])) })).filter(entry => entry.spans.length > 0)
  // Redundant = items that share an equipment function key (they back each other up); one train's series
  // chain shares none. Only unruled items count: a ruled item is the planner's statement that its backup
  // is covered. With no function keys in the plan, it never warns.
  const functions = new Map(inputs.equipment.flatMap(item => { const key = functionOf(item); return key === undefined ? [] : [[item.key, key] as const] }))
  const unruled = intervals.filter(entry => !ruled.has(entry.item) && functions.has(entry.item))
  const points = [...new Set(unruled.flatMap(entry => entry.spans.map(span => span[0])))].sort((a, b) => a - b)
  let best: { items: string[]; from: number; to: number } | undefined
  for (const at of points) {
    const out = unruled.filter(entry => entry.spans.some(([from, to]) => from <= at && at < to))
    const byFunction = new Map<string, typeof out>()
    for (const entry of out) byFunction.set(functions.get(entry.item)!, [...(byFunction.get(functions.get(entry.item)!) ?? []), entry])
    const items = [...byFunction.values()].reduce<typeof out>((most, group) => (group.length > most.length ? group : most), [])
    if (items.length < 2 || (best !== undefined && items.length <= best.items.length)) continue
    const to = Math.min(...items.flatMap(entry => entry.spans.filter(([from, end]) => from <= at && at < end).map(span => span[1])))
    best = { items: items.map(entry => entry.item), from: at, to }
  }
  if (best === undefined || !Number.isFinite(best.to)) return undefined
  return { code: 'redundancy_unruled', items: best.items.slice(0, 32), from: new Date(best.from).toISOString(), to: new Date(best.to).toISOString() }
}

export interface ShownStatus {
  readonly status: Status
  /** Why proofs or feasibility were withdrawn for display; undefined when the stored status stands. */
  readonly stale?: { readonly codes: ReadonlyArray<'inputs_changed' | 'formulation_changed' | 'violations' | 'invalid_input' | 'certificate_rejected'>; readonly violations?: CheckReport['violations'] }
  readonly warnings: readonly RedundancyWarning[]
}

/**
 * The status to show for a stored option, re-checked against the current inputs: proofs only on an
 * exact inputs revision and formulation; a feasible plan re-checked by the checker every time (an input
 * finding makes it "invalid input"); an infeasibility certificate re-verified by lane K every time.
 */
export const showStatus = (option: Option, current: { readonly inputs: PlanInputs; readonly revision: number; readonly formulation: string }, check: CheckPlan, verify: VerifyCertificate): ShownStatus => {
  const codes: Array<NonNullable<ShownStatus['stale']>['codes'][number]> = []
  let status = option.status
  if (option.inputsRevision !== current.revision) codes.push('inputs_changed')
  const run = 'run' in status ? status.run : undefined
  if (run !== undefined && run.formulation !== current.formulation) codes.push('formulation_changed')
  if (codes.length > 0) status = withoutProof(status)
  let violations: CheckReport['violations'] | undefined
  if (status.word === 'validated feasible') {
    const report = check({ inputs: current.inputs, variant: option.variant, rows: option.rows })
    if (report.violations.length > 0) {
      violations = report.violations
      const problems = inputProblems(report.violations)
      codes.push(problems.length > 0 ? 'invalid_input' : 'violations')
      status = problems.length > 0 ? refusedStatus('invalid input', problems) : unresolvedStatus(status.run)
    }
  }
  if (status.word === 'proven infeasible' && !verify(current.inputs, option.variant, status.cause).proves) {
    codes.push('certificate_rejected')
    status = withoutProof(status)
  }
  const warning = status.word === 'validated feasible' ? redundancyWarning(current.inputs, option.rows) : undefined
  return {
    status,
    ...(codes.length === 0 ? {} : { stale: { codes, ...(violations === undefined ? {} : { violations }) } }),
    warnings: warning === undefined ? [] : [warning],
  }
}
