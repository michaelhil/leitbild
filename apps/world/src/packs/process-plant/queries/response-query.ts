import type { IsoTimestamp } from '../../../core/model/index.ts'
import type { PackRuntimeQuery, PackRuntimeRecordedHistory } from '../../../simulation/protocol.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { evaluateProcessPlantResponse, processPlantResponseQuerySchema } from '../response-evidence.ts'
import { refuseInjectedFaultsIn } from '../signals.ts'
import { requirePlant } from './common.ts'

export const processPlantResponseQueryKinds = ['world.process-plant.response.evaluate'] as const

export const answerProcessPlantResponseQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly simulationTime?: IsoTimestamp
  readonly recordedSeriesIds?: ReadonlySet<string>
  readonly recordingIntervalMs?: number
  readonly recordedHistory?: PackRuntimeRecordedHistory
}): unknown | undefined => {
  if (config.request.capabilityId !== processPlantResponseQueryKinds[0]) return undefined
  const input = processPlantResponseQuerySchema.parse(config.request.input)
  const plant = requirePlant(config.plants, input.targetObjectId)
  refuseInjectedFaultsIn(plant.plant.graph, input.condition)
  refuseInjectedFaultsIn(plant.plant.graph, input.comparisons)
  refuseInjectedFaultsIn(plant.plant.graph, input.afterOperations)
  return evaluateProcessPlantResponse({ ...config, plant, input })
}
