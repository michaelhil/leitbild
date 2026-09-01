import type {
  ComponentBehaviorDefinition,
  ComponentInitialReconciliationDefinition,
} from '../behavior-contract.ts'
import { accumulatorBehaviorDefinitions } from './accumulator-behaviors.ts'
import { balanceOfPlantBehaviorDefinitions } from './balance-of-plant-behaviors.ts'
import { containmentBehaviorDefinitions } from './containment-behaviors.ts'
import { electricalBehaviorDefinitions, electricalInitialReconciliationDefinitions } from './electrical-behaviors.ts'
import { heatExchangerBehaviorDefinitions } from './heat-exchanger-behaviors.ts'
import { junctionBehaviorDefinitions } from './junction-behaviors.ts'
import { pressurizerBehaviorDefinitions } from './pressurizer-behaviors.ts'
import { pumpBehaviorDefinitions, pumpInitialReconciliationDefinitions } from './pump-behaviors.ts'
import { reactorBehaviorDefinitions } from './reactor-behaviors.ts'
import { steamGeneratorBehaviorDefinitions } from './steam-generator-behaviors.ts'

const behaviorDefinitionsByFamily: ReadonlyArray<ComponentBehaviorDefinition> = [
  ...reactorBehaviorDefinitions,
  ...balanceOfPlantBehaviorDefinitions,
  ...heatExchangerBehaviorDefinitions,
  ...containmentBehaviorDefinitions,
  ...accumulatorBehaviorDefinitions,
  ...junctionBehaviorDefinitions,
  ...electricalBehaviorDefinitions,
  ...pumpBehaviorDefinitions,
  ...steamGeneratorBehaviorDefinitions,
  ...pressurizerBehaviorDefinitions,
]

const behaviorDefinitionById = (id: string): ComponentBehaviorDefinition => {
  const behavior = behaviorDefinitionsByFamily.find(definition => definition.id === id)
  if (!behavior) throw new Error(`missing component behavior definition ${id}`)
  return behavior
}

export const componentBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  behaviorDefinitionById('reactor-core-reactivity-control'),
  behaviorDefinitionById('processValve-position-controller'),
  behaviorDefinitionById('steamValve-position-controller'),
  behaviorDefinitionById('processValve-effective-position'),
  behaviorDefinitionById('steamValve-effective-position'),
  behaviorDefinitionById('electrical-grid-source'),
  behaviorDefinitionById('diesel-generator-start-and-power'),
  behaviorDefinitionById('battery-discharge'),
  behaviorDefinitionById('electrical-breaker-propagation'),
  behaviorDefinitionById('electrical-transformer-propagation'),
  behaviorDefinitionById('inverter-propagation'),
  behaviorDefinitionById('electrical-bus-propagation'),
  behaviorDefinitionById('turbine-electrical-output'),
  behaviorDefinitionById('centrifugal-pump-flow'),
  behaviorDefinitionById('centrifugal-pump-primary-loop-inertia'),
  behaviorDefinitionById('reactor-core-heat-to-coolant'),
  behaviorDefinitionById('steam-generator-heat-transfer'),
  behaviorDefinitionById('steam-generator-tube-leak-transfer'),
  behaviorDefinitionById('reactor-core-power-state'),
  behaviorDefinitionById('pressurizer-pressure-inventory-state'),
  behaviorDefinitionById('reactor-vessel-primary-inventory-state'),
  behaviorDefinitionById('process-tank-inventory-state'),
  behaviorDefinitionById('reactor-core-coolant-temperature-state'),
  behaviorDefinitionById('steam-generator-inventory-pressure-state'),
  behaviorDefinitionById('condenser-steam-sink-state'),
  behaviorDefinitionById('heat-exchanger-thermal-transfer'),
  behaviorDefinitionById('containment-lumped-atmosphere-sump'),
  behaviorDefinitionById('accumulator-pressure-driven-discharge'),
  behaviorDefinitionById('processValve-flow-diagnostics'),
  behaviorDefinitionById('steamValve-flow-diagnostics'),
  behaviorDefinitionById('processHeader-mixing-diagnostics'),
  behaviorDefinitionById('steamHeader-mixing-diagnostics'),
  behaviorDefinitionById('electrical-load-service'),
]

export const componentInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  ...pumpInitialReconciliationDefinitions,
  ...electricalInitialReconciliationDefinitions,
]
