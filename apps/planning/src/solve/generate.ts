// Generate: what-if variants -> method combinations (at most 8 sub-solves) -> compile -> bounds ->
// engine -> dated rows with float -> the independent checker -> status words -> ranked option set.
// Planning makes no World writes; nothing here calls World. A cancel keeps, per variant, the better of
// the stored and the new option: an old option is replaced only by a new one that is validated feasible
// on the current revision and ranks better, or when the old one is stale (never a demotion).
// A what-if may add one hard rule (`also`, appended to the plan's rules, never replacing one) and may solve a
// goal first (`lead`: a plan goal, or a group's outage); its option keeps the plan's goal ids. With `keep` the
// new options join the stored ones, each sub-solve starting from the best stored option that buys no more.
import type { z } from 'zod'
import type { generateInputSchema } from '../api/contract.ts'
import { planningError } from '../errors.ts'
import { optionSetSchema, type CertifiedSize, type PlanInputs, type Status } from '../plan/schema.ts'
import { jobsPerSolve, sizeBand, sizeRefusalWords } from '../plan/summary.ts'
import { timeUnitMs } from '../time/units.ts'
import { bounds } from './bounds.ts'
import { compile, formulationOf, methodCombinations, permittedPurchases, withExtraRules, type Buy, type CompileIndex, type MethodPick } from './compile.ts'
import { dateSchedule, slotInstant, undate, type DatedRow } from './date.ts'
import { finishOf, prepare } from './decode.ts'
import { totalFloat, withFloat } from './float.ts'
import { estimateMemoryMb, SOLVER_CPU_CAP_CORES } from './pool.ts'
import type { Engine, EngineResult, NormalizedProblem, Schedule } from './problem.ts'
import { compareOptions, goalExcess, goalKey, goalKeys, type Rankable, type RankFacts, type RawMetric } from './rank.ts'
import { retimingCount, robustOf, type JudgeRetimed } from './retime.ts'
import { cancelledStatus, feasibleStatus, infeasibleStatus, inputProblems, onPlanGoals, refusedStatus, unresolvedStatus, type CheckPlan, type CheckReport, type VerifyCertificate, verifiedGoals, type VerifyBound } from './status.ts'

type OptionSet = z.infer<typeof optionSetSchema>
type Option = OptionSet['options'][number]
type Actor = OptionSet['by']
export type GenerateInput = z.infer<typeof generateInputSchema>
/** A what-if's one extra hard rule, as stored on its option. */
export type AlsoRule = NonNullable<Option['variant']['also']>[number]
/** What a what-if solves first, as stored on its option. */
export type Lead = NonNullable<Option['variant']['lead']>

/**
 * The certified size (G2, A8), decided on 15 Nov (the owner delegated the scale decision): Planning is
 * certified for plans of up to 33 jobs in one solve, the measured size (`maxJobs`, jobs per solve as
 * plan/summary's jobsPerSolve counts them); it handles up to 40 (`limitJobs`) with a caution on every option,
 * and refuses above that. The two numbers live here and nowhere else. A native CP solver for larger plans is
 * deferred. `evidence` is the measurement, shown to planners only as detail; the words are plan/summary's.
 */
export const CERTIFIED_SIZE: CertifiedSize = {
  decided: true,
  family: 'one system window',
  maxJobs: 33,
  // Above 33 and up to 40 jobs Generate runs with a caution on every option; above 40 it refuses. The band
  // is for a few jobs added to a 33-job window (found work), not for bigger weeks: a 60-job solve peaks at
  // 144-164 MB in its child, above the 140 MB ceiling, while 40 jobs peak at 124-139 MB (33 jobs: 126-132).
  limitJobs: 40,
  evidence: 'Measured 11 Nov on single-train work weeks: 9 of 9 runs within 5 % of the proven optimum at 33 jobs; 7 of 9 at 60; 4 of 9 at 100; 0 of 9 at 130. Measured 15 Nov: a 60-job solve needs more memory than the service allows, so Planning handles up to 40 jobs.',
}

export const MAX_SUB_SOLVES = 8
/** The design limit for one Generate: one request of at most 20 s, every sub-solve and spawn included. */
export const GENERATE_DEADLINE_MS = 20_000
/** Less time than this left: a sub-solve is not started (a child's spawn, compile and check need it). */
const MIN_SUB_SOLVE_MS = 500
/**
 * A sub-solve's search ends this long, plus as long as the work before the search took, before the sub-solve
 * must answer. This part is the engine's own stop latency: it checks its budget at least every 50 ms of work
 * and paces in sleeps of at most 200 ms. The measured part covers the work after the search (dating, float on
 * the option's own compile, lane K's check and bound re-derivations, the answer's encoding): the same kind of
 * work as before it (compile, lane K's readiness check, prepare, bounds), on the same problem, machine and CPU
 * quota, and the smaller of the two (flagship, 15 Nov: on the Mac 100-145 ms before the search and 15-30 ms after;
 * at background priority, its slow cores, 410-575 ms and 80-140 ms). Measured rather than tuned to one machine,
 * so it scales where both run several times slower, as under the service's CPU quota.
 */
