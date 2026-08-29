import { resolve } from 'node:path'
import { createSuiteCoordinator, parseModuleTargets } from './coordinator.ts'
import { createSuiteWorkspaceDirectory } from './directory.ts'
import { createSuiteServer } from './server.ts'

const moduleTargets = parseModuleTargets([
  ...(process.env.SAMSINN_URL ? [{ moduleId: 'samsinn', baseUrl: process.env.SAMSINN_URL }] : []),
  ...(process.env.LEITBILD_URL ? [{ moduleId: 'leitbild', baseUrl: process.env.LEITBILD_URL }] : []),
])
const suiteHome = resolve(process.env.SUITE_HOME ?? './data/suite')
const coordinator = createSuiteCoordinator({
  directory: createSuiteWorkspaceDirectory(resolve(suiteHome, 'workspaces.json')),
  modules: moduleTargets,
})
const server = createSuiteServer({
  coordinator,
  port: Number(process.env.PORT) || 3100,
  bindHost: process.env.BIND_HOST ?? '0.0.0.0',
})

console.log(`Suite listening on http://${server.hostname}:${server.port}`)
console.log(`Configured Modules: ${moduleTargets.map(target => target.moduleId).join(', ') || '(none)'}`)
