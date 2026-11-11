// The solver process: one short-lived Bun child per solve (pool.ts), so its memory goes back to the OS when
// it ends (walk 3, R3-3: a long-lived process kept what its allocator once took). It runs the one job it is
// sent: a search ('solve'), or a whole sub-solve of Generate ('subsolve': compile, bounds, search, lane K's
// check and re-verifications, generate.ts subSolve), and answers as JSON (wire.ts). A `cancel` aborts it; the
// engine yields about every 50 ms, so the answer (with the best plan so far) follows quickly. It watches its
// own RSS and stops with 'memory' above the ceiling it is given. When the pool goes away, so does the child.
import { isPlanningError } from '../errors.ts'
import { subSolve, type SubSolveTask } from './generate.ts'
import { checkForSolver, verifyBoundForSolver, verifyForSolver } from './lane-k-ports.ts'
import { searchEngine, threadCpuMs } from './search.ts'
import type { Engine, EngineBudget, EngineResult } from './problem.ts'
import { decode, decodeProblem, decodeSchedule, encode, resultToWire, type ChildRequest, type ChildResponse } from './wire.ts'

const base = searchEngine({ pace: true })
interface Job { readonly id: string; readonly controller: AbortController; budget: { -readonly [K in keyof EngineBudget]: EngineBudget[K] } | undefined; readonly cpu0: number; readonly wall0: number; who?: 'person' | 'host' }
let current: Job | undefined
let memory = false
// The engine as this child runs it: the search reads the live budget (re-budgeting) and says 'memory' when
// the RSS guard stopped it.
const engine: Engine = {
  name: base.name,
  solve: async (problem, options) => {
    const budget = { ...options.budget }
    if (current !== undefined) current.budget = budget
    const result = await base.solve(problem, { ...options, budget })
    return memory ? { ...result, stoppedBy: 'memory' } : result
  },
}
const run = subSolve({ engine, check: checkForSolver, verify: verifyForSolver, verifyBound: verifyBoundForSolver })

const send = (response: ChildResponse): void => { process.send?.(response) }

process.on('message', async (request: ChildRequest) => {
  if (request.type === 'cancel') { if (current?.id === request.id) { if (request.who !== undefined) current.who = request.who; current.controller.abort() } return }
  if (request.type === 'rebudget') {
    // The engine reads this budget object on every check, so a lower CPU budget takes effect at once.
    if (current?.id !== request.id || current.budget === undefined) return
    const spent = threadCpuMs() - current.cpu0
    const remainingWall = Math.max(0, current.budget.wallMs - (performance.now() - current.wall0))
    current.budget.cpuMs = Math.min(current.budget.cpuMs, Math.floor(spent + request.rate * remainingWall))
    return
  }
  if (current !== undefined) { send({ type: 'error', id: request.id, message: 'This solver process already runs a solve' }); return }
  const controller = new AbortController()
  const job: Job = { id: request.id, controller, budget: undefined, cpu0: threadCpuMs(), wall0: performance.now() }
  current = job
  let peak = process.memoryUsage.rss()
  const limit = request.rssLimitMb * 1_000_000
  const sampler = setInterval(() => {
    const rss = process.memoryUsage.rss()
    peak = Math.max(peak, rss)
    if (!memory && rss > limit) { memory = true; controller.abort() }
  }, request.sampleMs)
  const peakMb = () => Math.round(Math.max(peak, process.memoryUsage.rss()) / 1e5) / 10
  try {
    if (request.type === 'subsolve') {
      const outcome = await run(decode(request.task) as SubSolveTask, controller.signal, () => job.who)
      send({ type: 'outcome', id: request.id, outcome: encode(outcome), peakRssMb: peakMb() })
    } else {
      const initial = request.initial === undefined ? undefined : decodeSchedule(request.initial)
      const result: EngineResult = await engine.solve(decodeProblem(request.problem), { budget: request.budget, seed: request.seed, signal: controller.signal, ...(initial === undefined ? {} : { initial }) })
      send({ type: 'result', id: request.id, result: resultToWire(result), peakRssMb: peakMb() })
    }
  } catch (error) {
    if (isPlanningError(error)) send({ type: 'refusal', id: request.id, status: error.status, code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: encode(error.details) as Record<string, unknown> }) })
    else send({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) })
  } finally {
    clearInterval(sampler)
  }
})
// The pool ended (or was killed): nothing waits for this solve any more.
process.on('disconnect', () => process.exit(0))
