// Bun Worker entry: runs the search for one solve and answers with its candidates. A `cancel` message
// aborts it; the engine yields about every 50 ms, so the answer (with the best plan so far) follows quickly.
import type { EngineBudget, EngineResult, NormalizedProblem, Schedule } from './problem.ts'
import { searchEngine, threadCpuMs } from './search.ts'

export type WorkerRequest =
  | { readonly type: 'solve'; readonly id: string; readonly problem: NormalizedProblem; readonly budget: EngineBudget; readonly seed: number; readonly initial?: Schedule }
  | { readonly type: 'cancel'; readonly id: string }
  /** Lower the CPU budget so that from now on the solve uses at most `rate` cores. */
  | { readonly type: 'rebudget'; readonly id: string; readonly rate: number }
export type WorkerResponse =
  | { readonly type: 'result'; readonly id: string; readonly result: EngineResult }
  | { readonly type: 'error'; readonly id: string; readonly message: string }

declare const self: Worker
const engine = searchEngine({ pace: true })
const running = new Map<string, { readonly controller: AbortController; readonly budget: { -readonly [K in keyof EngineBudget]: EngineBudget[K] }; readonly cpu0: number; readonly wall0: number }>()

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.type === 'cancel') { running.get(request.id)?.controller.abort(); return }
  if (request.type === 'rebudget') {
    // The engine reads this budget object on every check, so a lower CPU budget takes effect at once.
    const entry = running.get(request.id)
    if (entry === undefined) return
    const spent = threadCpuMs() - entry.cpu0
    const remainingWall = Math.max(0, entry.budget.wallMs - (performance.now() - entry.wall0))
    entry.budget.cpuMs = Math.min(entry.budget.cpuMs, Math.floor(spent + request.rate * remainingWall))
    return
  }
  const controller = new AbortController()
  const budget = { ...request.budget }
  running.set(request.id, { controller, budget, cpu0: threadCpuMs(), wall0: performance.now() })
  try {
    const result = await engine.solve(request.problem, { budget, seed: request.seed, signal: controller.signal, ...(request.initial === undefined ? {} : { initial: request.initial }) })
    self.postMessage({ type: 'result', id: request.id, result } satisfies WorkerResponse)
  } catch (error) {
    self.postMessage({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse)
  } finally {
    running.delete(request.id)
  }
}
