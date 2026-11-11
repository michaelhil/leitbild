// At most two solves at once, each in its own short-lived Bun child process (child.ts), behind the Engine
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
import { encodeProblem, encodeSchedule, resultFromWire, type ChildRequest, type ChildResponse } from './wire.ts'

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
 * A solver child's own RSS ceiling (MB). Measured on macOS: a child peaks at 84-93 MB on the flagship and
 * 97 MB on or's S33v3, so 110 MB lets a certified-size solve finish. The service levels off near 200 MB, so
 * service plus one child (about 300 MB) is still above the unit's 256 MB MemoryMax: an open decision, and the
 * Linux proof is the Release A ops gate.
 */
export const CHILD_RSS_LIMIT_MB = 110

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
}

/** One finished solve, kept so ops can prove the CPU cap (CPU-ms measured in the solver child). */
export interface SolveRecord {
  readonly id: string; readonly grantedCpuMs: number; readonly wallMs: number; readonly cpuMs: number; readonly evals: number; readonly stoppedBy: EngineResult['stoppedBy']
  /** The solver child's own peak RSS (MB), when it answered; and the time from spawn to its answer. */
  readonly peakRssMb?: number
  readonly spawnToAnswerMs: number
}

export interface SolverPool extends Engine {
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
  const maxSolves = options.maxSolves ?? 2
  const rssLimitMb = options.rssLimitMb ?? CHILD_RSS_LIMIT_MB
  const sampleMs = options.sampleMs ?? 100
  const graceMs = options.cancelGraceMs ?? 1_000
  const cap = options.cpuCapCores ?? SOLVER_CPU_CAP_CORES
  const childEntry = options.childEntry ?? new URL('./child.ts', import.meta.url).pathname
  const smol = options.smol ?? true
  const running = new Map<string, Running>()
  const records: SolveRecord[] = []
  let stopping = false
  let next = 0
  const solve: Engine['solve'] = (problem, solveOptions) => {
    if (stopping) return Promise.reject(planningError(503, 'planning_stopping', 'Planning is shutting down; try again shortly'))
    if (running.size >= maxSolves) return Promise.reject(planningError(503, 'planning_busy', 'Two plans are being generated; try again when one finishes'))
    if (estimateMemoryMb(problem) > solveOptions.budget.memoryMb) {
      return Promise.reject(planningError(413, 'above_certified_size', 'This plan is too large for the certified size', { estimateMb: Math.ceil(estimateMemoryMb(problem)), limitMb: solveOptions.budget.memoryMb }))
    }
    // CPU admission: a fair share of the cap per solve when several run; the running ones give way.
    const share = cap / (running.size + 1)
    for (const other of running.values()) if (other.rate > share) other.rebudget(share)
    const requested = solveOptions.budget.cpuMs / solveOptions.budget.wallMs
    const rate = Math.min(requested, running.size === 0 ? cap : share)
    const id = `solve-${++next}`
    const budget = { ...solveOptions.budget, cpuMs: Math.floor(rate * solveOptions.budget.wallMs) }
    const startedAt = performance.now()
    let resolveSettled: (value: unknown) => void = () => {}
    const settled = new Promise(resolve => { resolveSettled = resolve })
    return new Promise<EngineResult>((resolve, reject) => {
      let done = false
      let grace: ReturnType<typeof setTimeout> | undefined
      let stopReason: 'cancelled' | undefined
      const finish = (outcome: () => void, result?: EngineResult, peakRssMb?: number): void => {
        if (done) return
        done = true
        if (grace !== undefined) clearTimeout(grace)
        solveOptions.signal.removeEventListener('abort', onAbort)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        running.delete(id)
        if (result !== undefined) {
          records.push({ id, grantedCpuMs: budget.cpuMs, wallMs: result.wallMs, cpuMs: result.cpuMs, evals: result.evals, stoppedBy: result.stoppedBy, spawnToAnswerMs: Math.round(performance.now() - startedAt), ...(peakRssMb === undefined ? {} : { peakRssMb }) })
          if (records.length > 100) records.shift()
        }
        resolveSettled(undefined)
        outcome()
      }
      /** No answer: the child was killed after a cancel, or ended on its own ('ended', said as such). */
      const unanswered = (stoppedBy: EngineResult['stoppedBy']): EngineResult => ({ candidates: [], stoppedBy, evals: 0, cpuMs: 0, wallMs: performance.now() - startedAt, bounds: [] })
      const send = (request: ChildRequest): void => { if (!done) child.send(request) }
      const child = Bun.spawn([process.execPath, ...(smol ? ['--smol'] : []), childEntry], {
        stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', serialization: 'json',
        ipc: (message: ChildResponse) => {
          if (message.id !== id) return
          if (message.type === 'error') { finish(() => reject(new Error(`The solver failed: ${message.message}`))); return }
          const result = resultFromWire(message.result)
          if ('problem' in result) { finish(() => reject(new Error(`The solver process answered with an unreadable result: ${result.problem}`))); return }
          finish(() => resolve(result), result, message.peakRssMb)
        },
      })
      void child.exited.then(() => {
        const result = unanswered(stopReason ?? 'ended')
        finish(() => resolve(result), result)
      })
      const stop = (): void => {
        stopReason = 'cancelled'
        send({ type: 'cancel', id })
        grace ??= setTimeout(() => { const result = unanswered('cancelled'); finish(() => resolve(result), result) }, graceMs)
      }
      const onAbort = (): void => stop()
      running.set(id, { rate, wallMs: budget.wallMs, startedAt, stop, settled, rebudget: (lower: number) => send({ type: 'rebudget', id, rate: lower }) })
      solveOptions.signal.addEventListener('abort', onAbort)
      send({ type: 'solve', id, problem: encodeProblem(problem), budget, seed: solveOptions.seed, rssLimitMb, sampleMs, ...(solveOptions.initial === undefined ? {} : { initial: encodeSchedule(solveOptions.initial) }) })
      if (solveOptions.signal.aborted) stop()
    })
  }
  const shutdown = async (): Promise<void> => {
    stopping = true
    const all = [...running.values()]
    for (const entry of all) entry.stop()
    await Promise.all(all.map(entry => entry.settled))
  }
  return { name: SOLVER_VERSIONS.engine, solve, active: () => running.size, records: () => [...records], shutdown }
}
