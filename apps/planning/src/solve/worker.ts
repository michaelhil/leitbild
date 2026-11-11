// Bun Worker entry: runs the search for one solve and answers with its candidates. A `cancel` message
// aborts it; the engine yields about every 50 ms, so the answer (with the best plan so far) follows quickly.
import type { EngineBudget, EngineResult, NormalizedProblem, Schedule } from './problem.ts'
import { searchEngine } from './search.ts'

export type WorkerRequest =
  | { readonly type: 'solve'; readonly id: string; readonly problem: NormalizedProblem; readonly budget: EngineBudget; readonly seed: number; readonly initial?: Schedule }
  | { readonly type: 'cancel'; readonly id: string }
export type WorkerResponse =
  | { readonly type: 'result'; readonly id: string; readonly result: EngineResult }
  | { readonly type: 'error'; readonly id: string; readonly message: string }

declare const self: Worker
const engine = searchEngine()
const running = new Map<string, AbortController>()

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.type === 'cancel') { running.get(request.id)?.abort(); return }
  const controller = new AbortController()
  running.set(request.id, controller)
  try {
    const result = await engine.solve(request.problem, { budget: request.budget, seed: request.seed, signal: controller.signal, ...(request.initial === undefined ? {} : { initial: request.initial }) })
    self.postMessage({ type: 'result', id: request.id, result } satisfies WorkerResponse)
  } catch (error) {
    self.postMessage({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse)
  } finally {
    running.delete(request.id)
  }
}
