import { createServer } from './core/api/server.ts'
import { createScenarioCatalog } from './core/scenarios/catalog.ts'
import { compileScenarioSource } from './core/scenarios/config.ts'
import { scenarioAuthoringCatalogFor } from './core/scenarios/authoring.ts'
import { createWorldApplicationAssembly } from './app-assembly.ts'
import { createRoutingAdapterFromEnv } from './routing/config.ts'
import { builtinScenarioSources } from './scenarios/index.ts'
import { createWorldModuleState } from './core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from './core/workspaces/runtime-registry.ts'

const routing = createRoutingAdapterFromEnv()
const assembly = createWorldApplicationAssembly({ routing, env: process.env })
const worldPacks = assembly.packs
const scenarios = await Promise.all(builtinScenarioSources.map(source =>
  compileScenarioSource(source, worldPacks, { routing })))
const scenarioCatalog = createScenarioCatalog({ packs: worldPacks, scenarios })

const dataDir = process.env.LEITBILD_DATA_DIR ?? 'data'
const workspaceHostUrl = process.env.WORKSPACE_HOST_URL
if (workspaceHostUrl === undefined) {
  throw new Error('WORKSPACE_HOST_URL is required: World is entered through the Workspace Host')
}
const moduleState = createWorldModuleState({ dataDir })
const workspaces = createWorldWorkspaceRuntimeRegistry({
  dataDir,
  moduleState,
  scenarioCatalog,
  scenarioSources: builtinScenarioSources,
  compileScenarioSource: source => compileScenarioSource(source, worldPacks, { routing }),
  scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(worldPacks),
  runtimeAdapters: assembly.runtimeAdapters,
  interactionHandlers: worldPacks.flatMap(pack => pack.interactions?.handlers ?? []),
})

const server = createServer({ workspaces, workspaceHostUrl })

console.log(`Leitbild running at http://localhost:${server.port}`)
