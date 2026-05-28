import { createServer } from './core/api/server.ts'
import { createControlInstanceRegistry } from './core/control-instances/registry.ts'
import { createScenarioCatalog } from './core/scenarios/catalog.ts'
import { leitbildPacks } from './app-assembly.ts'
import { createLocalAmbulancePackRuntimeAdapter } from './packs/ambulance/sim/adapter.ts'
import { createAviationNoopPackRuntimeAdapter } from './packs/aviation/sim/noop-adapter.ts'
import { createOpenSkyPackRuntimeAdapter } from './packs/aviation/sim/opensky/adapter.ts'
import { createVatsimPackRuntimeAdapter } from './packs/aviation/sim/vatsim/adapter.ts'
import { createAviationMultiPackRuntimeAdapter } from './packs/aviation/sim/multi/adapter.ts'
import { createLocalElectricGridPackRuntimeAdapter } from './packs/electric-grid/sim/adapter.ts'
import type { PackRuntimeAdapter } from './simulation/protocol.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from './packs/process-plant/sim/adapter.ts'
import { createLocalTrafficPackRuntimeAdapter } from './packs/traffic/sim/adapter.ts'
import { createLocalWeatherPackRuntimeAdapter } from './packs/weather/sim/adapter.ts'
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
const aviationOpenSkyAdapter: PackRuntimeAdapter | null = (() => {
  const clientId = process.env.OPENSKY_CLIENT_ID
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    console.warn('aviation: OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET not set — aviation.opensky runtime unavailable')
    return null
  }
  return createOpenSkyPackRuntimeAdapter({ clientId, clientSecret })
})()

// VATSIM needs no credentials — register unconditionally.
const aviationVatsimAdapter = createVatsimPackRuntimeAdapter()

// The multi-runtime stitches OpenSky and VATSIM behind one runtime id so a
// Control Instance can swap source at runtime via aviation.set_source. Only
// expose it when at least one underlying source is available, otherwise
// scenarios that depend on it would fail in a more confusing way at start-up.
const aviationMultiAdapter: PackRuntimeAdapter | null = (aviationOpenSkyAdapter || aviationVatsimAdapter)
  ? createAviationMultiPackRuntimeAdapter({
      ...(aviationOpenSkyAdapter ? { opensky: aviationOpenSkyAdapter } : {}),
      vatsim: aviationVatsimAdapter,
      defaultSource: aviationOpenSkyAdapter ? 'opensky' : 'vatsim',
    })
  : null

const registry = createControlInstanceRegistry({
  dataDir: process.env.LEITBILD_DATA_DIR ?? 'data',
  scenarioCatalog,
  runtimeAdapters: [
    createLocalAmbulancePackRuntimeAdapter({ routing }),
    createLocalTrafficPackRuntimeAdapter({ routing }),
    createLocalWeatherPackRuntimeAdapter(),
    createLocalProcessPlantPackRuntimeAdapter(),
    createLocalElectricGridPackRuntimeAdapter(),
    createAviationNoopPackRuntimeAdapter(),
    ...(aviationOpenSkyAdapter ? [aviationOpenSkyAdapter] : []),
    aviationVatsimAdapter,
    ...(aviationMultiAdapter ? [aviationMultiAdapter] : []),
  ],
  interactionHandlers: leitbildPacks.flatMap(pack => pack.interactionHandlers ?? []),
})

const server = createServer({ registry })

console.log(`Leitbild running at http://localhost:${server.port}`)