export const SEARCH_STOP_LATENCY_MS = 250
/** Memory a solve may be estimated to need before it is refused (A7). */
export const MEMORY_BUDGET_MB = 80
const DEFAULT_SECONDS = 20

export interface GenerateDeps {
  readonly engine: Engine
  readonly check: CheckPlan
  /** Lane K's certificate re-verification: a refusal is stored as proof only when it proves. */
  readonly verify: VerifyCertificate
  /** Lane K's re-derivation of each "proven optimal" bound: a goal is stored as proven only when it proves. */
  readonly verifyBound: VerifyBound
  /** Runs each sub-solve; by default in this process on `engine` and these checks. Production: the pool's child. */
  readonly subSolver?: SubSolver
  /** Lane K's judgement of a re-timed schedule, for the in-process sub-solver (the child has its own). */
  readonly judgeRetimed?: JudgeRetimed
  readonly certifiedSize?: CertifiedSize
  readonly now?: () => string
}
export interface GenerateRequest {
  readonly inputs: PlanInputs
  readonly revision: number
  readonly previous: OptionSet | null
  readonly input: GenerateInput
  readonly by: Actor
  readonly signal: AbortSignal
  /** Who stopped it, when the signal fires. */
  readonly stoppedByWho?: () => 'person' | 'host' | undefined
  readonly seed?: number
  /**
   * An evaluation budget per sub-solve. With it (and time to spare) a run is reproducible: the same plan for
   * the same inputs and seed on any machine or pool state. Without it the CPU budget decides.
   */
  readonly evals?: number
}
export interface GenerateResult {
  readonly optionSet: OptionSet
  /** Per option: kept from the stored set (better or still valid), or new. */
  readonly kept: readonly string[]
  readonly rounded: CompileIndex['rounded']
  readonly dropped: CompileIndex['dropped']
}

/** A what-if as one variant: what it asks (`buy`, `also`, `lead`) and the method combinations it solves. */
export interface WhatIf { readonly buy: Buy; readonly also?: readonly AlsoRule[]; readonly lead?: Lead }
interface Variant extends WhatIf { readonly key: string; readonly label: string; readonly combos: MethodPick[][] }

const slug = (text: string): string => text.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64).replace(/-+$/, '') || 'option'

/** FNV-1a over the text, 32 bits as 8 hex digits: the same short name in every process. */
const digest = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0')
}
/** What an extra rule asks, without its key, words or source: two rules that ask the same are one what-if. */
const ruleContent = (rule: AlsoRule) => (rule.kind === 'span-limit'
  ? { kind: rule.kind, group: rule.group, limitMs: rule.limit.value * timeUnitMs[rule.limit.unit], singleEntry: rule.singleEntry }
  : { kind: rule.kind, job: rule.job, finishBy: Date.parse(rule.finishBy) })

/**
 * An option's key (design §4.1): a function of its method picks (as asked, in the plan's method order), the
 * purchases it may use, its extra rule and its lead. The plain options (every allowed purchase, no rule, no
 * lead) keep their method key, so the default options are the top rung; anything else adds a digest of what
 * it asks. The same what-if asked again has the same key and replaces itself. At most 49 characters, so the
 * service's set suffix fits.
 */
export const optionKey = (inputs: PlanInputs, variant: WhatIf & { readonly methods: readonly MethodPick[] }): string => {
  const picks = inputs.methods.flatMap(choice => variant.methods.filter(pick => pick.choice === choice.key).map(pick => pick.option))
  const base = slug(picks.join('+') || 'plan').slice(0, 40).replace(/[-.]+$/, '')
  const permitted = permittedPurchases(inputs, variant.buy).toSorted()
  const standard = permittedPurchases(inputs, 'allowed').toSorted()
  const asked = {
    ...(permitted.join(' ') === standard.join(' ') ? {} : { buy: permitted }),
    ...(variant.also === undefined ? {} : { also: variant.also.map(ruleContent) }),
    ...(variant.lead === undefined ? {} : { lead: variant.lead }),
  }
  return Object.keys(asked).length === 0 ? base : `${base}-${digest(JSON.stringify(asked))}`
}

