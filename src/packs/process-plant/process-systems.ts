import type { ScenarioProcessSystemDefinition } from '../../core/model/index.ts'
import { compilePlantGraph, type CompiledPlantGraph } from './graph/index.ts'
import { processPlantComponentRegistry } from './graph/index.ts'

export interface CompiledProcessPlantSystem {
  readonly id: string
  readonly componentLibrary: 'process-plant'
  readonly graph: CompiledPlantGraph
}

export const compileProcessPlantSystem = (
  definition: ScenarioProcessSystemDefinition,
): CompiledProcessPlantSystem => {
  if (definition.pack !== 'process-plant') {
    throw new Error(`process plant compiler received process system for pack ${definition.pack}`)
  }
  if (definition.componentLibrary !== 'process-plant') {
    throw new Error(`unsupported process plant component library: ${definition.componentLibrary}`)
  }
  return {
    id: definition.id,
    componentLibrary: 'process-plant',
    graph: compilePlantGraph(definition.graph, processPlantComponentRegistry),
  }
}

export const compileProcessPlantSystems = (
  definitions: ReadonlyArray<ScenarioProcessSystemDefinition>,
): ReadonlyArray<CompiledProcessPlantSystem> =>
  definitions
    .filter(definition => definition.pack === 'process-plant')
    .map(compileProcessPlantSystem)
