// Generate: what-if variants -> method combinations (at most 8 sub-solves) -> compile -> bounds ->
// engine -> dated rows with float -> the independent checker -> status words -> ranked option set.
// Planning makes no World writes; nothing here calls World. A cancel keeps, per variant, the better of
// the stored and the new option: an old option is replaced only by a new one that is validated feasible
// on the current revision and ranks better, or when the old one is stale (never a demotion).
import type { z } from 'zod'
import type { generateInputSchema } from '../api/contract.ts'
import { planningError } from '../errors.ts'
import { optionSetSchema, type CertifiedSize, type PlanInputs, type Status } from '../plan/schema.ts'
import { jobsPerSolve, sizeRefusalWords, withinCertifiedSize } from '../plan/summary.ts'
import { bounds } from './bounds.ts'
import { compile, formulationOf, methodCombinations, type Buy, type CompileIndex, type MethodPick } from './compile.ts'
import { dateSchedule, slotInstant, undate } from './date.ts'
import { finishOf, prepare } from './decode.ts'
import { totalFloat, withFloat } from './float.ts'
import { estimateMemoryMb, SOLVER_CPU_CAP_CORES } from './pool.ts'
import type { Engine, EngineResult, NormalizedProblem } from './problem.ts'
import { compareOptions, goalKeys, type RawMetric } from './rank.ts'
import { cancelledStatus, feasibleStatus, infeasibleStatus, inputProblems, refusedStatus, unresolvedStatus, type CheckPlan, type VerifyCertificate, verifiedGoals, type VerifyBound } from './status.ts'

type OptionSet = z.infer<typeof optionSetSchema>
type Option = OptionSet['options'][number]
type Actor = OptionSet['by']
export type GenerateInput = z.infer<typeof generateInputSchema>

/**
 * The certified size (G2, A8). The owner's scale-gate decision is pending (`decided` false), so nothing is
 * certified, and Generate refuses above the measured size (`maxJobs`, jobs per solve as plan/summary's
 * jobsPerSolve counts them). `evidence` is the measurement, shown to planners only as detail; the words are
 * plan/summary's.
 */
export const CERTIFIED_SIZE: CertifiedSize = {
  decided: false,
  family: 'one system window',
  maxJobs: 33,
  evidence: 'Measured 11 Nov on single-train work weeks: 9 of 9 runs within 5 % of the proven optimum at 33 jobs; 7 of 9 at 60; 4 of 9 at 100; 0 of 9 at 130.',
}

export const MAX_SUB_SOLVES = 8
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

interface Variant { readonly key: string; readonly label: string; readonly combos: MethodPick[][]; readonly buy: Buy }

const slug = (text: string): string => text.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64).replace(/-+$/, '') || 'option'

/** The variants of a request: given what-ifs, or one per method combination. */
export const variantsOf = (inputs: PlanInputs, input: GenerateInput): Variant[] => {
  const label = (combo: readonly MethodPick[]) => combo.map(pick => inputs.methods.find(choice => choice.key === pick.choice)?.options.find(option => option.key === pick.option)?.label ?? pick.option).join(', ') || inputs.settings.title
  const raw = input.variants === undefined
    ? methodCombinations(inputs).map(combo => ({ key: slug(combo.map(pick => pick.option).join('+') || 'plan'), label: label(combo), combos: [combo], buy: 'allowed' as Buy }))
    : input.variants.map((variant, i) => ({
      key: slug(variant.label ?? `variant-${i + 1}`), label: variant.label ?? `What-if ${i + 1}`,
      combos: methodCombinations(inputs, variant.methods ?? []), buy: (variant.buy ?? 'allowed') as Buy,
    }))
  const seen = new Map<string, number>()
  return raw.map(variant => {
    const count = seen.get(variant.key) ?? 0
    seen.set(variant.key, count + 1)
    return count === 0 ? variant : { ...variant, key: `${variant.key.slice(0, 60)}-${count + 1}` }
  })
}

const metricsOf = (problem: NormalizedProblem, index: CompileIndex, raw: readonly RawMetric[]): Option['metrics'] =>
  raw.flatMap((value, k) => {
    const unit = index.goals[k]!.unit
    if (typeof value === 'number') return [{ id: `goal:${k}`, value, unit }]
    return value.map((span, i) => ({ id: `goal:${k}:${index.spans[problem.goals[k]!.spans![i]!]!.group}`, value: span, unit }))
  }).slice(0, 32)