/** The variants of a request: given what-ifs, or one per method combination. */
export const variantsOf = (inputs: PlanInputs, input: GenerateInput): Variant[] => {
  const label = (combo: readonly MethodPick[]) => combo.map(pick => inputs.methods.find(choice => choice.key === pick.choice)?.options.find(option => option.key === pick.option)?.label ?? pick.option).join(', ') || inputs.settings.title
  const raw = input.variants === undefined
    ? methodCombinations(inputs).map(combo => ({ key: optionKey(inputs, { methods: combo, buy: 'allowed' }), label: label(combo), combos: [combo], buy: 'allowed' as Buy }))
    : input.variants.map((variant, i) => {
      const lead = variant.lead
      if (lead !== undefined && 'goal' in lead && lead.goal >= inputs.goals.length) {
        throw planningError(400, 'invalid_request', `This plan has ${inputs.goals.length} goal${inputs.goals.length === 1 ? '' : 's'}: a goal solved first is one of them, by its id from 0`, { expected: { lead: { goal: `0 to ${inputs.goals.length - 1}` } } })
      }
      const asked: WhatIf = { buy: (variant.buy ?? 'allowed') as Buy, ...(variant.also === undefined ? {} : { also: variant.also }), ...(lead === undefined ? {} : { lead }) }
      return { ...asked, key: optionKey(inputs, { ...asked, methods: variant.methods ?? [] }), label: variant.label ?? `What-if ${i + 1}`, combos: methodCombinations(inputs, variant.methods ?? []) }
    })
  const seen = new Map<string, number>()
  return raw.map(variant => {
    const count = seen.get(variant.key) ?? 0
    seen.set(variant.key, count + 1)
    return count === 0 ? variant : { ...variant, key: `${variant.key.slice(0, 52)}-${count + 1}` }
  })
}

/** The goal "finish this group first" puts at the head: the group's outage, the span-over kind, threshold 0. */
export const groupLeadGoal = (group: string): PlanInputs['goals'][number] => ({ metric: 'span-over', scope: { groups: [group] }, tolerance: { value: 0, unit: 'h' } })

/**
 * What a what-if is compiled on (design §4.2): `ruled`, the plan's rules with its extra rule appended;
 * `solving`, the same with the goal list it is solved with, its lead first and then the plan's other goals in
 * order (so a six-goal plan can lead with a seventh). `planGoalOf(p)` is the plan's goal id at compiled
 * position p; undefined for a group lead (fix D: metric ids are remapped to the plan's ids). Lane K is given
 * the plan's own inputs and the variant, and reads the extra rule from the variant.
 */
export const solveInputsOf = (inputs: PlanInputs, whatIf: Pick<WhatIf, 'also' | 'lead'>): { readonly ruled: PlanInputs; readonly solving: PlanInputs; readonly planGoalOf: (position: number) => number | undefined } => {
  const ruled = withExtraRules(inputs, whatIf.also)
  const lead = whatIf.lead
  if (lead === undefined) return { ruled, solving: ruled, planGoalOf: position => position }
  if ('group' in lead) return { ruled, solving: { ...ruled, goals: [groupLeadGoal(lead.group), ...inputs.goals] }, planGoalOf: position => (position === 0 ? undefined : position - 1) }
  const order = [lead.goal, ...inputs.goals.flatMap((_, k) => (k === lead.goal ? [] : [k]))]
  return { ruled, solving: { ...ruled, goals: order.map(k => inputs.goals[k]!) }, planGoalOf: position => order[position] }
}

/** The goal metrics stored on an option, by the plan's goal ids (a group lead's value is in its status), then lane K's 'bought:' measures. */
const metricsOf = (problem: NormalizedProblem, index: CompileIndex, raw: readonly RawMetric[], planGoalOf: (position: number) => number | undefined, measures: CheckReport['metrics'] = []): Option['metrics'] => {
  const goals = raw.flatMap((value, p) => {
    const k = planGoalOf(p)
    if (k === undefined) return []
    const unit = index.goals[p]!.unit
    if (typeof value === 'number') return [{ k, metric: { id: `goal:${k}`, value, unit } }]
    return value.map((span, i) => ({ k, metric: { id: `goal:${k}:${index.spans[problem.goals[p]!.spans![i]!]!.group}`, value: span, unit } }))
  })
  return [...goals.toSorted((x, y) => x.k - y.k).map(entry => entry.metric).slice(0, 32), ...measures.filter(metric => metric.id.startsWith('bought:')).map(metric => ({ ...metric })).slice(0, 64)]
}

/** The raw goal metrics stored on an option, back in goal order. */
export const rawOf = (option: Option, goals: number): RawMetric[] =>
  Array.from({ length: goals }, (_, k) => {
    const scalar = option.metrics.find(metric => metric.id === `goal:${k}`)
    if (scalar !== undefined) return scalar.value
    return option.metrics.filter(metric => metric.id.startsWith(`goal:${k}:`)).map(metric => metric.value)
  })

const rankGoals = (inputs: PlanInputs) => inputs.goals.map(goal => ({ threshold: goal.threshold?.value ?? 0, step: goal.tolerance.value }))

