import { createServer } from './core/api/server.ts'
import { createControlInstanceRegistry } from './core/control-instances/registry.ts'
import { createLocalAmbulanceSimulationAdapter } from './domains/ambulance/sim/adapter.ts'
import { ambulancePack } from './domains/ambulance/pack.ts'
import { createLocalTrafficSimulationAdapter } from './domains/traffic/sim/adapter.ts'
import { trafficPack } from './domains/traffic/pack.ts'
import { createRoutingAdapterFromEnv } from './routing/config.ts'

const routing = createRoutingAdapterFromEnv()
const packs = [ambulancePack, trafficPack]

const registry = createControlInstanceRegistry({
  dataDir: process.env.LEITBILD_DATA_DIR ?? 'data',
  simulationAdapters: [
    createLocalAmbulanceSimulationAdapter({ routing }),
    createLocalTrafficSimulationAdapter(),
  ],
  interactionHandlers: packs.flatMap(pack => pack.interactionHandlers ?? []),
})

const server = createServer({ registry })

console.log(`Leitbild running at http://localhost:${server.port}`)
