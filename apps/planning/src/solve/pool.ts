// One solve at a time (a second is refused 'solver_busy'), in its own short-lived Bun child process (child.ts), behind the Engine
// seam: a solve's memory goes back to the OS when its process ends, so the service does not grow solve by
// solve (walk 3, R3-3). Budgets are CPU (within SOLVER_CPU_CAP_CORES together, across the children), wall
// and evaluations. Before a solve its memory is estimated and a plan over `budget.memoryMb` is refused;
// during it the child watches its own RSS and stops with 'memory' above CHILD_RSS_LIMIT_MB. A cancel is
// answered within a second, with the best plan found so far, or with no plan if the child does not answer
// in time (it is then killed). A child that ends without an answer is reported as 'ended', never hidden.
// Messages are JSON (wire.ts); a result is validated before it is used.
import { planningError } from '../errors.ts'
import { SOLVER_VERSIONS } from './search.ts'
import type { Engine, EngineResult, NormalizedProblem } from './problem.ts'
import { formulationOf } from './compile.ts'
import type { SubSolveOutcome, SubSolver } from './generate.ts'
import { unresolvedStatus } from './status.ts'
import { decode, encode, encodeProblem, encodeSchedule, limitingFromWire, outcomeFromWire, previewFromWire, resultFromWire, type ChildRequest, type ChildResponse } from './wire.ts'
import type { Limiting } from './limiting.ts'
import type { Plan, PlanInputs } from '../plan/schema.ts'
import type { PreviewResult } from './preview.ts'

type Option = NonNullable<Plan['options']>['options'][number]

/** A rough upper estimate of one solve's working memory in MB: slot arrays, modes and links, copied a few times. */
export const estimateMemoryMb = (problem: NormalizedProblem): number => {
  const slots = problem.horizon
  const perSlot = problem.resources.length * (2 + 2 + 8 + 4) + problem.calendars.length * (1 + 4 * 4)
  const modes = problem.activities.reduce((sum, activity) => sum + activity.modes.length, 0)
  const bytes = slots * perSlot + modes * 400 + problem.links.length * 120 + problem.activities.length * 2_000
  return 4 * bytes / 1_000_000
}

/**
 * The CPU the solver may use at once, in cores: 80 % of the unit's CPUQuota=50 % (ops review), so reads,
 * /health and re-checks keep a fifth of the quota. A lone solve may use all of it; when a second starts,
 * the running one is re-budgeted so that together they stay within it.
 */
export const SOLVER_CPU_CAP_CORES = 0.8 * 0.5

/**
 * A solver child's own RSS ceiling (MB). Measured on macOS, one child at a time, with every solve, re-check
 * and preview in the child: the service levels off near 102 MB (10 Generates and 20 previews), and a child
 * peaks at 124-139 MB on the flagship and S33v3 (it collects above three quarters of this ceiling). So service
 * plus child stays near 240 MB, and 140 MB keeps the worst case under the unit's 256 MB. The Linux proof is
 * the Release A ops gate.
 */
export const CHILD_RSS_LIMIT_MB = 140

/**
 * Every child is killed at a wall deadline, so a hung child never holds the only solver slot (adversary,
 * child boundary): a solve or sub-solve at its budget's wall time plus this margin (compile, bounds and lane
 * K's check run outside the engine budget, and take well under a second at the certified size); a preview
 * at PREVIEW_DEADLINE_MS (its p95 is under 100 ms).
 */
export const DEADLINE_MARGIN_MS = 5_000
export const PREVIEW_DEADLINE_MS = 5_000
export const PREVIEW_TOO_LONG_WORDS = 'The check took too long; try again.'

/** One solve at a time across the service (walk 3 decision): a second is refused, never queued. */
export const SOLVER_BUSY_WORDS = 'Planning is generating another plan; try again in about 20 seconds.'