/** An option as the options table ranks it (rank.ts): its keys on the plan's goals, in the plan's order. */
export const rankableOf = (option: Option, inputs: PlanInputs): Rankable => ({
  key: option.key, feasible: option.status.word === 'validated feasible',
  keys: goalKeys(rawOf(option, inputs.goals.length), rankGoals(inputs)),
})

/** An option's ranking keys with each goal's excess in its unit, for "why recommended" (rank.ts recommendedBecause). */
export const factsOf = (option: Option, inputs: PlanInputs): RankFacts => {
  const raw = rawOf(option, inputs.goals.length)
  return { ...rankableOf(option, inputs), excess: rankGoals(inputs).map((goal, k) => goalExcess(raw[k] ?? 0, goal.threshold)) }
}

/**
 * An option ranked on the goal list it was solved with: a what-if's lead first (a plan goal's key, or the
 * group's outage in h), then the plan's other goals in order. Used between options of one what-if only.
 */
export const solvedRankable = (option: Option, inputs: PlanInputs): Rankable => {
  const lead = option.variant.lead
  const plain = rankableOf(option, inputs)
  if (lead === undefined || !plain.feasible) return plain
  if ('goal' in lead) return { ...plain, keys: [plain.keys[lead.goal]!, ...plain.keys.filter((_, k) => k !== lead.goal)] }
  const line = option.status.word === 'validated feasible' ? option.status.lead : undefined
  const value = line !== undefined && 'group' in line ? line.value : Infinity
  return { ...plain, keys: [goalKey(goalExcess(value, 0), 0), ...plain.keys] }
}
const rankable = solvedRankable

/**
 * Runs Generate. Refusals (above the certified size, too many sub-solves, memory) throw planning errors
 * with the reason; every other outcome is an option with a status from the status schema.
 */
/**
 * Float within what the option buys: on the compile of its own purchases, the one the explainer and the
 * preview use, so a slip never counts on time from a purchase the option does not make.
 */
const withOwnFloat = (inputs: PlanInputs, variant: Option['variant'], rows: ReturnType<typeof dateSchedule>): ReturnType<typeof withFloat> => {
  const own = compile(inputs, { methods: variant.methods, buy: variant.purchases })
  if (!own.ok) throw new Error(`The option's own purchases do not compile: ${own.word}`)
  const prep = prepare(own.problem)
  const found = undate(prep, own.index, rows)
  if (!found.ok) throw new Error(`The option's row for ${found.job} does not fit its own purchases`)
  return withFloat(rows, totalFloat(prep, own.index, found.schedule), own.index)
}

/** One sub-solve: a variant's method combination of the plan, with the budget and seed Generate gives it. */
export interface SubSolveTask {
  readonly inputs: PlanInputs
  readonly revision: number
  readonly variant: WhatIf & { readonly key: string; readonly label: string }
  readonly combo: readonly MethodPick[]
  /**
   * With `keep`: the rows of the best stored option with the same method picks, extra rule and lead, on this
   * revision and formulation, that buys no more. The search starts from them, and they are kept, re-checked,
   * unless the search beats them, so a higher rung solved after a lower one is never worse (design §4.1).
   */
  readonly start?: { readonly rows: readonly DatedRow[] }
  readonly budget: { readonly evals: number; readonly cpuMs: number; readonly wallMs: number }
  readonly seed: number
  /** The Generate's deadline (epoch ms): a solver child still running then is killed. */
  readonly deadlineAt?: number
  /**
   * When this sub-solve answers (epoch ms, at or before `deadlineAt`): its share of the Generate's time. Its
   * search ends early enough for the work after it, so the answer comes in time on a CPU-capped machine too.
   */
  readonly answerBy?: number
}
export interface SubSolveOutcome {
  readonly option: Option
  readonly rounded: CompileIndex['rounded']
  readonly dropped: CompileIndex['dropped']
}
/**
 * What a sub-solve runs on: the search engine, lane K's checker and its re-verifications, and lane K's
 * judgement of a re-timed schedule. Without `judgeRetimed` no option carries `robust` (not computed).
 */
export interface SubSolveDeps { readonly engine: Engine; readonly check: CheckPlan; readonly verify: VerifyCertificate; readonly verifyBound: VerifyBound; readonly judgeRetimed?: JudgeRetimed }
/** Runs sub-solves: in this process (`subSolve`), or in a solver child process (pool.ts `subSolver`). */
export type SubSolver = (task: SubSolveTask, signal: AbortSignal, stoppedByWho?: () => 'person' | 'host' | undefined) => Promise<SubSolveOutcome>

/**
 * The search's budget within the time the sub-solve has: its wall time ends `reserveMs` before `by`, and its
 * CPU shrinks in proportion, so the CPU rate (and the cap) stays as granted. A budget that fits is unchanged.
 */
