import { z } from 'zod'
import { reactorInitialThermalState } from './reactor-initial-conditions.ts'
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

export const pwrReferenceParametersSchema = z.object({
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
  graph: PlantGraphSpec,
): ResolvedProcessPlantOperatingPoint => {
  if (selection.ref !== processPlantPwrFullPowerOperatingPointRef) {
    throw new Error(`unknown process plant operating point: ${selection.ref}`)
  }
  if (modelRef !== processPlantPwrReferenceModelRef) {
    throw new Error(`operating point ${selection.ref} is not compatible with process plant model ${modelRef}`)
  }
  // Operating conditions belong to the selected operating point, not to a
  // scenario or the topology template. Resolve every selected loop by kind.
  const defaults = Object.fromEntries(graph.components.flatMap(component => {
    const parameters = component.kind === 'reactorCore' ? { initialPowerFraction: 1 }
      : component.kind === 'turbineLoadSink' ? { initialLoadFraction: 1 }
      : component.kind === 'steamGenerator' ? { initialSteamFlowFraction: 1 }
      : undefined
    return parameters === undefined ? [] : [[component.id, parameters]]
  }))
  const authored = selection.parameterOverrides ?? {}
  const parameterOverrides = { ...defaults, ...authored }
  for (const [id, initial] of Object.entries(defaults)) {
    if (authored[id] === undefined) continue
    const overlay = z.record(z.string(), z.unknown()).parse(authored[id])
    parameterOverrides[id] = { ...initial, ...overlay }
  }
  for (const component of graph.components.filter(component => component.kind === 'reactorCore')) {
    const overrides = parameterOverrides[component.id] as Record<string, unknown>
    const thermal = reactorInitialThermalState({ ...component.parameters as Record<string, unknown>, ...overrides })
    parameterOverrides[component.id] = {
      referenceCoolantOutletTemperatureC: thermal.outlet,
      referenceFuelTemperatureC: thermal.average,
      ...overrides,
    }
  }
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
