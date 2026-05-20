import type { ScenarioProcessSystemDefinition } from '../../core/model/index.ts'
import { compilePlantGraph, type CompiledPlantGraph } from './graph/index.ts'
import { pwrComponentRegistry } from './graph/index.ts'

export interface CompiledPwrProcessSystem {
  readonly id: string
  readonly componentLibrary: 'pwr-lite'
  readonly graph: CompiledPlantGraph
}

export const compilePwrProcessSystem = (
  definition: ScenarioProcessSystemDefinition,
): CompiledPwrProcessSystem => {
  if (definition.pack !== 'pwr') {
    throw new Error(`PWR process compiler received process system for pack ${definition.pack}`)
  }
  if (definition.componentLibrary !== 'pwr-lite') {
    throw new Error(`unsupported PWR component library: ${definition.componentLibrary}`)
  }
  return {
    id: definition.id,
    componentLibrary: 'pwr-lite',
    graph: compilePlantGraph(definition.graph, pwrComponentRegistry),
  }
}

export const compilePwrProcessSystems = (
  definitions: ReadonlyArray<ScenarioProcessSystemDefinition>,
): ReadonlyArray<CompiledPwrProcessSystem> =>
  definitions
    .filter(definition => definition.pack === 'pwr')
    .map(compilePwrProcessSystem)
