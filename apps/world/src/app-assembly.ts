import { createCompositePack } from './core/packs/composite.ts'
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

export const createWorldCompositePack = (): WorldPack =>
  createCompositePack({
    id: 'leitbild-control',
    version: '1.0.0',
    name: 'Leitbild Control',
    packs: worldPacks,
  })
