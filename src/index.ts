import { createServer } from './core/api/server.ts'
import { createControlInstanceRegistry } from './core/control-instances/registry.ts'
import { createScenarioCatalog } from './core/scenarios/catalog.ts'
import { leitbildPacks } from './app-assembly.ts'
import { createLocalAmbulanceSimulationAdapter } from './packs/ambulance/sim/adapter.ts'
import { createLocalTrafficSimulationAdapter } from './packs/traffic/sim/adapter.ts'
import { createLocalWeatherSimulationAdapter } from './packs/weather/sim/adapter.ts'
import { createRoutingAdapterFromEnv } from './routing/config.ts'
import { createBuiltinScenarios } from './scenarios/index.ts'

const routing = createRoutingAdapterFromEnv()
const scenarios = await createBuiltinScenarios(routing)
const scenarioCatalog = createScenarioCatalog({ packs: leitbildPacks, scenarios })

const registry = createControlInstanceRegistry({
  dataDir: process.env.LEITBILD_DATA_DIR ?? 'data',
  scenarioCatalog,
  simulationAdapters: [
    createLocalAmbulanceSimulationAdapter({ routing }),
    createLocalTrafficSimulationAdapter({ routing }),
    createLocalWeatherSimulationAdapter(),
  ],
  interactionHandlers: leitbildPacks.flatMap(pack => pack.interactionHandlers ?? []),
})

const server = createServer({ registry })

console.log(`Leitbild running at http://localhost:${server.port}`)
