import { resolve } from 'node:path'
import { createStudyStore } from './study-store.ts'
import { createPlanningService } from './service.ts'
import { createPlanningServer } from './server.ts'
import { createWorldPlanningSources } from './world-source.ts'
import { createPlanningDemos } from './demos.ts'

const hostUrl = process.env.WORKSPACE_HOST_URL
if (!hostUrl) throw new Error('WORKSPACE_HOST_URL is required for published World source operations')
const home = resolve(process.env.LEITBILD_PLANNING_HOME ?? './data')
const sources = createWorldPlanningSources({ hostUrl })
const service = createPlanningService({ store: createStudyStore(home), sources })
const demos = createPlanningDemos({ service, sources, hostUrl })
const server = createPlanningServer({ service, demos, port: Number(process.env.PORT ?? 3102), host: process.env.BIND_HOST ?? '127.0.0.1' })
const stop = () => server.stop(true)
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
console.log(`Planning Module listening on http://${server.hostname}:${server.port}`)
