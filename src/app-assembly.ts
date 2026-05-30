import { createCompositePack } from './core/packs/composite.ts'
import type { LeitbildPack } from './core/packs/protocol.ts'
import { ambulancePack } from './packs/ambulance/pack.ts'
import { aviationPack } from './packs/aviation/pack.ts'
import { aviationReferenceDatasetBuilders } from './packs/aviation/reference-datasets.ts'
import { electricGridPack } from './packs/electric-grid/pack.ts'
import { electricGridReferenceDatasetBuilders } from './packs/electric-grid/reference-datasets.ts'
import { processPlantPack } from './packs/process-plant/pack.ts'
import { trafficPack } from './packs/traffic/pack.ts'
import { weatherPack } from './packs/weather/pack.ts'

const withReferenceDatasetBuilders = (
  pack: LeitbildPack,
  referenceDatasetBuilders: NonNullable<LeitbildPack['referenceDatasetBuilders']>,
): LeitbildPack => ({
  ...pack,
  referenceDatasetBuilders,
  referenceDatasetIds: pack.referenceDatasetIds ?? referenceDatasetBuilders.map(builder => builder.id),
})

export const leitbildPacks: ReadonlyArray<LeitbildPack> = [
  ambulancePack,
  trafficPack,
  weatherPack,
  processPlantPack,
  withReferenceDatasetBuilders(aviationPack, aviationReferenceDatasetBuilders),
  withReferenceDatasetBuilders(electricGridPack, electricGridReferenceDatasetBuilders),
]

export const createLeitbildControlPack = (): LeitbildPack =>
  createCompositePack({
    id: 'leitbild-control',
    name: 'Leitbild Control',
    packs: leitbildPacks,
  })
