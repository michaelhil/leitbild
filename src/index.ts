import { createServer } from './core/api/server.ts'
import { createSessionRegistry } from './core/sessions/registry.ts'
import { createLocalAmbulanceSimulationAdapter } from './domains/ambulance/sim/adapter.ts'
import { createRoutingAdapterFromEnv } from './routing/config.ts'

const routing = createRoutingAdapterFromEnv()

const registry = createSessionRegistry({
  dataDir: process.env.LEITBILD_DATA_DIR ?? 'data',
  simulationAdapter: createLocalAmbulanceSimulationAdapter({ routing }),
})

const server = createServer({ registry })

console.log(`Leitbild running at http://localhost:${server.port}`)
