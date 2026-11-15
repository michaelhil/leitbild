// Status words (A4 and the adversary r2 items 2-3). Only the status schema's words; "proven optimal" at
// the goal's resolution and only when every earlier goal is proven (in a what-if with a lead: only the lead,
// adversary part 2 check, fixes B and C); the gap is in the goal's unit. Every
// status shown is re-checked against the current inputs, and a stored proof is reused only when the
// option's inputs revision and formulation both equal the current ones. Prose is never built here.
import { goalResolution, statusSchema, type BoundCertificate, type Certificate, type GoalWord, type PlanInputs, type Status } from '../plan/schema.ts'
import type { BoundSource } from './problem.ts'
import { goalExcess, type RawMetric } from './rank.ts'
import type { DatedRow } from './date.ts'

type RunBasis = Extract<Status, { word: 'validated feasible' }>['run']
type GoalStatus = Extract<Status, { word: 'validated feasible' }>['goals'][number]
type Option = { readonly key: string; readonly status: Status; readonly rows: readonly DatedRow[]; readonly inputsRevision: number; readonly variant: { readonly methods: ReadonlyArray<{ choice: string; option: string }>; readonly purchases: readonly string[] } }

/** A goal's lower bound from bounds.ts: raw value, source, and its derivation in plan terms. */
export interface GoalBound { readonly value: RawMetric; readonly source: BoundSource; readonly certificate?: BoundCertificate }

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
 * Lane K's re-derivation of a "proven optimal" goal's bound (check/optimal.ts verifyBound): it `proves` when
 * lane K's own lower bound, from the inputs, reaches `bound.value` (net of the threshold, in the goal's
 * unit) at the goal's resolution. It does not read the certificate. Required wherever such a claim is stored.
 */
export type VerifyBound = (inputs: PlanInputs, variant: Option['variant'], goal: number, bound: { readonly value: number }) => { readonly proves: boolean }

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
    // The bound's derivation: at 0 no goal can be lower; else bounds.ts's record. None, no proof.
    const certificate: BoundCertificate | undefined = Math.abs(boundValue) < resolution / 2 ? { kind: 'zero' } : bound.certificate
    if (provenSoFar && certificate !== undefined && Math.abs(value - boundValue) < resolution / 2) return { word: 'proven optimal', goal: k, value, unit, bound: { value: boundValue, source: bound.source, certificate } }
    provenSoFar = false
    return { word: 'best found under budget', goal: k, value, unit, bound: { value: boundValue, source: bound.source, ...(certificate === undefined ? {} : { certificate }) } }
  })
  return { goals: statuses, conflicts }
}

type LeadLine = Extract<NonNullable<Extract<Status, { word: 'validated feasible' }>['lead']>, { word: string }>
const unproven = (goal: GoalStatus, keepBound: boolean): GoalStatus =>
  ({ word: 'best found under budget', goal: goal.goal, value: goal.value, unit: goal.unit, ...(keepBound && goal.bound !== undefined ? { bound: goal.bound } : {}) })
const unprovenLead = (lead: LeadLine): LeadLine => ({ word: 'best found under budget', group: lead.group, value: lead.value, unit: lead.unit })

/**
 * Every "proven optimal" goal re-derived by lane K: the first one it does not prove, and every later goal
 * (goal order), becomes "best found under budget". A bound lane K does not prove is dropped: not a fact.
 * With a what-if's lead the lead rule replaces goal order (adversary part 2 check, fix C): only the lead may
 * stay proven, a plan goal through `verify`, a group's own line through `verifyLead` (lane K's bound on the
 * lead's own goal, the first of the list it was solved with). Without `verifyLead` a group lead is not proven.
 */
