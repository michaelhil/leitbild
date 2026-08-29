import type { PackReferenceDatasetBuilder } from '../../core/packs/protocol.ts'
import { asDatasetId } from '../../reference-data/types.ts'
import { createAeroNorwayDataset } from './datasets/aero-norway.ts'

const aeroNorwayDatasetIdValue = asDatasetId('aero-norway')

export const aviationReferenceDatasetBuilders: ReadonlyArray<PackReferenceDatasetBuilder> = [{
  id: aeroNorwayDatasetIdValue,
  build: (env) => {
    const apiKey = env.OPENAIP_API_KEY
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw new Error('aviation pack: OPENAIP_API_KEY is required to build the aero-norway dataset. Generate one at https://accounts.openaip.net.')
    }
    return createAeroNorwayDataset({ openaipApiKey: apiKey })
  },
}]