export interface PoolOptions {
  readonly maxSolves?: number
  /** A solver child's own RSS at which its solve is stopped (MB). */
  readonly rssLimitMb?: number
  readonly sampleMs?: number
  readonly cancelGraceMs?: number
  readonly cpuCapCores?: number
  /** The child entry (child.ts) and whether children run with --smol. */
  readonly childEntry?: string
  readonly smol?: boolean
  /** The deadlines (tests shorten them). */
  readonly deadlineMarginMs?: number
  readonly previewDeadlineMs?: number
}

/** One finished solve, kept so ops can prove the CPU cap (CPU-ms measured in the solver child). */
export interface SolveRecord {
  readonly id: string; readonly grantedCpuMs: number; readonly wallMs: number; readonly cpuMs: number; readonly evals: number; readonly stoppedBy: EngineResult['stoppedBy']
  /** The solver child's own peak RSS (MB), when it answered; and the time from spawn to its answer. */
  readonly peakRssMb?: number
  readonly spawnToAnswerMs: number
}

export interface SolverPool extends Engine {
  /** Generate's sub-solves, each whole in a child (compile, bounds, search, lane K's check). */
  readonly subSolver: SubSolver
  /** What one more unit of the most limiting resource does (limiting.ts), in a child; null: not computed. */
  readonly limiting: (inputs: PlanInputs, option: Option, candidates: readonly string[]) => Promise<Limiting | null>
  /** A preview in a child (preview.ts): one child at a time, like a solve; `signal` cancels it. */
  readonly preview: (inputs: PlanInputs, option: Option, signal?: AbortSignal) => Promise<PreviewResult>
  readonly active: () => number
  /** The last 100 solves. */
  readonly records: () => readonly SolveRecord[]
  /**
   * For SIGTERM: refuses new solves, cancels every running one and resolves when all have answered (each
   * within about a second); a Generate in flight then keeps the better of its stored and new options.
   */
  readonly shutdown: () => Promise<void>
}

interface Running { readonly rate: number; readonly wallMs: number; readonly startedAt: number; readonly rebudget: (rate: number) => void; readonly stop: () => void; readonly settled: Promise<unknown> }

