import { createServer } from './core/api/server.ts'
import { createScenarioRuntimeResolver } from './core/scenarios/runtime-resolver.ts'
import { compileScenarioSource } from './core/scenarios/config.ts'
import { scenarioAuthoringCatalogFor } from './core/scenarios/authoring.ts'
import { createWorldApplicationAssembly } from './app-assembly.ts'
import { createRoutingAdapterFromEnv } from './routing/config.ts'
import { builtinScenarioSources } from './scenarios/sources.ts'
import { createWorldModuleState } from './core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from './core/workspaces/runtime-registry.ts'
import { createConfiguredProcedureSourceService } from './procedure-sources.ts'

const routing = createRoutingAdapterFromEnv()
const assembly = createWorldApplicationAssembly({ routing, env: process.env })
const worldPacks = assembly.packs
const scenarioRuntimeResolver = createScenarioRuntimeResolver({ packs: worldPacks })

const dataDir = process.env.LEITBILD_DATA_DIR ?? 'data'
const workspaceHostUrl = process.env.WORKSPACE_HOST_URL
if (workspaceHostUrl === undefined) {
  throw new Error('WORKSPACE_HOST_URL is required: World is entered through the Workspace Host')
}
const moduleState = createWorldModuleState({ dataDir })
const workspaces = createWorldWorkspaceRuntimeRegistry({
  dataDir,
  moduleState,
  scenarioRuntimeResolver,
  scenarioSources: builtinScenarioSources,
  compileScenarioSource: source => compileScenarioSource(source, worldPacks, { routing }),
  scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(worldPacks),
  runtimeAdapters: assembly.runtimeAdapters,
  procedureSourceService: createConfiguredProcedureSourceService(),
})

const server = createServer({ workspaces, workspaceHostUrl })

console.log(`Leitbild running at http://localhost:${server.port}`)
