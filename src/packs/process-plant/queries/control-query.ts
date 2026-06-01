import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import { processPlantControlWritePayloadSchema } from '../commands.ts'
import { validateProcessPlantControlWrite } from '../control-write-validation.ts'
import { processSignalTagIdSchema, variablePathSchema, type ProcessQuantity } from '../graph/index.ts'
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

const procedureTagsReadQuerySchema = procedureTagValidateQuerySchema

const procedureCsfEvaluateQuerySchema = z.object({
  systemId: idSchema,
  csfs: z.array(z.string().min(1)).min(1),
}).strict()

export const processPlantControlQueryKinds = [
  'process-plant.conditions.evaluate',
  'process-plant.procedure-csfs.evaluate',
  'process-plant.procedure-tags.read',
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

const normalizeProcedureSourceKey = (value: string): string =>
  value.trim().toLowerCase().replace(/[-_.\s]/g, '')

const normalizeProcedureUnit = (value: string): string =>
  value.trim().toLowerCase().replace(/\s/g, '')

const procedureUnitsCompatible = (procedureUnit: string | undefined, processUnit: string): boolean => {
  if (procedureUnit === undefined) return true
  const normalizedProcedureUnit = normalizeProcedureUnit(procedureUnit)
  const normalizedProcessUnit = normalizeProcedureUnit(processUnit)
  if (normalizedProcedureUnit === normalizedProcessUnit) return true
  if ((normalizedProcedureUnit === 'bool' || normalizedProcedureUnit === 'boolean') && normalizedProcessUnit === 'boolean') return true
  if (normalizedProcedureUnit.startsWith('enum[') && (normalizedProcessUnit === 'boolean' || normalizedProcessUnit === 'fraction' || normalizedProcessUnit === 'percent')) return true
  if (normalizedProcedureUnit === 'degf' && normalizedProcessUnit === 'degc') return true
  if (normalizedProcedureUnit === 'gpm' && normalizedProcessUnit === 'kg/s') return true
  if (normalizedProcedureUnit === 'psig' && (normalizedProcessUnit === 'mpa' || normalizedProcessUnit === 'pa')) return true
  if (normalizedProcedureUnit === 'inhga' && normalizedProcessUnit === 'pa') return true
  if (normalizedProcedureUnit === 'percent_collapsed_liquid' && normalizedProcessUnit === 'percent') return true
  if (normalizedProcedureUnit === 'steps_withdrawn' && normalizedProcessUnit === 'fraction') return true
  if (normalizedProcedureUnit === 'rpm' && normalizedProcessUnit === 'rpm') return true
  if (normalizedProcedureUnit === 'cps' && normalizedProcessUnit === 'cps') return true
  if (normalizedProcedureUnit === 'amps' && normalizedProcessUnit === 'amps') return true
  if (normalizedProcedureUnit === 'volts_dc' && normalizedProcessUnit === 'volts_dc') return true
  return false
}

const formatNumber = (value: number, digits: number): string => {
  if (Number.isInteger(value)) return value.toFixed(0)
  const magnitude = Math.abs(value)
  if (magnitude > 0 && magnitude < 0.001) return value.toExponential(3)
  return value.toFixed(digits)
}

const enumStateFor = (config: {
  readonly procedureUnit: string
  readonly value: number | boolean
}): string | undefined => {
  const options = config.procedureUnit.slice(5, -1).split(',').map(option => option.trim()).filter(Boolean)
  if (options.length === 0) return undefined
  if (typeof config.value === 'boolean') {
    if (options.includes('RUNNING') || options.includes('STOPPED')) return config.value ? 'RUNNING' : 'STOPPED'
    if (options.includes('OPEN') || options.includes('CLOSED')) return config.value ? 'OPEN' : 'CLOSED'
    if (options.includes('ALIGNED') || options.includes('ISOLATED')) return config.value ? 'ALIGNED' : 'ISOLATED'
    if (options.includes('DEPRESSED') || options.includes('NORMAL')) return config.value ? 'DEPRESSED' : 'NORMAL'
    return config.value ? 'TRUE' : 'FALSE'
  }
  const bounded = Math.max(0, Math.min(1, config.value))
  if (options.includes('OPEN') && options.includes('CLOSED')) {
    if (bounded >= 0.95) return 'OPEN'
    if (bounded <= 0.05) return 'CLOSED'
    return options.includes('INTERMEDIATE') ? 'INTERMEDIATE' : `${formatNumber(bounded * 100, 1)} percent`
  }
  if (options.includes('ALIGNED') && options.includes('ISOLATED')) {
    if (bounded >= 0.95) return 'ALIGNED'
    if (bounded <= 0.05) return 'ISOLATED'
    return options.includes('FAULT') ? 'FAULT' : `${formatNumber(bounded * 100, 1)} percent`
  }
  if (options.includes('VENTING') && options.includes('ISOLATED')) {
    if (bounded >= 0.05) return 'VENTING'
    return 'ISOLATED'
  }
  return `${formatNumber(config.value, 3)} ${config.procedureUnit}`
}

const procedureFormattedValue = (config: {
  readonly tagId: string
  readonly procedureUnit: string | undefined
  readonly processQuantity: ProcessQuantity
  readonly processUnit: string
  readonly value: number | boolean
}): { readonly value: number | boolean | string; readonly formatted: string; readonly unit?: string; readonly conversion?: string } => {
  const procedureUnit = config.procedureUnit === undefined ? undefined : normalizeProcedureUnit(config.procedureUnit)
  const outputUnit = config.procedureUnit ?? config.processUnit
  if (procedureUnit?.startsWith('enum[') === true) {
    const state = enumStateFor({
      procedureUnit: config.procedureUnit ?? '',
      value: config.value,
    })
    if (state !== undefined) return { value: state, formatted: state, unit: outputUnit, conversion: `interpreted from ${config.processUnit}` }
  }
  if (typeof config.value !== 'number') {
    return {
      value: config.value,
      formatted: `${String(config.value)} ${outputUnit}`,
      unit: outputUnit,
    }
  }
  if (procedureUnit === 'degf' && config.processUnit === 'degC') {
    const value = config.processQuantity === 'temperatureDelta'
      ? config.value * 9 / 5
      : config.value * 9 / 5 + 32
    return {
      value,
      formatted: `${formatNumber(value, 1)} degF`,
      unit: outputUnit,
      conversion: config.processQuantity === 'temperatureDelta' ? 'converted from degC delta' : 'converted from degC',
    }
  }
  if (procedureUnit === 'gpm' && config.processUnit === 'kg/s') {
    const value = config.value * 15.850323
    return { value, formatted: `${formatNumber(value, 1)} gpm`, unit: outputUnit, conversion: 'converted from kg/s using water density approximation' }
  }
  if (procedureUnit === 'psig' && config.processUnit === 'MPa') {
    const value = config.value * 145.037738 - 14.6959
    return { value, formatted: `${formatNumber(value, 1)} psig`, unit: outputUnit, conversion: 'converted from MPa absolute' }
  }
  if (procedureUnit === 'psig' && config.processUnit === 'Pa') {
    const value = config.value * 0.000145037738 - 14.6959
    return { value, formatted: `${formatNumber(value, 1)} psig`, unit: outputUnit, conversion: 'converted from Pa absolute' }
  }
  if (procedureUnit === 'inhga' && config.processUnit === 'Pa') {
    const value = config.value * 0.000295299875
    return { value, formatted: `${formatNumber(value, 2)} inHgA`, unit: outputUnit, conversion: 'converted from Pa absolute' }
  }
  if (procedureUnit === 'steps_withdrawn' && config.processUnit === 'fraction') {
    const value = Math.max(0, Math.min(1, 1 - config.value)) * 228
    return { value, formatted: `${formatNumber(value, 0)} steps withdrawn`, unit: outputUnit, conversion: 'derived from rod insertion fraction' }
  }
  if (procedureUnit === 'percent_collapsed_liquid' && config.processUnit === 'percent') {
    return { value: config.value, formatted: `${formatNumber(config.value, 1)} percent collapsed liquid`, unit: outputUnit }
  }
  return {
    value: config.value,
    formatted: `${formatNumber(config.value, 3)} ${outputUnit}`,
    unit: outputUnit,
  }
}

const procedureEquipmentCompatible = (config: {
  readonly procedureEquipment: string | undefined
  readonly processEquipment: string | undefined
  readonly resolvedByExternalReference: boolean
}): boolean => {
  if (config.procedureEquipment === undefined || config.processEquipment === undefined) return true
  if (normalizeProcedureSourceKey(config.procedureEquipment) === normalizeProcedureSourceKey(config.processEquipment)) return true
  return config.resolvedByExternalReference
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
    const externalRefs = binding.externalRefs ?? []
    const resolvedByExternalReference = externalRefs.includes(tag.id)
      || (tag.simPath !== undefined && externalRefs.includes(tag.simPath))
    const warnings = [
      ...(tag.simPath !== undefined && tag.simPath !== String(binding.path) && !externalRefs.includes(tag.simPath)
        ? [`sim-path ${tag.simPath} does not match process path ${binding.path}`]
        : []),
      ...(!resolvedByExternalReference && !procedureUnitsCompatible(tag.units, binding.unit)
        ? [`units ${tag.units} do not match process unit ${binding.unit}`]
        : []),
      ...(!procedureEquipmentCompatible({
        procedureEquipment: tag.equipment,
        processEquipment: binding.equipmentId,
        resolvedByExternalReference,
      })
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

const readProcedureTags = (
  system: ProcessPlantSystemRuntime,
  payload: z.infer<typeof procedureTagsReadQuerySchema>,
): unknown => ({
  systemId: payload.systemId,
  tags: payload.tags.map(tag => {
    const binding = findProcessPlantSignalBinding(system.system.graph, { tagId: tag.id })
    if (!binding) {
      return {
        id: tag.id,
        status: 'missing',
      }
    }
    const signal = processPlantSignalView(binding)
    const variable = system.runtime.readVariableSnapshot(binding.path)
    return {
      id: tag.id,
      status: 'resolved',
      signal,
      variable,
      procedureValue: procedureFormattedValue({
        tagId: tag.id,
        procedureUnit: tag.units,
        processQuantity: binding.quantity,
        processUnit: binding.unit,
        value: variable.value,
      }),
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
  if (config.request.kind === 'process-plant.procedure-tags.read') {
    const payload = procedureTagsReadQuerySchema.parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    return success(config.request, readProcedureTags(system, payload), config.at)
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
