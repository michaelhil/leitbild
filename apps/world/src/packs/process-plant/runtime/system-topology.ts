import type { CompiledComponent } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'

const uniqueComponentByKind = (
  system: CompiledProcessPlantSystem,
  kind: string,
): CompiledComponent | null => {
  const matches = system.graph.components.filter(component => String(component.kind) === kind)
  if (matches.length > 1) {
    throw new Error(`process plant system ${system.id} has multiple ${kind} components; declare explicit coupling before using this behavior`)
  }
  return matches[0] ?? null
}

export const primarySystemPressurizer = (
  system: CompiledProcessPlantSystem,
): CompiledComponent | null => uniqueComponentByKind(system, 'pressurizer')

export const primarySystemReactorVessel = (
  system: CompiledProcessPlantSystem,
): CompiledComponent | null => uniqueComponentByKind(system, 'reactorVessel')

export const primarySystemReactorCore = (
  system: CompiledProcessPlantSystem,
): CompiledComponent | null => uniqueComponentByKind(system, 'reactorCore')
