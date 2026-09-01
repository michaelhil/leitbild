import type { WorldPack } from './core/packs/protocol.ts'
import { ambulancePack } from './packs/ambulance/pack.ts'
import { aviationPack } from './packs/aviation/pack.ts'
import { aviationReferenceDatasetBuilders } from './packs/aviation/reference-datasets.ts'
import { dronePack } from './packs/drone/pack.ts'
import { electricGridPack } from './packs/electric-grid/pack.ts'
import { electricGridReferenceDatasetBuilders } from './packs/electric-grid/reference-datasets.ts'
import { processPlantPack } from './packs/process-plant/pack.ts'
import { trafficPack } from './packs/traffic/pack.ts'
import { weatherPack } from './packs/weather/pack.ts'
import type { RoutingAdapter } from './routing/protocol.ts'
import type { PackRuntimeAdapter } from './simulation/protocol.ts'
import { validateWorldAssembly } from './core/packs/assembly.ts'
import { createLocalAmbulancePackRuntimeAdapter } from './packs/ambulance/sim/adapter.ts'
import { createOpenSkyPackRuntimeAdapter } from './packs/aviation/sim/opensky/adapter.ts'
import { createVatsimPackRuntimeAdapter } from './packs/aviation/sim/vatsim/adapter.ts'
import { createAviationMultiPackRuntimeAdapter } from './packs/aviation/sim/multi/adapter.ts'
import { createLocalElectricGridPackRuntimeAdapter } from './packs/electric-grid/sim/adapter.ts'
import { createDroneNativePackRuntimeAdapter } from './packs/drone/native/adapter.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from './packs/process-plant/sim/adapter.ts'
import { createLocalTrafficPackRuntimeAdapter } from './packs/traffic/sim/adapter.ts'
import { createLocalWeatherPackRuntimeAdapter } from './packs/weather/sim/adapter.ts'

const withReferenceDatasetBuilders = (
  pack: WorldPack,
  referenceDatasetBuilders: NonNullable<WorldPack['referenceData']>['builders'],
): WorldPack => ({
  ...pack,
  referenceData: {
    builders: referenceDatasetBuilders,
    datasetIds: pack.referenceData?.datasetIds ?? referenceDatasetBuilders.map(builder => builder.id),
  },
})

export const worldPacks: ReadonlyArray<WorldPack> = [
  ambulancePack,
  trafficPack,
  weatherPack,
  dronePack,
  processPlantPack,
  withReferenceDatasetBuilders(aviationPack, aviationReferenceDatasetBuilders),
  withReferenceDatasetBuilders(electricGridPack, electricGridReferenceDatasetBuilders),
]

export interface WorldApplicationAssembly {
  readonly packs: ReadonlyArray<WorldPack>
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
}

export const createWorldApplicationAssembly = (config: {
  readonly routing: RoutingAdapter
  readonly env: Readonly<Record<string, string | undefined>>
}): WorldApplicationAssembly => {
  const opensky = config.env.OPENSKY_CLIENT_ID && config.env.OPENSKY_CLIENT_SECRET
    ? createOpenSkyPackRuntimeAdapter({
        clientId: config.env.OPENSKY_CLIENT_ID,
        clientSecret: config.env.OPENSKY_CLIENT_SECRET,
      })
    : null
  if (!opensky) console.warn('aviation: OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET not set — aviation.opensky runtime unavailable')
  const vatsim = createVatsimPackRuntimeAdapter()
  const aviationMulti = createAviationMultiPackRuntimeAdapter({
    ...(opensky ? { opensky } : {}),
    vatsim,
    defaultSource: opensky ? 'opensky' : 'vatsim',
  })
  const runtimeAdapters: ReadonlyArray<PackRuntimeAdapter> = [
      createLocalAmbulancePackRuntimeAdapter({ routing: config.routing }),
      createLocalTrafficPackRuntimeAdapter({ routing: config.routing }),
      createLocalWeatherPackRuntimeAdapter(),
      createDroneNativePackRuntimeAdapter(),
      createLocalProcessPlantPackRuntimeAdapter(),
      createLocalElectricGridPackRuntimeAdapter(),
      ...(opensky ? [opensky] : []),
      vatsim,
      aviationMulti,
    ]
  return validateWorldAssembly({ packs: worldPacks, runtimeAdapters })
}
