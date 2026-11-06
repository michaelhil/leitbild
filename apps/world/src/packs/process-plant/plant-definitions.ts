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
import { processPlantIcConfigSchema, type ProcessPlantProtectionConfig } from './runtime/ic/control-protection-model.ts'
import { resolveLd01UnitArtifact } from './engine/artifact.ts'
import { pressurizedWaterReactorReferenceIcForGraph } from './specs/reference-ic.ts'

export const processPlantPwrReferenceModelRef = 'process-plant.pwr.reference'
export const processPlantPwrFullPowerOperatingPointRef = 'process-plant.pwr.full-power'
export const processPlantPwrReferenceAutomationRef = 'process-plant.pwr.standard'
/** The LD-01 unit, run by its native engine from the artifact LD01_UNIT_ARTIFACT names (engine/artifact.ts). */
export const processPlantLd01ModelRef = 'process-plant.ld01'
/** The unit at the S3 settled state its artifact holds. */
export const processPlantLd01SettledOperatingPointRef = 'process-plant.ld01.s3-settled'
/** The unit's own protection, which runs in its kernel (platform design §3 interpretation 1). */
export const processPlantLd01KernelAutomationRef = 'process-plant.ld01.kernel'

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

/**
 * The LD-01 unit's graph, from the native artifact this World runs it on. Without a usable artifact an LD-01
 * Plant is refused, explicitly: it never runs on the TS PWR or anything else instead.
 */
const resolveLd01Model = (selection: ProcessPlantModelSelection): PlantGraphSpec => {
  if (Object.keys(selection.parameters).length > 0) throw new Error(`process plant model ${processPlantLd01ModelRef} takes no parameters: the unit is its artifact`)
  const resolution = resolveLd01UnitArtifact()
  if (!resolution.ok) throw new Error(`an LD-01 Plant is refused: ${resolution.reason}`)
  return resolution.artifact.graph
}

export const resolveProcessPlantModel = (selection: ProcessPlantModelSelection): PlantGraphSpec => {
  if (selection.ref === processPlantLd01ModelRef) return resolveLd01Model(selection)
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
  if (selection.ref === processPlantLd01SettledOperatingPointRef) {
    if (modelRef !== processPlantLd01ModelRef) throw new Error(`operating point ${selection.ref} is not compatible with process plant model ${modelRef}`)
    // The unit starts from its artifact's settled state, whole: nothing overrides a parameter or a value of it.
    if (selection.parameterOverrides !== undefined || selection.valueOverrides !== undefined) throw new Error(`operating point ${selection.ref} takes no overrides: the unit starts from its artifact's S3 settled state`)
    return { parameterOverrides: {}, valueOverrides: {} }
  }
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
  if (selection.ref === processPlantLd01KernelAutomationRef) {
    if (modelRef !== processPlantLd01ModelRef) throw new Error(`automation ${selection.ref} is not compatible with process plant model ${modelRef}`)
    // The unit's protection acts in its kernel, in exact event order with the physics. Its artifact declares the kernel's
    // latches as alarm and trip rules that read only the kernel's latch channels: they annunciate, never decide or act.
    const resolution = resolveLd01UnitArtifact()
    if (!resolution.ok) throw new Error(`an LD-01 Plant is refused: ${resolution.reason}`)
    return resolution.artifact.automation
  }
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
