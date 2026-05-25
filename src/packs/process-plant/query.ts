import type { IsoTimestamp } from '../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import { answerProcessPlantIcQuery, processPlantIcQueryKinds } from './ic-query.ts'
import type { ProcessPlantSystemRuntime } from './system-runtime.ts'
import { failure } from './queries/common.ts'
import { answerProcessPlantControlQuery, processPlantControlQueryKinds } from './queries/control-query.ts'
import { answerProcessPlantGraphQuery, processPlantGraphQueryKinds } from './queries/graph-query.ts'
import { answerProcessPlantRuntimeQuery, processPlantRuntimeQueryKinds } from './queries/runtime-query.ts'
import { answerProcessPlantSignalQuery, processPlantSignalQueryKinds } from './queries/signal-query.ts'
import { answerProcessPlantVariableQuery, processPlantVariableQueryKinds } from './queries/variable-query.ts'

export const processPlantQueryKinds = [
  ...processPlantGraphQueryKinds,
  ...processPlantVariableQueryKinds,
  ...processPlantSignalQueryKinds,
  ...processPlantControlQueryKinds,
  ...processPlantRuntimeQueryKinds,
  ...processPlantIcQueryKinds,
] as const

export const answerProcessPlantQuery = (config: {
  readonly request: PackQueryRequest
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): PackQueryResponse => {
  try {
    return answerProcessPlantIcQuery(config)
      ?? answerProcessPlantGraphQuery(config)
      ?? answerProcessPlantVariableQuery(config)
      ?? answerProcessPlantSignalQuery(config)
      ?? answerProcessPlantControlQuery(config)
      ?? answerProcessPlantRuntimeQuery(config)
      ?? failure(config.request, `process plant pack does not support query kind: ${config.request.kind}`, config.at)
  } catch (err) {
    return failure(config.request, err instanceof Error ? err.message : String(err), config.at)
  }
}
