import { createServer } from './core/api/server.ts'
import { createControlInstanceRegistry } from './core/control-instances/registry.ts'
import { createLocalAmbulanceSimulationAdapter } from './domains/ambulance/sim/adapter.ts'
import { ambulancePack } from './domains/ambulance/pack.ts'
import { createRoutingAdapterFromEnv } from './routing/config.ts'

const routing = createRoutingAdapterFromEnv()

const registry = createControlInstanceRegistry({
  dataDir: process.env.LEITBILD_DATA_DIR ?? 'data',
  simulationAdapter: createLocalAmbulanceSimulationAdapter({ routing }),
  interactionHandlers: ambulancePack.interactionHandlers ?? [],
})

const server = createServer({ registry })

console.log(`Leitbild running at http://localhost:${server.port}`)
