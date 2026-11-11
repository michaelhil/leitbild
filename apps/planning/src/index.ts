import { resolve } from 'node:path'
import { planningFactsOutputSchema } from '@leitbild/contracts'
import { createPlanningOperations, type CheckerPort, type SolverPort, type WorldFactsPort } from './api/operations.ts'
import { createRealSolver, realChecker } from './api/wiring.ts'
import { createSolverPool } from './solve/pool.ts'
import { createPlanDefinitions } from './definitions/index.ts'
import { createPlanningHostClient } from './host-client.ts'
import { createPlanStore } from './plan/store.ts'
import { createPlanningServer } from './server.ts'

const hostUrl = process.env.WORKSPACE_HOST_URL
if (!hostUrl) throw new Error('WORKSPACE_HOST_URL is required: Planning reads World facts through Host')
const home = resolve(process.env.LEITBILD_PLANNING_HOME ?? './data')
const host = createPlanningHostClient({ hostUrl })
const world: WorldFactsPort = {
  read: async (access, run, input, signal) => planningFactsOutputSchema.parse(await host.call(access, 'world.simulation-run.planning-facts', { resource: run, input }, signal)),
}

// The real solver (lane S's Worker pool and Generate) and checker (lane K's re-check). Both are required:
// a missing one fails this import or the check below, and Planning does not start without it.
const pool = createSolverPool()
const solver: SolverPort = createRealSolver(pool)
const checker: CheckerPort = realChecker
for (const [part, port] of [['solver', solver.generate], ['checker', checker.recheck]] as const) {
  if (typeof port !== 'function') throw new Error(`Planning cannot start: the ${part} is not wired`)
}

const store = createPlanStore(home)
const definitions = createPlanDefinitions()
const operations = createPlanningOperations({ store, world, solver, checker, definitions })
const server = createPlanningServer({ operations, definitions, store, port: Number(process.env.PORT ?? 3102), host: process.env.BIND_HOST ?? '127.0.0.1' })
// A deploy stops running Generates through their signal and the pool, so each keeps its best option, then the server.
const stop = () => { void Promise.allSettled([operations.shutdown(), pool.shutdown()]).finally(() => server.stop(true)) }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
console.log(`Planning Module listening on http://${server.hostname}:${server.port}`)
