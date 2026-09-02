import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import { evaluateProcessPlantAssessments } from '../assessments.ts'
import { processPlantControlWritePayloadSchema } from '../commands.ts'
import { validateProcessPlantControlWrite } from '../control-write-validation.ts'
import { evaluateProcessPlantIcCondition, processPlantIcConditionSchema } from '../runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { requirePlant } from './common.ts'

export const conditionsEvaluateQuerySchema = z.object({
  plantId: idSchema,
  condition: processPlantIcConditionSchema,
}).strict()

export const assessmentsEvaluateQuerySchema = z.object({
  plantId: idSchema,
  assessmentIds: z.array(z.string().min(1)).min(1),
}).strict()

export const processPlantControlQueryKinds = [
  'world.process-plant.conditions.evaluate',
  'world.process-plant.assessments.evaluate',
  'world.process-plant.control.validate',
] as const

export const answerProcessPlantControlQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
}): unknown | undefined => {
  if (!processPlantControlQueryKinds.some(kind => kind === config.request.capabilityId)) return undefined
  if (config.request.capabilityId === 'world.process-plant.conditions.evaluate') {
    const payload = conditionsEvaluateQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    const evaluation = evaluateProcessPlantIcCondition({
      system: system.plant,
      runtime: system.runtime,
      condition: payload.condition,
    })
    return {
      plantId: payload.plantId,
      matches: evaluation.matches,
      signalsRead: evaluation.signalsRead,
    }
  }
  if (config.request.capabilityId === 'world.process-plant.assessments.evaluate') {
    const payload = assessmentsEvaluateQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return {
      plantId: payload.plantId,
      assessments: evaluateProcessPlantAssessments(system, payload.assessmentIds),
    }
  }
  const payload = processPlantControlWritePayloadSchema.parse(config.request.input)
  const system = requirePlant(config.plants, payload.plantId)
  return validateProcessPlantControlWrite({
    system: system.plant,
    runtime: system.runtime,
    ...(system.protection === undefined ? {} : { protection: system.protection }),
    payload,
  })
}