/** The raw goal metrics stored on an option, back in goal order. */
export const rawOf = (option: Option, goals: number): RawMetric[] =>
  Array.from({ length: goals }, (_, k) => {
    const scalar = option.metrics.find(metric => metric.id === `goal:${k}`)
    if (scalar !== undefined) return scalar.value
    return option.metrics.filter(metric => metric.id.startsWith(`goal:${k}:`)).map(metric => metric.value)
  })

const rankable = (option: Option, inputs: PlanInputs) => ({
  key: option.key, feasible: option.status.word === 'validated feasible',
  keys: goalKeys(rawOf(option, inputs.goals.length), inputs.goals.map(goal => ({ threshold: goal.threshold?.value ?? 0, step: goal.tolerance.value }))),
})

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

export const generate = async (deps: GenerateDeps, request: GenerateRequest): Promise<GenerateResult> => {
  const { inputs } = request
  const certified = deps.certifiedSize ?? CERTIFIED_SIZE
  if (!withinCertifiedSize(inputs, certified)) {
    throw planningError(413, 'above_certified_size', sizeRefusalWords(certified, inputs), { jobs: jobsPerSolve(inputs), certifiedSize: certified })
  }
  const variants = variantsOf(inputs, request.input)
  const subSolves = variants.reduce((sum, variant) => sum + variant.combos.length, 0)
  if (subSolves > MAX_SUB_SOLVES) throw planningError(422, 'too_many_sub_solves', `These what-ifs need ${subSolves} method combinations; at most ${MAX_SUB_SOLVES} are solved at once`, { subSolves })
  const formulation = formulationOf(inputs.settings.grid)
  const seconds = request.input.seconds ?? DEFAULT_SECONDS
  // CPU within the solver cap (80 % of half a core); 10 % of the wall is kept for dating and checking.
  const wallMs = seconds * 1_000 * 0.9
  const share = { wallMs: wallMs / Math.max(1, subSolves), cpuMs: wallMs * SOLVER_CPU_CAP_CORES / Math.max(1, subSolves) }
  const seed = request.seed ?? 1
  const rounded: Array<CompileIndex['rounded'][number]> = []
  const dropped: Array<CompileIndex['dropped'][number]> = []

  const solveOne = async (variant: Variant, combo: MethodPick[]): Promise<Option> => {
    const base = { key: variant.key, label: variant.label.slice(0, 160), inputsRevision: request.revision }
    const compiled = compile(inputs, { methods: combo, buy: variant.buy })
    if (!compiled.ok) return { ...base, variant: { methods: combo, purchases: [] }, status: refusedStatus(compiled.word, compiled.problems), rows: [], metrics: [] }
    const { problem, index } = compiled
    rounded.push(...index.rounded.filter(entry => !rounded.some(known => known.about === entry.about && known.code === entry.code)))
    dropped.push(...index.dropped.filter(entry => !dropped.some(known => known.purchase === entry.purchase)))
    const variantOut = { methods: combo, purchases: [...index.allowedPurchases] }
    const budget = { evals: request.evals ?? Number.MAX_SAFE_INTEGER, cpuMs: Math.round(share.cpuMs), wallMs: Math.round(share.wallMs) }
    const runBasis = (result: Pick<EngineResult, 'stoppedBy' | 'evals' | 'cpuMs'>) => {
      const who = result.stoppedBy === 'cancelled' ? request.stoppedByWho?.() : undefined
      return { grid: inputs.settings.grid, engine: deps.engine.name, formulation, seed, budget, stoppedBy: result.stoppedBy, ...(who === undefined ? {} : { stoppedByWho: who }), evals: result.evals, cpuMs: Math.round(result.cpuMs) }
    }
    // Readiness blocks before any search: an input finding (a precondition not read from World, say) is
    // "invalid input" with the checker's cause, whatever a schedule would look like.
    const blockers = inputProblems(deps.check({ inputs, variant: variantOut, rows: [] }).violations)
    if (blockers.length > 0) return { ...base, variant: variantOut, status: refusedStatus('invalid input', blockers), rows: [], metrics: [] }
    const prep = prepare(problem)
    const found = bounds(problem, index, prep)
    // A refusal is stored as proof only when lane K re-verifies it with nothing left unverified.
    if (found.certificate !== undefined && deps.verify(inputs, variantOut, found.certificate).proves) {
      return { ...base, variant: variantOut, status: infeasibleStatus(found.certificate, runBasis({ stoppedBy: 'done', evals: 0, cpuMs: 0 })), rows: [], metrics: [] }
    }
    if (estimateMemoryMb(problem) > MEMORY_BUDGET_MB) throw planningError(413, 'above_certified_size', 'This plan is too large for the certified size', { estimateMb: Math.ceil(estimateMemoryMb(problem)) })
    const result = await deps.engine.solve(problem, { budget: { ...budget, memoryMb: MEMORY_BUDGET_MB }, seed, signal: request.signal })
    const run = runBasis(result)
    const candidate = result.candidates[0]
    if (candidate === undefined) return { ...base, variant: variantOut, status: result.stoppedBy === 'cancelled' ? cancelledStatus(run) : unresolvedStatus(run), rows: [], metrics: [] }
    const late = problem.activities.flatMap((activity, a) => {
      const finish = finishOf(prep, a, candidate.mode[a]!, candidate.start[a]!)
      return finish < 0 || finish > activity.deadline ? [{ a, finish: finish < 0 ? problem.horizon : finish }] : []
    })
    if (late.length > 0) {
      // Not a plan: the best attempt runs past the window. Its lateness is explanation only, not proof.
      const worst = late.reduce((x, y) => (y.finish > x.finish ? y : x))
      const job = index.jobs[worst.a] ?? problem.activities[worst.a]!.id
      return {
        ...base, variant: variantOut, rows: [], metrics: [],
        status: unresolvedStatus(run, { job, wouldFinish: slotInstant(index, worst.finish), pastWindowHours: (worst.finish - index.windowSlots) * index.slotMs / 3_600_000 }),
      }
    }
    const dated = dateSchedule(prep, index, candidate)
    // Cost and order lists come from what the rows use (plus purchases already ordered, charged anyway).
    const used = [...new Set([...dated.flatMap(row => row.uses.flatMap(use => (use.purchase === undefined ? [] : [use.purchase]))), ...index.purchases.filter(purchase => purchase.committed).map(purchase => purchase.key)])]
    const planned = { methods: combo, purchases: index.allowedPurchases.filter(key => used.includes(key)) }
    const rows = withOwnFloat(inputs, planned, dated)
    const report = deps.check({ inputs, variant: planned, rows })
    const problems = inputProblems(report.violations)
    if (problems.length > 0) return { ...base, variant: planned, status: refusedStatus('invalid input', problems), rows: [], metrics: [] }
    if (report.violations.length > 0) return { ...base, variant: variantOut, status: unresolvedStatus(run), rows: [], metrics: [] }
    // Every "proven optimal" carries its bound's certificate; lane K re-derives the bound, or it reads "best found".
    const status = verifiedGoals(feasibleStatus(inputs.goals, run, report.goals, found.goals).status, (goal, bound) => deps.verifyBound(inputs, planned, goal, bound))
    return { ...base, variant: planned, status, rows, metrics: metricsOf(problem, index, report.goals) }
  }

  const fresh: Option[] = []
  for (const variant of variants) {
    const attempts: Option[] = []
    for (const combo of variant.combos) {
      attempts.push(await solveOne(variant, combo))
      if (request.signal.aborted) break
    }
    if (attempts.length === 0) continue
    // A variant's option is its best method combination.
    fresh.push(attempts.sort((x, y) => compareOptions(rankable(x, inputs), rankable(y, inputs)))[0]!)
    if (request.signal.aborted) break
  }

  // Never demote: per variant keep the stored option unless the new one is valid and ranks better, or the stored one is stale.
  const stored = request.previous?.options ?? []
  const validStored = (option: Option): boolean => option.inputsRevision === request.revision && option.status.word === 'validated feasible' && option.status.run.formulation === formulation
  const kept: string[] = []
  const merged: Option[] = fresh.map(option => {
    const old = stored.find(candidate => candidate.key === option.key)
    if (old === undefined || !validStored(old)) return option
    const newWins = option.status.word === 'validated feasible' && compareOptions(rankable(option, inputs), rankable(old, inputs)) < 0
    if (newWins) return option
    kept.push(old.key)
    return old
  })
  if (request.signal.aborted) {
    for (const old of stored) if (!merged.some(option => option.key === old.key) && validStored(old)) { merged.push(old); kept.push(old.key) }
  }
  const ranked = merged.slice(0, 8).sort((x, y) => compareOptions(rankable(x, inputs), rankable(y, inputs)))
  const recommended = ranked.find(option => option.status.word === 'validated feasible')
  const optionSet = optionSetSchema.parse({
    at: deps.now?.() ?? new Date().toISOString(), by: request.by, options: ranked,
    ...(recommended === undefined ? {} : { recommended: recommended.key }),
  })
  return { optionSet, kept, rounded, dropped }
}

export type { Status }
