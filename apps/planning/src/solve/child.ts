// The solver process: one short-lived Bun child per solve (pool.ts), so its memory goes back to the OS when
// it ends (walk 3, R3-3: a long-lived process kept what its allocator once took). It runs the search for the
// one `solve` it is sent and answers with its candidates as JSON (wire.ts). A `cancel` aborts it; the engine
// yields about every 50 ms, so the answer (with the best plan so far) follows quickly. It watches its own
// RSS and stops with 'memory' above the ceiling it is given. When the pool goes away, so does the child.
import { searchEngine, threadCpuMs } from './search.ts'
import type { EngineBudget, EngineResult } from './problem.ts'
import { decodeProblem, decodeSchedule, resultToWire, type ChildRequest, type ChildResponse } from './wire.ts'

const engine = searchEngine({ pace: true })
let current: { readonly id: string; readonly controller: AbortController; readonly budget: { -readonly [K in keyof EngineBudget]: EngineBudget[K] }; readonly cpu0: number; readonly wall0: number } | undefined

const send = (response: ChildResponse): void => { process.send?.(response) }

process.on('message', async (request: ChildRequest) => {
  if (request.type === 'cancel') { if (current?.id === request.id) current.controller.abort(); return }
  if (request.type === 'rebudget') {
    // The engine reads this budget object on every check, so a lower CPU budget takes effect at once.
    if (current?.id !== request.id) return
    const spent = threadCpuMs() - current.cpu0
    const remainingWall = Math.max(0, current.budget.wallMs - (performance.now() - current.wall0))
    current.budget.cpuMs = Math.min(current.budget.cpuMs, Math.floor(spent + request.rate * remainingWall))
    return
  }
  if (current !== undefined) { send({ type: 'error', id: request.id, message: 'This solver process already runs a solve' }); return }
  const controller = new AbortController()
  const budget = { ...request.budget }
  current = { id: request.id, controller, budget, cpu0: threadCpuMs(), wall0: performance.now() }
  let memory = false, peak = process.memoryUsage.rss()
  const limit = request.rssLimitMb * 1_000_000
  const sampler = setInterval(() => {
    const rss = process.memoryUsage.rss()
    peak = Math.max(peak, rss)
    if (!memory && rss > limit) { memory = true; controller.abort() }
  }, request.sampleMs)
  try {
    const initial = request.initial === undefined ? undefined : decodeSchedule(request.initial)
    const result: EngineResult = await engine.solve(decodeProblem(request.problem), { budget, seed: request.seed, signal: controller.signal, ...(initial === undefined ? {} : { initial }) })
    peak = Math.max(peak, process.memoryUsage.rss())
    send({ type: 'result', id: request.id, result: resultToWire(memory ? { ...result, stoppedBy: 'memory' } : result), peakRssMb: Math.round(peak / 1e5) / 10 })
  } catch (error) {
    send({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) })
  } finally {
    clearInterval(sampler)
  }
})
// The pool ended (or was killed): nothing waits for this solve any more.
process.on('disconnect', () => process.exit(0))