export const searchBudgetBy = (budget: SubSolveTask['budget'], by: number, reserveMs: number, now = Date.now()): SubSolveTask['budget'] => {
  const wallMs = Math.floor(by - now - reserveMs)
  if (wallMs >= budget.wallMs) return budget
  if (wallMs <= 0) return { ...budget, cpuMs: 0, wallMs: 0 }
  return { ...budget, cpuMs: Math.floor(budget.cpuMs * wallMs / budget.wallMs), wallMs }
}

/**
 * A sub-solve: compile, bounds (a refusal stored as proof only when lane K proves it), search, dating,
 * float on the option's own purchases, lane K's check and its bound re-derivation. Pure apart from the
 * engine and the clock (its search ends in time to answer by `answerBy`); the solver child runs exactly this.
 */
export const subSolve = (deps: SubSolveDeps): SubSolver => async (task, signal, stoppedByWho) => {
  const started = performance.now()
  const { inputs, variant, combo, budget, seed } = task
  const formulation = formulationOf(inputs.settings.grid)
  // Compile takes the extra rule after the plan's and the goals lead first (§4.2); lane K takes the plan's own
  // inputs and reads the extra rule from the variant it is given.
  const { ruled, solving, planGoalOf } = solveInputsOf(inputs, variant)
  const asked = { ...(variant.also === undefined ? {} : { also: [...variant.also] }), ...(variant.lead === undefined ? {} : { lead: variant.lead }) }
  const base = { key: variant.key, label: variant.label.slice(0, 160), inputsRevision: task.revision }
  const compiled = compile(solving, { methods: [...combo], buy: variant.buy })
  if (!compiled.ok) return { option: { ...base, variant: { methods: [...combo], purchases: [], ...asked }, status: refusedStatus(compiled.word, compiled.problems), rows: [], metrics: [] }, rounded: [], dropped: [] }
  const { problem, index } = compiled
  const outcome = (option: Option): SubSolveOutcome => ({ option, rounded: index.rounded, dropped: index.dropped })
  const stored = (purchases: readonly string[]) => ({ methods: [...combo], purchases: [...purchases], ...asked })
  /** The variant lane K checks: methods, purchases and the extra rule (never the lead, which it reads from the status). */
  const checked = (purchases: readonly string[]) => ({ methods: [...combo], purchases: [...purchases], ...(variant.also === undefined ? {} : { also: [...variant.also] }) })
  const variantOut = checked(index.allowedPurchases)
  const runBasis = (result: Pick<EngineResult, 'stoppedBy' | 'evals' | 'cpuMs'>, granted: SubSolveTask['budget'] = budget) => {
    const who = result.stoppedBy === 'cancelled' ? stoppedByWho?.() : undefined
    return { grid: inputs.settings.grid, engine: deps.engine.name, formulation, seed, budget: { ...granted }, stoppedBy: result.stoppedBy, ...(who === undefined ? {} : { stoppedByWho: who }), evals: result.evals, cpuMs: Math.round(result.cpuMs) }
  }
  // Readiness blocks before any search: an input finding (a precondition not read from World, say) is
  // "invalid input" with the checker's cause, whatever a schedule would look like.
  const blockers = inputProblems(deps.check({ inputs, variant: variantOut, rows: [] }).violations)
  if (blockers.length > 0) return outcome({ ...base, variant: stored(variantOut.purchases), status: refusedStatus('invalid input', blockers), rows: [], metrics: [] })
  const prep = prepare(problem)
  const found = bounds(problem, index, prep)
  // A refusal is stored as proof only when lane K re-verifies it with nothing left unverified.
  if (found.certificate !== undefined && deps.verify(inputs, variantOut, found.certificate).proves) {
    return outcome({ ...base, variant: stored(variantOut.purchases), status: infeasibleStatus(found.certificate, runBasis({ stoppedBy: 'done', evals: 0, cpuMs: 0 })), rows: [], metrics: [] })
  }
  if (estimateMemoryMb(problem) > MEMORY_BUDGET_MB) throw planningError(413, 'above_certified_size', 'This plan is too large for the certified size', { estimateMb: Math.ceil(estimateMemoryMb(problem)) })
  // The search ends in time for the work after it, which takes no longer than the work before it took, once
  // for the plan found and once more for each re-check of a starting option and each re-timing: the
  // sub-solve answers by its time with its best checked result, never killed for running past it.
  const by = Math.min(task.answerBy ?? Infinity, task.deadlineAt ?? Infinity)
  const retimings = deps.judgeRetimed === undefined ? 0 : retimingCount(inputs, index.jobs.flatMap(job => (job === null ? [] : [job])))
  const after = 1 + (task.start === undefined ? 0 : 1) + retimings
  const searchBudget = searchBudgetBy(budget, by, SEARCH_STOP_LATENCY_MS + (performance.now() - started) * after)
  // No time left to search: no plan, said as a search stopped by its time.
  if (searchBudget.wallMs <= 0) return outcome({ ...base, variant: stored(variantOut.purchases), status: unresolvedStatus(runBasis({ stoppedBy: 'wall', evals: 0, cpuMs: 0 }, searchBudget)), rows: [], metrics: [] })
  const startSchedule = task.start === undefined ? undefined : undate(prep, index, task.start.rows)
  const initial: Schedule | undefined = startSchedule?.ok === true ? startSchedule.schedule : undefined
  const result = await deps.engine.solve(problem, { budget: { ...searchBudget, memoryMb: MEMORY_BUDGET_MB }, seed, signal: signal, ...(initial === undefined ? {} : { initial }) })
  const run = runBasis(result, searchBudget)

  /**
   * The checker's goal values in the order they were solved: the plan's goals as lane K reports them, the lead
   * first. A group lead's value is lane K's own span of the group; a group never out has no span entry and,
   * as lane K counts a span-over goal, is 0 h out.
   */
  const solvedOrder = (report: CheckReport): RawMetric[] => {
    const lead = variant.lead
    if (lead === undefined) return [...report.goals]
    if ('goal' in lead) return solving.goals.map((_, p) => report.goals[planGoalOf(p)!]!)
    const span = report.metrics?.find(metric => metric.id === `span:${lead.group}`)
    return [[span?.value ?? 0], ...report.goals]
  }
  /** A validated feasible option from checked rows: goal words solved lead first, back on the plan's ids, each proof re-derived by lane K. */
  const feasible = (rows: Option['rows'], planned: ReturnType<typeof checked>, report: CheckReport): Option => {
    const raw = solvedOrder(report)
    const solved = feasibleStatus(solving.goals, run, raw, found.goals).status
    const lead = variant.lead
    const group = lead !== undefined && 'group' in lead ? lead.group : undefined
    const status = verifiedGoals(onPlanGoals(solved, lead, planGoalOf),
      (goal, bound) => deps.verifyBound(inputs, planned, goal, bound),
      group === undefined ? undefined : bound => deps.verifyBound(inputs, planned, { group, unit: groupLeadGoal(group).tolerance.unit }, bound))
    return { ...base, variant: stored(planned.purchases), status, rows, metrics: metricsOf(problem, index, raw, planGoalOf, report.metrics) }
  }
  const usedBy = (rows: ReadonlyArray<Pick<DatedRow, 'uses'>>): string[] => [...new Set([...rows.flatMap(row => row.uses.flatMap(use => (use.purchase === undefined ? [] : [use.purchase]))), ...index.purchases.filter(purchase => purchase.committed).map(purchase => purchase.key)])]

  /** The search's plan, or the status that says why there is none. */
  const searched = (): Option => {
    const candidate = result.candidates[0]
    if (candidate === undefined) return { ...base, variant: stored(variantOut.purchases), status: result.stoppedBy === 'cancelled' ? cancelledStatus(run) : unresolvedStatus(run), rows: [], metrics: [] }
    const late = problem.activities.flatMap((activity, a) => {
      const finish = finishOf(prep, a, candidate.mode[a]!, candidate.start[a]!)
      return finish < 0 || finish > activity.deadline ? [{ a, finish: finish < 0 ? problem.horizon : finish }] : []
    })
    if (late.length > 0) {
      // Not a plan: the best attempt runs past the window. Its lateness is explanation only, not proof.
      const worst = late.reduce((x, y) => (y.finish > x.finish ? y : x))
      const job = index.jobs[worst.a] ?? problem.activities[worst.a]!.id
      return {
        ...base, variant: stored(variantOut.purchases), rows: [], metrics: [],
        status: unresolvedStatus(run, { job, wouldFinish: slotInstant(index, worst.finish), pastWindowHours: (worst.finish - index.windowSlots) * index.slotMs / 3_600_000 }),
      }
    }
    const dated = dateSchedule(prep, index, candidate)
    // Cost and order lists come from what the rows use (plus purchases already ordered, charged anyway).
    const used = usedBy(dated)
    const planned = checked(index.allowedPurchases.filter(key => used.includes(key)))
    const rows = withOwnFloat(ruled, planned, dated)
    const report = deps.check({ inputs, variant: planned, rows })
    const problems = inputProblems(report.violations)
    if (problems.length > 0) return { ...base, variant: stored(planned.purchases), status: refusedStatus('invalid input', problems), rows: [], metrics: [] }
    if (report.violations.length > 0) return { ...base, variant: stored(variantOut.purchases), status: unresolvedStatus(run), rows: [], metrics: [] }
    // Every "proven optimal" carries its bound's certificate; lane K re-derives the bound, or it reads "best found".
    return feasible(rows, planned, report)
  }
  /**
   * The starting option's rows, re-checked by lane K on this sub-solve: an option when they keep every rule
   * here with only the purchases this sub-solve may use. Their float stands: the same revision, rules and
   * purchases give the same float.
   */
  const restarted = (): Option | undefined => {
    if (task.start === undefined) return undefined
    const used = usedBy(task.start.rows)
    if (!used.every(key => index.allowedPurchases.includes(key))) return undefined
    const planned = checked(index.allowedPurchases.filter(key => used.includes(key)))
    const rows = task.start.rows.map(row => ({ ...row }))
    const report = deps.check({ inputs, variant: planned, rows })
    return report.violations.length === 0 ? feasible(rows, planned, report) : undefined
  }
  const own = searched()
  const kept = restarted()
  // Unless the search beats the starting option, the starting option stands (re-checked above).
  const best = kept !== undefined && (own.status.word !== 'validated feasible' || compareOptions(rankable(kept, inputs), rankable(own, inputs)) <= 0) ? kept : own
  if (best.status.word !== 'validated feasible' || deps.judgeRetimed === undefined) return outcome(best)
  const robust = robustOf(inputs, best, deps.judgeRetimed, by - SEARCH_STOP_LATENCY_MS)
  return outcome(robust === undefined ? best : { ...best, robust })
}


