import { resolve } from 'node:path'
import { planningFactsOutputSchema } from '@leitbild/contracts'
import { createPlanningOperations, type SolverPort, type WorldFactsPort } from './api/operations.ts'
import { createRealSolver } from './api/wiring.ts'
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
  runSource: host.runSource,
  read: async (access, run, input, signal) => planningFactsOutputSchema.parse(await host.call(access, 'world.simulation-run.planning-facts', { resource: run, input }, signal)),
}

// The real solver: lane S's pool and Generate, with lane K's checker and re-verifications inside each
// sub-solve's child. It is required: a missing one fails this import or the check below.
const pool = createSolverPool()
const solver: SolverPort = createRealSolver(pool)
if (typeof solver.generate !== 'function') throw new Error('Planning cannot start: the solver is not wired')

const store = createPlanStore(home)
const definitions = createPlanDefinitions()
const operations = createPlanningOperations({ store, world, solver, definitions })
const server = createPlanningServer({ operations, definitions, store, port: Number(process.env.PORT ?? 3102), host: process.env.BIND_HOST ?? '127.0.0.1' })
// A deploy stops running Generates through their signal and the pool, so each keeps its best option, then the server.
const stop = () => { void Promise.allSettled([operations.shutdown(), pool.shutdown()]).finally(() => server.stop(true)) }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
console.log(`Planning Module listening on http://${server.hostname}:${server.port}`)
