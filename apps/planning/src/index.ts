import { resolve } from 'node:path'
import { planningFactsOutputSchema } from '@leitbild/contracts'
import { createPlanningOperations, type CheckerPort, type SolverPort, type WorldFactsPort } from './api/operations.ts'
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

// The solver (lane S: solve/generate.ts and the Worker pool) and the checker (lane K: check/check.ts) land
// in parallel with this lane. Integration wires their exports here; until then Planning refuses to start
// rather than run without them.
const unwired = (part: string): never => { throw new Error(`Planning cannot start: the ${part} is not wired yet (increment 1 integration)`) }
const solver: SolverPort = unwired('solver')
const checker: CheckerPort = unwired('checker')

const store = createPlanStore(home)
const definitions = createPlanDefinitions()
const operations = createPlanningOperations({ store, world, solver, checker, definitions })
const server = createPlanningServer({ operations, definitions, store, port: Number(process.env.PORT ?? 3102), host: process.env.BIND_HOST ?? '127.0.0.1' })
// A deploy stops running Generates through their signal, so each keeps its best option, then the server.
const stop = () => { void operations.shutdown().finally(() => server.stop(true)) }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
console.log(`Planning Module listening on http://${server.hostname}:${server.port}`)
