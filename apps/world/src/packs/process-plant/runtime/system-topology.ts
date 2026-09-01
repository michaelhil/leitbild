import type { CompiledComponent } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'

const uniqueComponentByKind = (
  plant: CompiledProcessPlant,
  kind: string,
): CompiledComponent | null => {
  const matches = plant.graph.components.filter(component => String(component.kind) === kind)
  if (matches.length > 1) {
    throw new Error(`process plant ${plant.id} has multiple ${kind} components; declare explicit coupling before using this behavior`)
  }
  return matches[0] ?? null
}

export const primarySystemPressurizer = (
  plant: CompiledProcessPlant,
): CompiledComponent | null => uniqueComponentByKind(plant, 'pressurizer')

export const primarySystemReactorVessel = (
  plant: CompiledProcessPlant,
): CompiledComponent | null => uniqueComponentByKind(plant, 'reactorVessel')

export const primarySystemReactorCore = (
  plant: CompiledProcessPlant,
): CompiledComponent | null => uniqueComponentByKind(plant, 'reactorCore')
