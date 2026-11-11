// At most two solves at once, each in its own Bun Worker, behind the Engine seam. Budgets are thread CPU
// (half each when two run), wall and evaluations. Before a solve its memory is estimated and a plan over
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

export interface PoolOptions {
  readonly maxSolves?: number
  /** Process RSS at which a running solve is stopped (MB). */
  readonly rssLimitMb?: number
  readonly sampleMs?: number
  readonly cancelGraceMs?: number
  readonly workerUrl?: URL
}

export interface SolverPool extends Engine {
  readonly active: () => number
}

export const createSolverPool = (options: PoolOptions = {}): SolverPool => {
  const maxSolves = options.maxSolves ?? 2
  const rssLimit = (options.rssLimitMb ?? 220) * 1_000_000
  const sampleMs = options.sampleMs ?? 100
  const graceMs = options.cancelGraceMs ?? 1_000
  const workerUrl = options.workerUrl ?? new URL('./worker.ts', import.meta.url)
  let active = 0
  let next = 0
  const solve: Engine['solve'] = (problem, solveOptions) => {
    if (active >= maxSolves) return Promise.reject(planningError(503, 'planning_busy', 'Two plans are being generated; try again when one finishes'))
    if (estimateMemoryMb(problem) > solveOptions.budget.memoryMb) {
      return Promise.reject(planningError(413, 'above_certified_size', 'This plan is too large for the certified size', { estimateMb: Math.ceil(estimateMemoryMb(problem)), limitMb: solveOptions.budget.memoryMb }))
    }
    const sharing = active > 0
    active++
    const id = `solve-${++next}`
    const worker = new Worker(workerUrl)
    const budget = { ...solveOptions.budget, cpuMs: sharing ? solveOptions.budget.cpuMs / 2 : solveOptions.budget.cpuMs }
    return new Promise<EngineResult>((resolve, reject) => {
      let settled = false
      let memory = false
      let grace: ReturnType<typeof setTimeout> | undefined
      const finish = (outcome: () => void): void => {
        if (settled) return
        settled = true
        clearInterval(sampler)
        if (grace !== undefined) clearTimeout(grace)
        solveOptions.signal.removeEventListener('abort', onAbort)
        worker.terminate()
        active--
        outcome()
      }
      const stop = (): void => {
        worker.postMessage({ type: 'cancel', id } satisfies WorkerRequest)
        grace ??= setTimeout(() => finish(() => resolve({ candidates: [], stoppedBy: memory ? 'memory' : 'cancelled', evals: 0, cpuMs: 0, wallMs: 0, bounds: [] })), graceMs)
      }
      const onAbort = (): void => stop()
      const sampler = setInterval(() => { if (!memory && process.memoryUsage.rss() > rssLimit) { memory = true; stop() } }, sampleMs)
      solveOptions.signal.addEventListener('abort', onAbort)
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data
        if (response.id !== id) return
        if (response.type === 'error') finish(() => reject(new Error(`The solver failed: ${response.message}`)))
        else finish(() => resolve(memory ? { ...response.result, stoppedBy: 'memory' } : response.result))
      }
      worker.onerror = (event: ErrorEvent) => finish(() => reject(new Error(`The solver worker failed: ${event.message}`)))
      worker.postMessage({ type: 'solve', id, problem, budget, seed: solveOptions.seed, ...(solveOptions.initial === undefined ? {} : { initial: solveOptions.initial }) } satisfies WorkerRequest)
      if (solveOptions.signal.aborted) stop()
    })
  }
  return { name: SOLVER_VERSIONS.engine, solve, active: () => active }
}
