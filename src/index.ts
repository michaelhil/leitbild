import { createServer } from './core/api/server.ts'
import { createControlInstanceRegistry } from './core/control-instances/registry.ts'
import { createScenarioCatalog } from './core/scenarios/catalog.ts'
import { leitbildPacks } from './app-assembly.ts'
import { createLocalAmbulanceSimulationAdapter } from './packs/ambulance/sim/adapter.ts'
import { createAviationNoopSimulationAdapter } from './packs/aviation/sim/noop-adapter.ts'
import { createOpenSkySimulationAdapter } from './packs/aviation/sim/opensky/adapter.ts'
import type { SimulationAdapter } from './simulation/protocol.ts'
import { createLocalProcessPlantSimulationAdapter } from './packs/process-plant/sim/adapter.ts'
import { createLocalTrafficSimulationAdapter } from './packs/traffic/sim/adapter.ts'
import { createLocalWeatherSimulationAdapter } from './packs/weather/sim/adapter.ts'
import { createRoutingAdapterFromEnv } from './routing/config.ts'
import { createBuiltinScenarios } from './scenarios/index.ts'

const routing = createRoutingAdapterFromEnv()
const scenarios = await createBuiltinScenarios(routing)
const scenarioCatalog = createScenarioCatalog({ packs: leitbildPacks, scenarios })

// OpenSky requires OAuth2 client_credentials. If the operator hasn't provisioned
// them (e.g. local dev, demo machines without an OpenSky account), we skip
// registration rather than crash the server — scenarios that opt into
// aviation.opensky will fail loud at control-instance creation, which is the
// right surface for "you forgot to set up credentials".
const aviationOpenSkyAdapter: SimulationAdapter | null = (() => {
  const clientId = process.env.OPENSKY_CLIENT_ID
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    console.warn('aviation: OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET not set — aviation.opensky provider unavailable')
    return null
  }
  return createOpenSkySimulationAdapter({ clientId, clientSecret })
})()

const registry = createControlInstanceRegistry({
  dataDir: process.env.LEITBILD_DATA_DIR ?? 'data',
  scenarioCatalog,
  simulationAdapters: [
    createLocalAmbulanceSimulationAdapter({ routing }),
    createLocalTrafficSimulationAdapter({ routing }),
    createLocalWeatherSimulationAdapter(),
    createLocalProcessPlantSimulationAdapter(),
    createAviationNoopSimulationAdapter(),
    ...(aviationOpenSkyAdapter ? [aviationOpenSkyAdapter] : []),
  ],
  interactionHandlers: leitbildPacks.flatMap(pack => pack.interactionHandlers ?? []),
})

const server = createServer({ registry })

console.log(`Leitbild running at http://localhost:${server.port}`)
