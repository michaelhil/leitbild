import { z } from 'zod'
import type { PlantGraphSpec, CompiledPlantGraph } from './graph/index.ts'
import type { ProcessPlantProtectionConfig } from './runtime/ic/control-protection-model.ts'
import { assemblePwrReferencePlantGraph } from './assembly/pwr-reference-assembly.ts'
import { pressurizedWaterReactorReferenceIcForGraph } from './specs/reference-ic.ts'
import type {
  ProcessPlantDefinition,
  ProcessPlantAutomationSelection,
  ProcessPlantModelSelection,
  ProcessPlantOperatingPointSelection,
} from './config.ts'

export const processPlantPwrReferenceModelRef = 'process-plant.pwr.reference'
export const processPlantPwrFullPowerOperatingPointRef = 'process-plant.pwr.full-power'
export const processPlantPwrReferenceAutomationRef = 'process-plant.pwr.standard'

const pwrReferenceParametersSchema = z.object({
  loopCount: z.number().int().min(2).max(6),
  title: z.string().min(1).optional(),
}).strict()

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
    throw new Error(`unknown process plant model: ${selection.ref}`)
  }
  return assemblePwrReferencePlantGraph(pwrReferenceParametersSchema.parse(selection.parameters))
}

export const resolveProcessPlantOperatingPoint = (
  selection: ProcessPlantOperatingPointSelection,
  modelRef: string,
): ResolvedProcessPlantOperatingPoint => {
  if (selection.ref !== processPlantPwrFullPowerOperatingPointRef) {
    throw new Error(`unknown process plant operating point: ${selection.ref}`)
  }
  if (modelRef !== processPlantPwrReferenceModelRef) {
    throw new Error(`operating point ${selection.ref} is not compatible with process plant model ${modelRef}`)
  }
  return {
    parameterOverrides: selection.parameterOverrides ?? {},
    valueOverrides: selection.valueOverrides ?? {},
  }
}

export const resolveProcessPlantAutomation = (
  selection: ProcessPlantAutomationSelection,
  modelRef: string,
  graph: CompiledPlantGraph,
): ProcessPlantProtectionConfig => {
  if (selection.ref !== processPlantPwrReferenceAutomationRef) {
    throw new Error(`unknown process plant automation: ${selection.ref}`)
  }
  if (modelRef !== processPlantPwrReferenceModelRef) {
    throw new Error(`automation ${selection.ref} is not compatible with process plant model ${modelRef}`)
  }
  return pressurizedWaterReactorReferenceIcForGraph(graph)
}

export const processPlantDefinitionCatalog = (): ProcessPlantDefinitionCatalogView => ({
  models: [{
    id: processPlantPwrReferenceModelRef,
    title: 'Reference pressurized-water reactor',
    description: 'Validated two- through six-loop PWR training model with coupled primary, secondary, safety, containment, and electrical systems.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['loopCount'],
      properties: {
        loopCount: { type: 'integer', minimum: 2, maximum: 6, title: 'Primary loops' },
        title: { type: 'string', minLength: 1, title: 'Model title' },
      },
    },
  }],
  operatingPoints: [{
    id: processPlantPwrFullPowerOperatingPointRef,
    title: 'Full power',
    description: 'Reference full-power initial condition; sparse component-parameter and variable overrides may tailor an individual Plant.',
    compatibleModelRefs: [processPlantPwrReferenceModelRef],
  }],
  automations: [{
    id: processPlantPwrReferenceAutomationRef,
    title: 'Standard PWR I&C',
    description: 'Graph-derived reference control, protection, alarm, trip, permissive, and interlock configuration.',
    compatibleModelRefs: [processPlantPwrReferenceModelRef],
  }],
})
