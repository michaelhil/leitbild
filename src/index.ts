import { createServer } from './core/api/server.ts'
import { createControlInstanceRegistry } from './core/control-instances/registry.ts'
import { createScenarioCatalog } from './core/scenarios/catalog.ts'
import { createLocalAmbulanceSimulationAdapter } from './packs/ambulance/sim/adapter.ts'
import { ambulancePack } from './packs/ambulance/pack.ts'
import { createLocalTrafficSimulationAdapter } from './packs/traffic/sim/adapter.ts'
import { trafficPack } from './packs/traffic/pack.ts'
import { createRoutingAdapterFromEnv } from './routing/config.ts'
import { createBuiltinScenarios } from './scenarios/index.ts'

const routing = createRoutingAdapterFromEnv()
const packs = [ambulancePack, trafficPack]
const scenarios = await createBuiltinScenarios(routing)
const scenarioCatalog = createScenarioCatalog({ packs, scenarios })

const registry = createControlInstanceRegistry({
  dataDir: process.env.LEITBILD_DATA_DIR ?? 'data',
  scenarioCatalog,
  simulationAdapters: [
    createLocalAmbulanceSimulationAdapter({ routing }),
    createLocalTrafficSimulationAdapter({ routing }),
  ],
  interactionHandlers: packs.flatMap(pack => pack.interactionHandlers ?? []),
})

const server = createServer({ registry })

console.log(`Leitbild running at http://localhost:${server.port}`)
