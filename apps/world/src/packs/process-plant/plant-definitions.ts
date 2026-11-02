import { z } from 'zod'
import { rejectCapabilityInput } from '../../simulation/capability-rejection.ts'
import { assemblePwrReferencePlantGraph,pwrReferenceParametersSchema } from './assembly/pwr-reference-assembly.ts'
import type {
  ProcessPlantAutomationSelection,
  ProcessPlantDefinition,
  ProcessPlantModelSelection,
  ProcessPlantOperatingPointSelection,
} from './config.ts'
import type { CompiledPlantGraph,PlantGraphSpec } from './graph/index.ts'
import { pwrFullPowerParameters } from './assembly/pwr-operating-point.ts'
import type { ProcessPlantProtectionConfig } from './runtime/ic/control-protection-model.ts'
import { pressurizedWaterReactorReferenceIcForGraph } from './specs/reference-ic.ts'

export const processPlantPwrReferenceModelRef = 'process-plant.pwr.reference'
export const processPlantPwrFullPowerOperatingPointRef = 'process-plant.pwr.full-power'
export const processPlantPwrReferenceAutomationRef = 'process-plant.pwr.standard'

export interface ResolvedProcessPlantOperatingPoint {
  readonly parameterOverrides: Readonly<Record<string, unknown>>
  readonly valueOverrides: Readonly<Record<string, unknown>>
}

export interface ProcessPlantDefinitionCatalogView {
  readonly models: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly description: string
    readonly parameters: Readonly<Record<string, unknown>>
  }>
  readonly operatingPoints: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly description: string
    readonly compatibleModelRefs: ReadonlyArray<string>
  }>
  readonly automations: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly description: string
    readonly compatibleModelRefs: ReadonlyArray<string>
  }>
}

export const createPwrReferencePlantDefinition = (config: {
  readonly id: string
  readonly loopCount?: number
  readonly title?: string
  readonly parameterOverrides?: Readonly<Record<string, unknown>>
  readonly valueOverrides?: Readonly<Record<string, unknown>>
}): ProcessPlantDefinition => ({
  id: config.id,
  model: {
    ref: processPlantPwrReferenceModelRef,
    parameters: {
      loopCount: config.loopCount ?? 4,
      ...(config.title === undefined ? {} : { title: config.title }),
    },
  },
  operatingPoint: {
    ref: processPlantPwrFullPowerOperatingPointRef,
    ...(config.parameterOverrides === undefined ? {} : { parameterOverrides: config.parameterOverrides }),
    ...(config.valueOverrides === undefined ? {} : { valueOverrides: config.valueOverrides }),
  },
  automation: { ref: processPlantPwrReferenceAutomationRef },
})

export const resolveProcessPlantModel = (selection: ProcessPlantModelSelection): PlantGraphSpec => {
  if (selection.ref !== processPlantPwrReferenceModelRef) {
    return rejectCapabilityInput(`unknown process plant model: ${selection.ref}`)
  }
  return assemblePwrReferencePlantGraph(pwrReferenceParametersSchema.parse(selection.parameters))
}

export const resolveProcessPlantOperatingPoint = (
  selection: ProcessPlantOperatingPointSelection,
  modelRef: string,
  graph: PlantGraphSpec,
): ResolvedProcessPlantOperatingPoint => {
  if (selection.ref !== processPlantPwrFullPowerOperatingPointRef) {
    return rejectCapabilityInput(`unknown process plant operating point: ${selection.ref}`)
  }
  if (modelRef !== processPlantPwrReferenceModelRef) {
    return rejectCapabilityInput(`operating point ${selection.ref} is not compatible with process plant model ${modelRef}`)
  }
  // Operating conditions belong to the selected operating point, not to a
  // scenario or the topology template. Resolve every selected loop by kind.
  const parameterOverrides = pwrFullPowerParameters(graph, selection.parameterOverrides ?? {})
  return {
    parameterOverrides,
    valueOverrides: selection.valueOverrides ?? {},
  }
}

export const resolveProcessPlantAutomation = (
  selection: ProcessPlantAutomationSelection,
  modelRef: string,
  graph: CompiledPlantGraph,
): ProcessPlantProtectionConfig => {
  if (selection.ref !== processPlantPwrReferenceAutomationRef) {
    return rejectCapabilityInput(`unknown process plant automation: ${selection.ref}`)
  }
  if (modelRef !== processPlantPwrReferenceModelRef) {
    return rejectCapabilityInput(`automation ${selection.ref} is not compatible with process plant model ${modelRef}`)
  }
  return pressurizedWaterReactorReferenceIcForGraph(graph)
}

export const processPlantDefinitionCatalog = (): ProcessPlantDefinitionCatalogView => ({
  models: [{
    id: processPlantPwrReferenceModelRef,
    title: 'Reference pressurized-water reactor',
    description: 'Simplified two- through six-loop PWR training model with coupled primary, secondary, safety, containment, and electrical systems. Regression-tested model behavior is not qualification as a plant simulator.',
    parameters: z.toJSONSchema(pwrReferenceParametersSchema),
  }],
  operatingPoints: [{
    id: processPlantPwrFullPowerOperatingPointRef,
    title: 'Full power',
    description: 'Initial reactor power, turbine load and every selected steam-generator flow are 100% of their rated values. Sparse component-parameter and variable overrides may explicitly tailor an individual Plant; this is an initial condition, not a power clamp.',
    compatibleModelRefs: [processPlantPwrReferenceModelRef],
  }],
  automations: [{
    id: processPlantPwrReferenceAutomationRef,
    title: 'Standard PWR I&C',
    description: 'Graph-derived reference control, protection, alarm, trip, permissive, and interlock configuration.',
    compatibleModelRefs: [processPlantPwrReferenceModelRef],
  }],
})