export const createSolverPool = (options: PoolOptions = {}): SolverPool => {
  const maxSolves = options.maxSolves ?? 1
  const rssLimitMb = options.rssLimitMb ?? CHILD_RSS_LIMIT_MB
  const sampleMs = options.sampleMs ?? 100
  const graceMs = options.cancelGraceMs ?? 1_000
  const cap = options.cpuCapCores ?? SOLVER_CPU_CAP_CORES
  const childEntry = options.childEntry ?? new URL('./child.ts', import.meta.url).pathname
  const smol = options.smol ?? true
  const marginMs = options.deadlineMarginMs ?? DEADLINE_MARGIN_MS
  const previewDeadlineMs = options.previewDeadlineMs ?? PREVIEW_DEADLINE_MS
  const running = new Map<string, Running>()
  const records: SolveRecord[] = []
  let stopping = false
  let next = 0

  /** Admission: refused while shutting down or while the pool is full ('solver_busy', never queued). */
  const admit = (): void => {
    if (stopping) throw planningError(503, 'planning_stopping', 'Planning is shutting down; try again shortly')
    if (running.size >= maxSolves) throw planningError(409, 'solver_busy', SOLVER_BUSY_WORDS)
  }

  /**
   * One child for one job: spawned, sent `request`, and answered once (its answer, a refusal, an error, or no
   * answer). A cancel is answered within `graceMs` or the child is killed; a child that ends without an
   * answer gives `unanswered('ended')`, and so does one still running at `deadlineMs` (it is killed: the slot
   * frees at once). The child is always gone when the job settles.
   */
  const job = <T>(spec: {
    readonly request: (id: string) => ChildRequest
    readonly rate: number
    readonly wallMs: number
    readonly grantedCpuMs: number
    readonly signal: AbortSignal
    /** Wall time from spawn after which the child is killed and the job answers as 'ended'. */
    readonly deadlineMs: number
    readonly stoppedByWho?: () => 'person' | 'host' | undefined
    readonly answer: (message: Extract<ChildResponse, { type: 'result' | 'outcome' | 'preview' | 'limiting' }>) => { readonly value: T; readonly record?: Omit<SolveRecord, 'id' | 'grantedCpuMs' | 'spawnToAnswerMs'> } | { readonly problem: string }
    /** No answer: a value to resolve with, or (preview) a refusal to throw. */
    readonly unanswered: (stoppedBy: 'cancelled' | 'ended', wallMs: number, deadline: boolean) => { readonly value: T; readonly record: Omit<SolveRecord, 'id' | 'grantedCpuMs' | 'spawnToAnswerMs'> } | { readonly refuse: Error }
  }): Promise<T> => {
    const id = `solve-${++next}`
    const startedAt = performance.now()
    let resolveSettled: (value: unknown) => void = () => {}
    const settled = new Promise(resolve => { resolveSettled = resolve })
    return new Promise<T>((resolve, reject) => {
      let done = false
      let grace: ReturnType<typeof setTimeout> | undefined
      let deadline: ReturnType<typeof setTimeout> | undefined
      let stopReason: 'cancelled' | undefined
      const finish = (outcome: () => void, record?: Omit<SolveRecord, 'id' | 'grantedCpuMs' | 'spawnToAnswerMs'>): void => {
        if (done) return
        done = true
        if (grace !== undefined) clearTimeout(grace)
        if (deadline !== undefined) clearTimeout(deadline)
        spec.signal.removeEventListener('abort', onAbort)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        running.delete(id)
        if (record !== undefined) {
          records.push({ id, grantedCpuMs: spec.grantedCpuMs, spawnToAnswerMs: Math.round(performance.now() - startedAt), ...record })
          if (records.length > 100) records.shift()
        }
        resolveSettled(undefined)
        outcome()
      }
      const settle = (answer: { readonly value: T; readonly record?: Omit<SolveRecord, 'id' | 'grantedCpuMs' | 'spawnToAnswerMs'> } | { readonly refuse: Error }): void =>
        'refuse' in answer ? finish(() => reject(answer.refuse)) : finish(() => resolve(answer.value), answer.record)
      const send = (request: ChildRequest): void => { if (!done) child.send(request) }
      const child = Bun.spawn([process.execPath, ...(smol ? ['--smol'] : []), childEntry], {
        stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', serialization: 'json',
        ipc: (message: ChildResponse) => {
          if (message.id !== id) return
          if (message.type === 'error') { finish(() => reject(new Error(`The solver failed: ${message.message}`))); return }
          if (message.type === 'refusal') { finish(() => reject(planningError(message.status, message.code, message.message, message.details === undefined ? undefined : decode(message.details) as Record<string, unknown>))); return }
          const answer = spec.answer(message)
          if ('problem' in answer) { finish(() => reject(new Error(`The solver process answered with an unreadable result: ${answer.problem}`))); return }
          settle(answer)
        },
      })
      void child.exited.then(() => settle(spec.unanswered(stopReason ?? 'ended', performance.now() - startedAt, false)))
      deadline = setTimeout(() => settle(spec.unanswered('ended', performance.now() - startedAt, true)), spec.deadlineMs)
      const stop = (): void => {
        stopReason = 'cancelled'
        const who = spec.stoppedByWho?.()
        send({ type: 'cancel', id, ...(who === undefined ? {} : { who }) })
        grace ??= setTimeout(() => settle(spec.unanswered('cancelled', performance.now() - startedAt, false)), graceMs)
      }
      const onAbort = (): void => stop()
      running.set(id, { rate: spec.rate, wallMs: spec.wallMs, startedAt, stop, settled, rebudget: (lower: number) => send({ type: 'rebudget', id, rate: lower }) })
      spec.signal.addEventListener('abort', onAbort)
      send(spec.request(id))
      if (spec.signal.aborted) stop()
    })
  }

  /** CPU admission: a fair share of the cap per job when several run; the running ones give way. */
  const rateFor = (cpuMs: number, wallMs: number): number => {
    const share = cap / (running.size + 1)
    for (const other of running.values()) if (other.rate > share) other.rebudget(share)
    return Math.min(cpuMs / wallMs, running.size === 0 ? cap : share)
  }

  const solve: Engine['solve'] = async (problem, solveOptions) => {
    admit()
    if (estimateMemoryMb(problem) > solveOptions.budget.memoryMb) {
      throw planningError(413, 'above_certified_size', 'This plan is too large for the certified size', { estimateMb: Math.ceil(estimateMemoryMb(problem)), limitMb: solveOptions.budget.memoryMb })
    }
    const rate = rateFor(solveOptions.budget.cpuMs, solveOptions.budget.wallMs)
    const budget = { ...solveOptions.budget, cpuMs: Math.floor(rate * solveOptions.budget.wallMs) }
    const recordOf = (result: EngineResult) => ({ wallMs: result.wallMs, cpuMs: result.cpuMs, evals: result.evals, stoppedBy: result.stoppedBy })
    return job<EngineResult>({
      request: id => ({ type: 'solve', id, problem: encodeProblem(problem), budget, seed: solveOptions.seed, rssLimitMb, sampleMs, ...(solveOptions.initial === undefined ? {} : { initial: encodeSchedule(solveOptions.initial) }) }),
      rate, wallMs: budget.wallMs, grantedCpuMs: budget.cpuMs, signal: solveOptions.signal, deadlineMs: budget.wallMs + marginMs,
      answer: message => {
        const result = message.type === 'result' ? resultFromWire(message.result) : { problem: 'a search answered with a sub-solve outcome' }
        return 'problem' in result ? result : { value: result, record: { ...recordOf(result), peakRssMb: message.peakRssMb } }
      },
      unanswered: (stoppedBy, wallMs) => { const result: EngineResult = { candidates: [], stoppedBy, evals: 0, cpuMs: 0, wallMs, bounds: [] }; return { value: result, record: recordOf(result) } },
    })
  }

  /**
   * A whole sub-solve of Generate in a child (generate.ts subSolve): the service keeps none of its compile,
   * bounds, search or check memory. The outcome is validated against the plan schema before it is used.
   */
  const subSolver: SubSolver = async (task, signal, stoppedByWho) => {
    admit()
    const rate = rateFor(task.budget.cpuMs, task.budget.wallMs)
    const budget = { ...task.budget, cpuMs: Math.floor(rate * task.budget.wallMs) }
    const runOf = (outcome: SubSolveOutcome) => ('run' in outcome.option.status ? outcome.option.status.run : undefined)
    // Killed by its own budget plus the margin, or by the Generate's deadline if that comes first. The child is
    // told when (`killAt`), so it answers before it, its pessimistic re-timings included.
    const killMs = Math.max(0, Math.min(budget.wallMs + marginMs, (task.deadlineAt ?? Infinity) - Date.now()))
    const killAt = Date.now() + killMs
    return job<SubSolveOutcome>({
      request: id => ({ type: 'subsolve', id, task: encode({ ...task, budget, killAt }), rssLimitMb, sampleMs }),
      rate, wallMs: budget.wallMs, grantedCpuMs: budget.cpuMs, signal, deadlineMs: killMs, ...(stoppedByWho === undefined ? {} : { stoppedByWho }),
      answer: message => {
        const outcome = message.type === 'outcome' ? outcomeFromWire(message.outcome) : { problem: 'a sub-solve answered with a bare search result' }
        if ('problem' in outcome) return outcome
        const run = runOf(outcome)
        return { value: outcome, record: { wallMs: 0, cpuMs: run?.cpuMs ?? 0, evals: run?.evals ?? 0, stoppedBy: run?.stoppedBy ?? 'done', peakRssMb: message.peakRssMb } }
      },
      // No answer: the sub-solve's option says so in its own words (unresolved, the process ended or was cancelled).
      unanswered: (stoppedBy, wallMs) => {
        const who = stoppedBy === 'cancelled' ? stoppedByWho?.() : undefined
        const status = unresolvedStatus({ grid: task.inputs.settings.grid, engine: SOLVER_VERSIONS.engine, formulation: formulationOf(task.inputs.settings.grid), seed: task.seed, budget: { ...budget }, stoppedBy, ...(who === undefined ? {} : { stoppedByWho: who }), evals: 0, cpuMs: 0 })
        // A what-if keeps what it asks (its extra rule, its lead) on this path too, so it is never a plain option.
        const asked = { ...(task.variant.also === undefined ? {} : { also: [...task.variant.also] }), ...(task.variant.lead === undefined ? {} : { lead: task.variant.lead }) }
        const option = { key: task.variant.key, label: task.variant.label.slice(0, 160), inputsRevision: task.revision, variant: { methods: [...task.combo], purchases: [], ...asked }, status, rows: [], metrics: [] }
        return { value: { option, rounded: [], dropped: [] }, record: { wallMs, cpuMs: 0, evals: 0, stoppedBy } }
      },
    })
  }

  /**
   * A preview in a child: no CPU budget (it is a repair, not a search); refused when the pool is busy;
   * cancelled by the request's own signal, and killed at the preview deadline (503, said in planner words).
   */
  const preview = async (inputs: PlanInputs, option: Option, signal: AbortSignal = new AbortController().signal): Promise<PreviewResult> => {
    admit()
    return job<PreviewResult>({
      request: id => ({ type: 'preview', id, task: encode({ inputs, option }), rssLimitMb, sampleMs }),
      rate: 0, wallMs: 0, grantedCpuMs: 0, signal, deadlineMs: previewDeadlineMs,
      answer: message => {
        const result = message.type === 'preview' ? previewFromWire(message.preview) : { problem: 'a preview answered with a solve result' }
        return result !== null && 'problem' in result ? result : { value: result }
      },
      unanswered: (stoppedBy, _wallMs, late) => ({ refuse: planningError(503, 'preview_unavailable', late ? PREVIEW_TOO_LONG_WORDS : stoppedBy === 'ended' ? 'The preview could not be made: the solver process ended. Try again.' : 'The preview was stopped. Try again.') }),
    })
  }

  /** One decode and check per candidate, no search: killed at the preview deadline like a preview. */
  const limiting = async (inputs: PlanInputs, option: Option, candidates: readonly string[]): Promise<Limiting | null> => {
    admit()
    return job<Limiting | null>({
      request: id => ({ type: 'limiting', id, task: encode({ inputs, option, resources: candidates }), rssLimitMb, sampleMs }),
      rate: 0, wallMs: 0, grantedCpuMs: 0, signal: new AbortController().signal, deadlineMs: previewDeadlineMs,
      answer: message => {
        const result = message.type === 'limiting' ? limitingFromWire(message.limiting) : { problem: 'a limiting question answered with another kind of result' }
        return result !== null && 'problem' in result ? result : { value: result }
      },
      // No answer in time (the child hung or ended): not computed, so nothing is said about hours.
      unanswered: (stoppedBy, wallMs) => ({ value: null, record: { wallMs, cpuMs: 0, evals: 0, stoppedBy } }),
    })
  }

  const shutdown = async (): Promise<void> => {
    stopping = true
    const all = [...running.values()]
    for (const entry of all) entry.stop()
    await Promise.all(all.map(entry => entry.settled))
  }
  return { name: SOLVER_VERSIONS.engine, solve, subSolver, preview, limiting, active: () => running.size, records: () => [...records], shutdown }
}
