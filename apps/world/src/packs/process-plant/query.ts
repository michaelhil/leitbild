import type { PackRuntimeQuery, PackRuntimeRecordedHistory } from '../../simulation/protocol.ts'
import type { IsoTimestamp, ObjectId, OperationalObject } from '../../core/model/index.ts'
import { answerProcessPlantIcQuery, processPlantIcQueryKinds } from './ic-query.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import { failure } from './queries/common.ts'
import { answerProcessPlantCatalogQuery, processPlantCatalogQueryKinds } from './queries/catalog-query.ts'
import { answerProcessPlantControlQuery, processPlantControlQueryKinds } from './queries/control-query.ts'
import { answerProcessPlantCredibilityQuery, processPlantCredibilityQueryKinds } from './queries/credibility-query.ts'
import { answerProcessPlantGraphQuery, processPlantGraphQueryKinds } from './queries/graph-query.ts'
import { answerProcessPlantRuntimeQuery, processPlantRuntimeQueryKinds } from './queries/runtime-query.ts'
import { answerProcessPlantSignalQuery, processPlantSignalQueryKinds } from './queries/signal-query.ts'
import { answerProcessPlantVariableQuery, processPlantVariableQueryKinds } from './queries/variable-query.ts'
import { answerProcessPlantObservationQuery } from './observation/query.ts'
import { answerProcessPlantResponseQuery, processPlantResponseQueryKinds } from './queries/response-query.ts'
import { readProcessPlantPlanningSource } from './planning-source.ts'
import { readProcessPlantEngineeringInputs } from './engineering-inputs.ts'

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
  ...processPlantResponseQueryKinds,
] as const

export const answerProcessPlantQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly objects: ReadonlyMap<ObjectId, Pick<OperationalObject, 'id' | 'label'>>
  /** Simulation Run time the Plants have been advanced to; required by time-stamped views. */
  readonly simulationTime?: IsoTimestamp
  /** Series the Run's historian records (empty when it records none): what its observations declare as recorded. */
  readonly recordedSeriesIds?: ReadonlySet<string>
  /** The interval the Run samples them at; absent where it records none. */
  readonly recordingIntervalMs?: number
  /** What the Run's historian holds of them, which observations read their history from. */
  readonly recordedHistory?: PackRuntimeRecordedHistory
}): unknown => {
  const policy = config.request.readPolicy
  if (config.request.capabilityId === 'world.process-plant.engineering-basis') return readProcessPlantEngineeringInputs({ plants: config.plants, policy, input: config.request.input })
  if (config.request.capabilityId === 'world.process-plant.planning-basis') return readProcessPlantPlanningSource({
    plants: config.plants, policy, input: config.request.input,
    ...(config.simulationTime === undefined ? {} : { simulationTime: config.simulationTime }),
  })
  config = !policy.restricted ? config : { ...config,
    plants: new Map([...config.plants].filter(([id]) => policy.canInspect(id))),
    objects: new Map([...config.objects].filter(([id]) => policy.canInspect(id))),
  }
  return answerProcessPlantCatalogQuery(config)
  ?? answerProcessPlantCredibilityQuery(config)
  ?? answerProcessPlantIcQuery(config)
  ?? answerProcessPlantGraphQuery(config)
  ?? answerProcessPlantVariableQuery(config)
  ?? answerProcessPlantSignalQuery(config)
  ?? answerProcessPlantControlQuery(config)
  ?? answerProcessPlantRuntimeQuery(config)
  ?? answerProcessPlantResponseQuery(config)
  ?? answerProcessPlantObservationQuery({
    ...config,
    recording: config.recordedSeriesIds === undefined || config.recordingIntervalMs === undefined ? null : { seriesIds: config.recordedSeriesIds, intervalMs: config.recordingIntervalMs },
  })
  ?? failure(`Process Plant does not support query Capability: ${config.request.capabilityId}`)

}