export const generate = async (deps: GenerateDeps, request: GenerateRequest): Promise<GenerateResult> => {
  const { inputs } = request
  const certified = deps.certifiedSize ?? CERTIFIED_SIZE
  if (sizeBand(inputs, certified) === 'refused') {
    throw planningError(413, 'above_certified_size', sizeRefusalWords(certified, inputs), { jobs: jobsPerSolve(inputs), certifiedSize: certified })
  }
  // An option whose own solve (its method combination) has more jobs than the certified size carries the caution.
  const jobsIn = (combo: readonly MethodPick[]) => inputs.jobs.filter(job => job.method === undefined || combo.some(pick => pick.choice === job.method!.choice && pick.option === job.method!.option)).length
  const sized = (option: Option, combo: readonly MethodPick[]): Option => (jobsIn(combo) > certified.maxJobs ? { ...option, sizeCaution: true } : option)
  const variants = variantsOf(inputs, request.input)
  const subSolves = variants.reduce((sum, variant) => sum + variant.combos.length, 0)
  if (subSolves > MAX_SUB_SOLVES) throw planningError(422, 'too_many_sub_solves', `These what-ifs need ${subSolves} method combinations; at most ${MAX_SUB_SOLVES} are solved at once`, { subSolves })
  const formulation = formulationOf(inputs.settings.grid)
  const seconds = request.input.seconds ?? DEFAULT_SECONDS
  // One deadline for the whole Generate, every sub-solve and its spawn included: the design's one request
  // of at most 20 s (Host times out at 30 s). Sub-solve budgets share it; past it the rest are not run.
  const deadlineAt = Date.now() + Math.min(seconds * 1_000, GENERATE_DEADLINE_MS)
  // CPU within the solver cap (80 % of half a core); 10 % of the wall is kept for dating and checking.
  const wallMs = seconds * 1_000 * 0.9
  const share = { wallMs: wallMs / Math.max(1, subSolves), cpuMs: wallMs * SOLVER_CPU_CAP_CORES / Math.max(1, subSolves) }
  const seed = request.seed ?? 1
  const rounded: Array<CompileIndex['rounded'][number]> = []
  const dropped: Array<CompileIndex['dropped'][number]> = []

  const runSubSolve = deps.subSolver ?? subSolve(deps)
  const keep = request.input.keep === true
  const stored = request.previous?.options ?? []
  // Proofs and comparisons stand only on the revision and formulation they were made on.
  const sameBasis = (option: Option): boolean => option.inputsRevision === request.revision && (!('run' in option.status) || option.status.run.formulation === formulation)
  const askedOf = (variant: Variant) => ({ ...(variant.also === undefined ? {} : { also: [...variant.also] }), ...(variant.lead === undefined ? {} : { lead: variant.lead }) })
  const same = (x: unknown, y: unknown): boolean => JSON.stringify(x ?? null) === JSON.stringify(y ?? null)
  /**
   * With `keep`: the best stored option with these method picks, the same extra rule and lead, on this revision
   * and formulation, validated feasible, whose purchases this sub-solve may all use (it buys no more).
   */
  const startFor = (variant: Variant, combo: readonly MethodPick[]): Option | undefined => {
    if (!keep) return undefined
    const permitted = new Set(permittedPurchases(inputs, variant.buy))
    const candidates = stored.filter(option => sameBasis(option) && option.status.word === 'validated feasible'
      && same(option.variant.methods, combo) && same(option.variant.also, variant.also) && same(option.variant.lead, variant.lead)
      && option.variant.purchases.every(key => permitted.has(key)))
    return candidates.sort((x, y) => compareOptions(rankable(x, inputs), rankable(y, inputs)))[0]
  }
  let begun = 0
  const solveOne = async (variant: Variant, combo: MethodPick[]): Promise<Option> => {
    const evals = request.evals ?? Number.MAX_SAFE_INTEGER
    const left = subSolves - begun++
    const now = Date.now()
    const remaining = deadlineAt - now
    // Past the deadline a sub-solve is not run: it says so, as a search stopped by its time ("wall").
    if (remaining < MIN_SUB_SOLVE_MS) {
      const run = { grid: inputs.settings.grid, engine: deps.engine.name, formulation, seed, budget: { evals, cpuMs: 0, wallMs: 0 }, stoppedBy: 'wall' as const, evals: 0, cpuMs: 0 }
      return { key: variant.key, label: variant.label.slice(0, 160), inputsRevision: request.revision, variant: { methods: combo, purchases: [], ...askedOf(variant) }, status: unresolvedStatus(run), rows: [], metrics: [] }
    }
    // Each sub-solve answers by its equal share of the time left (at least MIN_SUB_SOLVE_MS), its spawn, compile
    // and check included, so an earlier one's search never takes the time a later one needs for its own; the
    // last answers by the deadline.
    const slot = Math.min(remaining, Math.max(MIN_SUB_SOLVE_MS, remaining / left))
    const wall = Math.min(share.wallMs, slot * 0.9)
    const budget = { evals, cpuMs: Math.round(Math.min(share.cpuMs, wall * SOLVER_CPU_CAP_CORES)), wallMs: Math.round(wall) }
    const start = startFor(variant, combo)
    const task: SubSolveTask = {
      inputs, revision: request.revision, variant: { key: variant.key, label: variant.label, buy: variant.buy, ...askedOf(variant) }, combo, budget, seed, deadlineAt, answerBy: Math.floor(now + slot),
      ...(start === undefined ? {} : { start: { rows: start.rows } }),
    }
    const outcome = await runSubSolve(task, request.signal, request.stoppedByWho)
    rounded.push(...outcome.rounded.filter(entry => !rounded.some(known => known.about === entry.about && known.code === entry.code)))
    dropped.push(...outcome.dropped.filter(entry => !dropped.some(known => known.purchase === entry.purchase)))
    return outcome.option
  }

  const fresh: Option[] = []
  for (const variant of variants) {
    const attempts: Option[] = []
    for (const combo of variant.combos) {
      attempts.push(sized(await solveOne(variant, combo), combo))
      if (request.signal.aborted) break
    }
    if (attempts.length === 0) continue
    // A variant's option is its best method combination.
    fresh.push(attempts.sort((x, y) => compareOptions(rankable(x, inputs), rankable(y, inputs)))[0]!)
    if (request.signal.aborted) break
  }

  // Never demote: per variant keep the stored option unless the new one is valid and ranks better, or the stored one is stale.
  const validStored = (option: Option): boolean => sameBasis(option) && option.status.word === 'validated feasible'
  const kept: string[] = []
  const merged: Option[] = fresh.map(option => {
    const old = stored.find(candidate => candidate.key === option.key)
    if (old === undefined || !validStored(old)) return option
    const newWins = option.status.word === 'validated feasible' && compareOptions(rankable(option, inputs), rankable(old, inputs)) < 0
    if (newWins) return option
    kept.push(old.key)
    return old
  })
  // With `keep` every stored option on this revision and formulation stays beside the new ones (a refusal
  // too: the ladder reads it); without it, only on a stop, and only a valid one.
  const stays = (old: Option): boolean => (keep ? sameBasis(old) : request.signal.aborted && validStored(old))
  const extra = stored.filter(old => !merged.some(option => option.key === old.key) && stays(old))
  // At most 8 options: the new ones first, then the stored plain options, then stored what-ifs, each in stored order.
  const whatIf = (option: Option): boolean => option.variant.also !== undefined || option.variant.lead !== undefined
  for (const old of [...extra.filter(option => !whatIf(option)), ...extra.filter(whatIf)]) { merged.push(old); kept.push(old.key) }
  const set = merged.slice(0, 8)
  // A lead what-if is a card, never ranked among the options or recommended (design §0.3): it comes last.
  const plain = set.filter(option => option.variant.lead === undefined).sort((x, y) => compareOptions(rankableOf(x, inputs), rankableOf(y, inputs)))
  const led = set.filter(option => option.variant.lead !== undefined).sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
  const ranked = [...plain, ...led]
  const recommended = plain.find(option => option.status.word === 'validated feasible')
  const optionSet = optionSetSchema.parse({
    at: deps.now?.() ?? new Date().toISOString(), by: request.by, options: ranked,
    ...(recommended === undefined ? {} : { recommended: recommended.key }),
  })
  return { optionSet, kept, rounded, dropped }
}

export type { Status }
