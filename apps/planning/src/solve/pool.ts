// At most two solves at once, each in its own Bun Worker, behind the Engine seam. Budgets are thread CPU
// (within SOLVER_CPU_CAP_CORES together), wall and evaluations. Before a solve its memory is estimated and a plan over
// `budget.memoryMb` is refused; during it the process RSS is sampled every 100 ms and the solve is
// stopped at the RSS limit with stoppedBy 'memory'. A cancel is answered within a second, with the best
// plan found so far, or with no plan if the worker does not answer in time (it is then terminated).
import { planningError } from '../errors.ts'
import { SOLVER_VERSIONS } from './compile.ts'
import type { Engine, EngineResult, NormalizedProblem } from './problem.ts'
import type { WorkerRequest, WorkerResponse } from './worker.ts'

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

export interface PoolOptions {
  readonly maxSolves?: number
  /** Process RSS at which a running solve is stopped (MB). */
  readonly rssLimitMb?: number
  readonly sampleMs?: number
  readonly cancelGraceMs?: number
  readonly cpuCapCores?: number
  readonly workerUrl?: URL
}

/** One finished solve, kept so ops can prove the CPU cap (CPU-ms measured in the worker thread). */
export interface SolveRecord { readonly id: string; readonly grantedCpuMs: number; readonly wallMs: number; readonly cpuMs: number; readonly evals: number; readonly stoppedBy: EngineResult['stoppedBy'] }

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
  const rssLimit = (options.rssLimitMb ?? 220) * 1_000_000
  const sampleMs = options.sampleMs ?? 100
  const graceMs = options.cancelGraceMs ?? 1_000
  const cap = options.cpuCapCores ?? SOLVER_CPU_CAP_CORES
  const workerUrl = options.workerUrl ?? new URL('./worker.ts', import.meta.url)
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
    const worker = new Worker(workerUrl)
    const budget = { ...solveOptions.budget, cpuMs: Math.floor(rate * solveOptions.budget.wallMs) }
    let resolveSettled: (value: unknown) => void = () => {}
    const settled = new Promise(resolve => { resolveSettled = resolve })
    return new Promise<EngineResult>((resolve, reject) => {
      let done = false
      let memory = false
      let grace: ReturnType<typeof setTimeout> | undefined
      const finish = (outcome: () => void, result?: EngineResult): void => {
        if (done) return
        done = true
        clearInterval(sampler)
        if (grace !== undefined) clearTimeout(grace)
        solveOptions.signal.removeEventListener('abort', onAbort)
        worker.terminate()
        running.delete(id)
        if (result !== undefined) {
          records.push({ id, grantedCpuMs: budget.cpuMs, wallMs: result.wallMs, cpuMs: result.cpuMs, evals: result.evals, stoppedBy: result.stoppedBy })
          if (records.length > 100) records.shift()
        }
        resolveSettled(undefined)
        outcome()
      }
      const stop = (): void => {
        worker.postMessage({ type: 'cancel', id } satisfies WorkerRequest)
        grace ??= setTimeout(() => {
          const empty: EngineResult = { candidates: [], stoppedBy: memory ? 'memory' : 'cancelled', evals: 0, cpuMs: 0, wallMs: 0, bounds: [] }
          finish(() => resolve(empty), empty)
        }, graceMs)
      }
      const onAbort = (): void => stop()
      const sampler = setInterval(() => { if (!memory && process.memoryUsage.rss() > rssLimit) { memory = true; stop() } }, sampleMs)
      running.set(id, {
        rate, wallMs: budget.wallMs, startedAt: performance.now(), stop, settled,
        rebudget: (lower: number) => worker.postMessage({ type: 'rebudget', id, rate: lower } satisfies WorkerRequest),
      })
      solveOptions.signal.addEventListener('abort', onAbort)
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data
        if (response.id !== id) return
        if (response.type === 'error') finish(() => reject(new Error(`The solver failed: ${response.message}`)))
        else {
          const result = memory ? { ...response.result, stoppedBy: 'memory' as const } : response.result
          finish(() => resolve(result), result)
        }
      }
      worker.onerror = (event: ErrorEvent) => finish(() => reject(new Error(`The solver worker failed: ${event.message}`)))
      worker.postMessage({ type: 'solve', id, problem, budget, seed: solveOptions.seed, ...(solveOptions.initial === undefined ? {} : { initial: solveOptions.initial }) } satisfies WorkerRequest)
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
