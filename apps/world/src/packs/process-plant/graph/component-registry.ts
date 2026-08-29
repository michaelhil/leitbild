import type { ComponentDefinition, ComponentKind } from './model.ts'
import { accumulatorComponentDefinitions } from './accumulator-component-definitions.ts'
import { balanceOfPlantComponentDefinitions } from './balance-of-plant-component-definitions.ts'
import { containmentComponentDefinitions } from './containment-component-definitions.ts'
import { heatExchangerComponentDefinitions } from './heat-exchanger-component-definitions.ts'
import { electricalComponentDefinitions } from './electrical-component-definitions.ts'
import { junctionComponentDefinitions } from './junction-component-definitions.ts'
import { pressurizerComponentDefinitions } from './pressurizer-component-definitions.ts'
import { pumpComponentDefinitions } from './pump-component-definitions.ts'
import { reactorComponentDefinitions } from './reactor-component-definitions.ts'
import { steamGeneratorComponentDefinitions } from './steam-generator-component-definitions.ts'

interface ComponentDefinitionModule {
  readonly sourcePath: string
  readonly definitions: ReadonlyArray<ComponentDefinition>
}

export const processPlantComponentDefinitionModules: ReadonlyArray<ComponentDefinitionModule> = [
  { sourcePath: 'src/packs/process-plant/graph/reactor-component-definitions.ts', definitions: reactorComponentDefinitions },
  { sourcePath: 'src/packs/process-plant/graph/junction-component-definitions.ts', definitions: junctionComponentDefinitions },
  { sourcePath: 'src/packs/process-plant/graph/pressurizer-component-definitions.ts', definitions: pressurizerComponentDefinitions },
  { sourcePath: 'src/packs/process-plant/graph/steam-generator-component-definitions.ts', definitions: steamGeneratorComponentDefinitions },
  { sourcePath: 'src/packs/process-plant/graph/pump-component-definitions.ts', definitions: pumpComponentDefinitions },
  { sourcePath: 'src/packs/process-plant/graph/balance-of-plant-component-definitions.ts', definitions: balanceOfPlantComponentDefinitions },
  { sourcePath: 'src/packs/process-plant/graph/heat-exchanger-component-definitions.ts', definitions: heatExchangerComponentDefinitions },
  { sourcePath: 'src/packs/process-plant/graph/containment-component-definitions.ts', definitions: containmentComponentDefinitions },
  { sourcePath: 'src/packs/process-plant/graph/accumulator-component-definitions.ts', definitions: accumulatorComponentDefinitions },
  { sourcePath: 'src/packs/process-plant/graph/electrical-component-definitions.ts', definitions: electricalComponentDefinitions },
]

export const processPlantComponentDefinitions: ReadonlyArray<ComponentDefinition> =
  processPlantComponentDefinitionModules.flatMap(module => module.definitions)

export const processPlantComponentRegistry: ReadonlyMap<ComponentKind, ComponentDefinition> = new Map(
  processPlantComponentDefinitions.map(definition => [definition.kind, definition]),
)

export const processPlantComponentSourcePathByKind: ReadonlyMap<ComponentKind, string> = new Map(
  processPlantComponentDefinitionModules.flatMap(module =>
    module.definitions.map(definition => [definition.kind, module.sourcePath] as const),
  ),
)
