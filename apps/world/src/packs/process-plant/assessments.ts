import { variablePathSchema } from './graph/index.ts'
import {
  evaluateProcessPlantIcCondition,
  type ProcessPlantIcCondition,
} from './runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'

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

const all = (conditions: ReadonlyArray<ProcessPlantIcCondition>): ProcessPlantIcCondition => ({ type: 'all', conditions })
const any = (conditions: ReadonlyArray<ProcessPlantIcCondition>): ProcessPlantIcCondition => ({ type: 'any', conditions })

interface ProcessPlantAssessmentDefinition {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly condition: (plant: ProcessPlantRuntimeInstance) => ProcessPlantIcCondition
}

const assessmentDefinitions: ReadonlyArray<ProcessPlantAssessmentDefinition> = [
  {
    id: 'subcriticality',
    title: 'Subcriticality',
    description: 'The reactor is shutdown with negative effective reactivity and substantially inserted rods.',
    condition: () => all([
      pathCondition('core.effectiveReactivityPcm', '<', 0),
      pathCondition('core.rodInsertionFraction', '>=', 0.95),
    ]),
  },
  {
    id: 'core-cooling',
    title: 'Core cooling',
    description: 'Core cooling availability is adequate and fuel heat-up is controlled.',
    condition: () => all([
      pathCondition('core.coreCoolingAvailabilityFraction', '>=', 0.25),
      pathCondition('core.fuelHeatupRateCPerS', '<=', 0.5),
    ]),
  },
  {
    id: 'heat-sink',
    title: 'Heat sink',
    description: 'At least one model-discovered steam generator retains adequate level.',
    condition: plant => {
      const steamGenerators = plant.plant.graph.components.filter(component => component.metadata?.equipmentClass === 'steam-generator')
      if (steamGenerators.length === 0) throw new Error('heat-sink assessment requires at least one steam generator')
      return any(steamGenerators.map(component => pathCondition(`${component.id}.levelPercent`, '>', 25)))
    },
  },
  {
    id: 'rcs-integrity',
    title: 'RCS integrity',
    description: 'Primary leakage and pressurizer relief flow remain controlled.',
    condition: () => all([
      pathCondition('vessel.primaryLeakFlowKgPerS', '<', 20),
      pathCondition('pressurizer.reliefValvePositionFraction', '<', 0.1),
    ]),
  },
  {
    id: 'containment',
    title: 'Containment',
    description: 'Containment pressure and radiological source term remain controlled.',
    condition: () => all([
      pathCondition('containment.pressureMPa', '<', 0.24),
      pathCondition('containment.radiationSourceTermMSvPerH', '<', 0.5),
    ]),
  },
  {
    id: 'rcs-inventory',
    title: 'RCS inventory',
    description: 'Primary coolant inventory and pressurizer level remain adequate.',
    condition: () => all([
      pathCondition('vessel.primaryCoolantInventoryKg', '>', 240_000),
      pathCondition('pressurizer.levelPercent', '>', 15),
    ]),
  },
]

const assessmentById = new Map(assessmentDefinitions.map(definition => [definition.id, definition]))

export const processPlantAssessmentCatalog = (): ReadonlyArray<Record<string, unknown>> =>
  assessmentDefinitions.map(({ id, title, description }) => ({ id, title, description }))

export const evaluateProcessPlantAssessments = (
  plant: ProcessPlantRuntimeInstance,
  assessmentIds: ReadonlyArray<string>,
): ReadonlyArray<Record<string, unknown>> => assessmentIds.map(id => {
  const definition = assessmentById.get(id)
  if (definition === undefined) return { id, title: id, status: 'unknown', reason: 'Unknown assessment.', signalsRead: [] }
  try {
    const result = evaluateProcessPlantIcCondition({
      system: plant.plant,
      runtime: plant.runtime,
      condition: definition.condition(plant),
    })
    return {
      id,
      title: definition.title,
      status: result.matches ? 'satisfied' : 'challenged',
      signalsRead: result.signalsRead,
    }
  } catch (err) {
    return {
      id,
      title: definition.title,
      status: 'unknown',
      reason: err instanceof Error ? err.message : String(err),
      signalsRead: [],
    }
  }
})
