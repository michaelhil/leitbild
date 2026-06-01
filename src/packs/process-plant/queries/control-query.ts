import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import { processPlantControlWritePayloadSchema } from '../commands.ts'
import { validateProcessPlantControlWrite } from '../control-write-validation.ts'
import { processSignalTagIdSchema, variablePathSchema } from '../graph/index.ts'
import { evaluateProcessPlantIcCondition, processPlantIcConditionSchema, type ProcessPlantIcCondition } from '../runtime/index.ts'
import { findProcessPlantSignalBinding, processPlantSignalView } from '../signals.ts'
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

const procedureCsfEvaluateQuerySchema = z.object({
  systemId: idSchema,
  csfs: z.array(z.string().min(1)).min(1),
}).strict()

export const processPlantControlQueryKinds = [
  'process-plant.conditions.evaluate',
  'process-plant.procedure-csfs.evaluate',
  'process-plant.procedure-tags.validate',
  'process-plant.control.validate',
] as const

const pathCondition = (
  path: string,
  operator: '<' | '<=' | '>' | '>=' | '==' | '!=',
  value: number | boolean,
): ProcessPlantIcCondition => ({
  type: 'comparison',
  signal: { path: variablePathSchema.parse(path) },
  operator,
  value,
})

const allConditions = (conditions: ReadonlyArray<ProcessPlantIcCondition>): ProcessPlantIcCondition => ({
  type: 'all',
  conditions,
})

const anyCondition = (conditions: ReadonlyArray<ProcessPlantIcCondition>): ProcessPlantIcCondition => ({
  type: 'any',
  conditions,
})

const procedureCsfDefinitions: Readonly<Record<string, {
  readonly label: string
  readonly condition: ProcessPlantIcCondition
}>> = {
  subcriticality: {
    label: 'Subcriticality',
    condition: allConditions([
      pathCondition('core.effectiveReactivityPcm', '<', 0),
      pathCondition('core.rodInsertionFraction', '>=', 0.95),
    ]),
  },
  'core-cooling': {
    label: 'Core cooling',
    condition: allConditions([
      pathCondition('core.coreCoolingAvailabilityFraction', '>=', 0.25),
      pathCondition('core.fuelHeatupRateCPerS', '<=', 0.5),
    ]),
  },
  'heat-sink': {
    label: 'Heat sink',
    condition: anyCondition([
      pathCondition('sgA.levelPercent', '>', 25),
      pathCondition('sgB.levelPercent', '>', 25),
      pathCondition('sgC.levelPercent', '>', 25),
      pathCondition('sgD.levelPercent', '>', 25),
    ]),
  },
  'rcs-integrity': {
    label: 'RCS integrity',
    condition: allConditions([
      pathCondition('vessel.primaryLeakFlowKgPerS', '<', 20),
      pathCondition('pressurizer.reliefValvePositionFraction', '<', 0.1),
    ]),
  },
  containment: {
    label: 'Containment',
    condition: allConditions([
      pathCondition('containment.pressureMPa', '<', 0.24),
      pathCondition('containment.radiationSourceTermMSvPerH', '<', 0.5),
    ]),
  },
  'rcs-inventory': {
    label: 'RCS inventory',
    condition: allConditions([
      pathCondition('vessel.primaryCoolantInventoryKg', '>', 240_000),
      pathCondition('pressurizer.levelPercent', '>', 15),
    ]),
  },
}

const validateProcedureTags = (
  system: ProcessPlantSystemRuntime,
  payload: z.infer<typeof procedureTagValidateQuerySchema>,
): unknown => ({
  systemId: payload.systemId,
  tags: payload.tags.map(tag => {
    const binding = findProcessPlantSignalBinding(system.system.graph, { tagId: tag.id })
    if (!binding) {
      return {
        id: tag.id,
        status: 'missing',
        warnings: [],
      }
    }
    const view = processPlantSignalView(binding)
    const warnings = [
      ...(binding.tagId !== tag.id && (binding.externalRefs ?? []).includes(tag.id)
        ? [`procedure tag ${tag.id} resolves through external reference to ${binding.tagId ?? binding.path}`]
        : []),
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

const evaluateProcedureCsfs = (
  system: ProcessPlantSystemRuntime,
  payload: z.infer<typeof procedureCsfEvaluateQuerySchema>,
): unknown => ({
  systemId: payload.systemId,
  csfs: payload.csfs.map(csf => {
    const definition = procedureCsfDefinitions[csf]
    if (!definition) {
      return {
        id: csf,
        label: csf,
        status: 'unknown',
        reason: 'No typed CSF condition is defined for this procedure function.',
        signalsRead: [],
      }
    }
    try {
      const evaluation = evaluateProcessPlantIcCondition({
        system: system.system,
        runtime: system.runtime,
        condition: definition.condition,
      })
      return {
        id: csf,
        label: definition.label,
        status: evaluation.matches ? 'satisfied' : 'challenged',
        signalsRead: evaluation.signalsRead,
      }
    } catch (err) {
      return {
        id: csf,
        label: definition.label,
        status: 'unknown',
        reason: err instanceof Error ? err.message : String(err),
        signalsRead: [],
      }
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
  if (config.request.kind === 'process-plant.procedure-csfs.evaluate') {
    const payload = procedureCsfEvaluateQuerySchema.parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    return success(config.request, evaluateProcedureCsfs(system, payload), config.at)
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
