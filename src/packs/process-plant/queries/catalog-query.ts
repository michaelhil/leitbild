import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import { listProcessPlantAssemblyRefs } from '../assembly/catalog.ts'
import { listProcessPlantGraphFragmentInstancePresetRefs } from '../assembly/graph-fragment-instance-preset-catalog.ts'
import { listProcessPlantGraphFragmentRefs } from '../assembly/graph-fragment-catalog.ts'
import { listProcessPlantGraphRefs } from '../specs/catalog.ts'
import { listProcessPlantDynamicIcRefPatterns, listProcessPlantIcRefs } from '../specs/ic-catalog.ts'
import { listProcessPlantSurfaceIds } from '../surfaces/catalog.ts'
import { success } from './common.ts'

const catalogListPayloadSchema = z.object({}).strict()

export const processPlantCatalogQueryKinds = [
  'process-plant.catalog.list',
] as const

export const answerProcessPlantCatalogQuery = (config: {
  readonly request: PackQueryRequest
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantCatalogQueryKinds.some(kind => kind === config.request.kind)) return undefined
  catalogListPayloadSchema.parse(config.request.payload ?? {})
  return success(config.request, {
    graphRefs: listProcessPlantGraphRefs(),
    assemblyRefs: listProcessPlantAssemblyRefs(),
    graphFragmentRefs: listProcessPlantGraphFragmentRefs(),
    graphFragmentInstancePresetRefs: listProcessPlantGraphFragmentInstancePresetRefs(),
    icRefs: listProcessPlantIcRefs(),
    dynamicIcRefPatterns: listProcessPlantDynamicIcRefPatterns(),
    surfaceIds: listProcessPlantSurfaceIds(),
  }, config.at)
}
