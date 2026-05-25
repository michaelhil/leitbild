import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import { processPlantControlWritePayloadSchema } from '../commands.ts'
import { validateProcessPlantControlWrite } from '../control-write-validation.ts'
import { processSignalTagIdSchema } from '../graph/index.ts'
import { evaluateProcessPlantIcCondition, processPlantIcConditionSchema } from '../runtime/index.ts'
import { processPlantSignalView } from '../signals.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { requireSystem, success } from './common.ts'

const conditionsEvaluateQuerySchema = z.object({
  systemId: idSchema,
  condition: processPlantIcConditionSchema,
})

const procedureTagValidateQuerySchema = z.object({
  systemId: idSchema,
  tags: z.array(z.object({
    id: processSignalTagIdSchema,
    description: z.string().min(1).optional(),
    simPath: z.string().min(1).optional(),
    units: z.string().min(1).optional(),
    equipment: z.string().min(1).optional(),
  }).strict()).min(1),
}).strict()

export const processPlantControlQueryKinds = [
  'process-plant.conditions.evaluate',
  'process-plant.procedure-tags.validate',
  'process-plant.control.validate',
] as const

const validateProcedureTags = (
  system: ProcessPlantSystemRuntime,
  payload: z.infer<typeof procedureTagValidateQuerySchema>,
): unknown => ({
  systemId: payload.systemId,
  tags: payload.tags.map(tag => {
    const binding = system.system.graph.signalBindingByTagId.get(tag.id)
    if (!binding) {
      return {
        id: tag.id,
        status: 'missing',
        warnings: [],
      }
    }
    const view = processPlantSignalView(binding)
    const warnings = [
      ...(tag.simPath !== undefined && tag.simPath !== String(binding.path) && !(binding.externalRefs ?? []).includes(tag.simPath)
        ? [`sim-path ${tag.simPath} does not match process path ${binding.path}`]
        : []),
      ...(tag.units !== undefined && tag.units !== binding.unit
        ? [`units ${tag.units} do not match process unit ${binding.unit}`]
        : []),
      ...(tag.equipment !== undefined && binding.equipmentId !== undefined && tag.equipment !== binding.equipmentId
        ? [`equipment ${tag.equipment} does not match process equipment ${binding.equipmentId}`]
        : []),
    ]
    return {
      id: tag.id,
      status: warnings.length === 0 ? 'resolved' : 'resolved-with-warnings',
      signal: view,
      warnings,
    }
  }),
})

export const answerProcessPlantControlQuery = (config: {
  readonly request: PackQueryRequest
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantControlQueryKinds.some(kind => kind === config.request.kind)) return undefined
  if (config.request.kind === 'process-plant.conditions.evaluate') {
    const payload = conditionsEvaluateQuerySchema.parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    const evaluation = evaluateProcessPlantIcCondition({
      system: system.system,
      runtime: system.runtime,
      condition: payload.condition,
    })
    return success(config.request, {
      systemId: payload.systemId,
      matches: evaluation.matches,
      signalsRead: evaluation.signalsRead,
    }, config.at)
  }
  if (config.request.kind === 'process-plant.procedure-tags.validate') {
    const payload = procedureTagValidateQuerySchema.parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    return success(config.request, validateProcedureTags(system, payload), config.at)
  }
  const payload = processPlantControlWritePayloadSchema.parse(config.request.payload)
  const system = requireSystem(config.systems, payload.systemId)
  return success(config.request, validateProcessPlantControlWrite({
    system: system.system,
    runtime: system.runtime,
    ...(system.protection === undefined ? {} : { protection: system.protection }),
    payload,
  }), config.at)
}
