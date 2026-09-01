import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import { evaluateProcessPlantAssessments } from '../assessments.ts'
import { processPlantControlWritePayloadSchema } from '../commands.ts'
import { validateProcessPlantControlWrite } from '../control-write-validation.ts'
import { evaluateProcessPlantIcCondition, processPlantIcConditionSchema } from '../runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { requirePlant, success } from './common.ts'

const conditionsEvaluateQuerySchema = z.object({
  plantId: idSchema,
  condition: processPlantIcConditionSchema,
}).strict()

const assessmentsEvaluateQuerySchema = z.object({
  plantId: idSchema,
  assessmentIds: z.array(z.string().min(1)).min(1),
}).strict()

export const processPlantControlQueryKinds = [
  'process-plant.conditions.evaluate',
  'process-plant.assessments.evaluate',
  'process-plant.control.validate',
] as const

export const answerProcessPlantControlQuery = (config: {
  readonly request: PackQueryRequest
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantControlQueryKinds.some(kind => kind === config.request.kind)) return undefined
  if (config.request.kind === 'process-plant.conditions.evaluate') {
    const payload = conditionsEvaluateQuerySchema.parse(config.request.payload)
    const system = requirePlant(config.plants, payload.plantId)
    const evaluation = evaluateProcessPlantIcCondition({
      system: system.plant,
      runtime: system.runtime,
      condition: payload.condition,
    })
    return success(config.request, {
      plantId: payload.plantId,
      matches: evaluation.matches,
      signalsRead: evaluation.signalsRead,
    }, config.at)
  }
  if (config.request.kind === 'process-plant.assessments.evaluate') {
    const payload = assessmentsEvaluateQuerySchema.parse(config.request.payload)
    const system = requirePlant(config.plants, payload.plantId)
    return success(config.request, {
      plantId: payload.plantId,
      assessments: evaluateProcessPlantAssessments(system, payload.assessmentIds),
    }, config.at)
  }
  const payload = processPlantControlWritePayloadSchema.parse(config.request.payload)
  const system = requirePlant(config.plants, payload.plantId)
  return success(config.request, validateProcessPlantControlWrite({
    system: system.plant,
    runtime: system.runtime,
    ...(system.protection === undefined ? {} : { protection: system.protection }),
    payload,
  }), config.at)
}
