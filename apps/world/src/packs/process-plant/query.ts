import type { IsoTimestamp } from '../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import { answerProcessPlantIcQuery, processPlantIcQueryKinds } from './ic-query.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import { failure } from './queries/common.ts'
import { answerProcessPlantCatalogQuery, processPlantCatalogQueryKinds } from './queries/catalog-query.ts'
import { answerProcessPlantControlQuery, processPlantControlQueryKinds } from './queries/control-query.ts'
import { answerProcessPlantCredibilityQuery, processPlantCredibilityQueryKinds } from './queries/credibility-query.ts'
import { answerProcessPlantGraphQuery, processPlantGraphQueryKinds } from './queries/graph-query.ts'
import { answerProcessPlantRuntimeQuery, processPlantRuntimeQueryKinds } from './queries/runtime-query.ts'
import { answerProcessPlantSignalQuery, processPlantSignalQueryKinds } from './queries/signal-query.ts'
import { answerProcessPlantDisplayQuery, processPlantDisplayQueryKinds } from './queries/display-query.ts'
import { answerProcessPlantVariableQuery, processPlantVariableQueryKinds } from './queries/variable-query.ts'

export { processPlantCredibilityEvidenceForGraph } from './queries/credibility-query.ts'

export const processPlantQueryKinds = [
  ...processPlantCatalogQueryKinds,
  ...processPlantCredibilityQueryKinds,
  ...processPlantGraphQueryKinds,
  ...processPlantVariableQueryKinds,
  ...processPlantSignalQueryKinds,
  ...processPlantControlQueryKinds,
  ...processPlantRuntimeQueryKinds,
  ...processPlantIcQueryKinds,
  ...processPlantDisplayQueryKinds,
] as const

export const answerProcessPlantQuery = (config: {
  readonly request: PackQueryRequest
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly at: IsoTimestamp
}): PackQueryResponse => {
  try {
    return answerProcessPlantCatalogQuery(config)
      ?? answerProcessPlantCredibilityQuery(config)
      ?? answerProcessPlantIcQuery(config)
      ?? answerProcessPlantGraphQuery(config)
      ?? answerProcessPlantVariableQuery(config)
      ?? answerProcessPlantSignalQuery(config)
      ?? answerProcessPlantControlQuery(config)
      ?? answerProcessPlantRuntimeQuery(config)
      ?? answerProcessPlantDisplayQuery(config)
      ?? failure(config.request, `process plant pack does not support query kind: ${config.request.kind}`, config.at)
  } catch (err) {
    return failure(config.request, err instanceof Error ? err.message : String(err), config.at)
  }
}