export const verifiedGoals = (status: Status, verify: (goal: number, bound: { readonly value: number }) => { readonly proves: boolean }, verifyLead?: (bound: { readonly value: number }) => { readonly proves: boolean }): Status => {
  if (status.word !== 'validated feasible') return status
  const lead = status.lead
  if (lead !== undefined) {
    const goals = status.goals.map((goal): GoalStatus => {
      if (goal.word !== 'proven optimal') return goal
      return 'goal' in lead && lead.goal === goal.goal && verify(goal.goal, goal.bound).proves ? goal : unproven(goal, false)
    })
    const line = 'group' in lead && lead.word === 'proven optimal' && verifyLead?.(lead.bound).proves !== true ? unprovenLead(lead) : lead
    return parse({ ...status, goals, lead: line })
  }
  let broken = false
  const goals = status.goals.map((goal): GoalStatus => {
    if (goal.word !== 'proven optimal') { broken = true; return goal }
    const proves = verify(goal.goal, goal.bound).proves
    if (proves && !broken) return goal
    broken = true
    // Best found: a bound lane K re-derived stays (a fact); one it did not is dropped.
    return { word: 'best found under budget', goal: goal.goal, value: goal.value, unit: goal.unit, ...(proves ? { bound: goal.bound } : {}) }
  })
  return parse({ ...status, goals })
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

/** A group lead's own line says "proven optimal" (a goal lead's word is in its goal line). */
const leadProven = (status: Extract<Status, { word: 'validated feasible' }>): boolean =>
  status.lead !== undefined && 'group' in status.lead && status.lead.word === 'proven optimal'

/** A status is a proof claim when it says proven infeasible or proves a goal optimal, a group lead's own line included. */
export const claimsProof = (status: Status): boolean =>
  status.word === 'proven infeasible' || (status.word === 'validated feasible' && (status.goals.some(goal => goal.word === 'proven optimal') || leadProven(status)))

/**
 * Removes proof words: proven goals, and a group lead's own line, become best found without their bound; a
 * refusal becomes "unresolved".
 */
export const withoutProof = (status: Status): Status => {
  if (status.word === 'validated feasible') {
    const lead = status.lead !== undefined && 'group' in status.lead && status.lead.word === 'proven optimal' ? unprovenLead(status.lead) : status.lead
    return parse({ ...status, goals: status.goals.map(goal => (goal.word === 'proven optimal' ? unproven(goal, false) : goal)), ...(lead === undefined ? {} : { lead }) })
  }
  if (status.word === 'proven infeasible') return parse({ word: 'unresolved', run: status.run })
  return status
}

export interface RedundancyWarning {
  readonly code: 'redundancy_unruled'
  /** Items of one function out at the same time, none named by a keep-in-service or protected rule. */
  readonly items: readonly string[]
  readonly from: string
  readonly to: string
}

const ruleNamed = (inputs: PlanInputs): ReadonlySet<string> => new Set(inputs.rules.flatMap(rule =>
  rule.kind === 'protected' ? rule.equipment : rule.kind === 'keep-in-service' ? rule.members.flatMap(member => ('equipment' in member ? [member.equipment] : [])) : []))

/**
 * THE redundancy rule of the Module (adversary r2 item 7): among the items `out`, two or more that share an
 * equipment `function` key (they back each other up; one train's series chain shares none), none named by a
 * keep-in-service or protected rule. Returns the first such set. Lane P's plan readiness calls it too.
 */
export const redundantItems = (inputs: PlanInputs, out: readonly string[]): readonly string[] | undefined => {
  const named = ruleNamed(inputs)
  const byFunction = new Map<string, string[]>()
  for (const key of out) {
    const shared = inputs.equipment.find(entry => entry.key === key)?.function
    if (shared !== undefined) byFunction.set(shared, [...(byFunction.get(shared) ?? []), key])
  }
  return [...byFunction.values()].find(items => items.length >= 2 && !items.some(key => named.has(key)))
}

/**
 * On an option: redundant items (redundantItems) its rows have out at the same time. An item is out from
 * its first covering tag-out start to its last covering test finish (the window end if never tested), and
 * while any supporter is out. The first such time and set.
 */
export const redundancyWarning = (inputs: PlanInputs, rows: ReadonlyArray<{ readonly job: string; readonly start: string; readonly finish: string }>): RedundancyWarning | undefined => {
  if (rows.length === 0) return undefined
  const windowEnd = inputs.settings.window === null ? Math.max(...rows.map(row => Date.parse(row.finish))) : Date.parse(inputs.settings.window.end)
  const jobs = new Map(inputs.jobs.map(job => [job.key, job]))
  const own = (key: string): Array<[number, number]> => {
    const tags = rows.filter(row => jobs.get(row.job)?.kind === 'tag-out' && jobs.get(row.job)!.equipment.includes(key)).map(row => Date.parse(row.start))
    if (tags.length === 0) return []
    const tests = rows.filter(row => jobs.get(row.job)?.kind === 'test' && jobs.get(row.job)!.equipment.includes(key)).map(row => Date.parse(row.finish))
    return [[Math.min(...tags), tests.length === 0 ? windowEnd : Math.max(...tests)]]
  }
  const supporters = new Map(inputs.equipment.map(item => [item.key, item.supportedBy]))
  const intervals = (key: string, seen: ReadonlySet<string> = new Set()): Array<[number, number]> => (seen.has(key) ? []
    : [...own(key), ...(supporters.get(key) ?? []).flatMap(supporter => intervals(supporter, new Set([...seen, key])))])
  const spans = new Map(inputs.equipment.map(item => [item.key, intervals(item.key)]))
  for (const at of [...new Set([...spans.values()].flat().map(([from]) => from))].sort((x, y) => x - y)) {
    const out = [...spans].filter(([, list]) => list.some(([from, to]) => from <= at && at < to)).map(([key]) => key)
    const items = redundantItems(inputs, out)
    if (items === undefined) continue
    const to = Math.min(...items.flatMap(key => spans.get(key)!.filter(([from, end]) => from <= at && at < end).map(([, end]) => end)))
    return { code: 'redundancy_unruled', items: [...items].slice(0, 32), from: new Date(at).toISOString(), to: new Date(to).toISOString() }
  }
  return undefined
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
