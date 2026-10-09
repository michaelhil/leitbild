import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { COMPOSED_READOUTS_MAX_SIGNALS } from './composition.ts'
import { icTripWatchedPaths } from './ic-thresholds.ts'

// The few values a unit overview leads with, chosen by what the Plant
// declares rather than by name: each signal a trip rule judges on equipment
// outside the loops (a reactor's power, a pressurizer's pressure, a
// containment's pressure; per-loop values stay on their loop's symbols), then
// the first key value of each energy source and sink (a core's outlet
// temperature, a generator's output). Unpublished signals are left out; so
// are writable ones, which would show a demand.

export const overviewKeyValues = (plant: CompiledProcessPlant): ReadonlyArray<VariablePath> => {
  const graph = plant.graph
  const ownerOf = (path: VariablePath) => {
    const binding = graph.signalBindingByPath.get(path)
    return binding?.owner.type === 'component' ? graph.components[binding.owner.componentIndex] : undefined
  }
  const readable = (path: VariablePath): boolean => {
    const binding = graph.signalBindingByPath.get(path)
    return binding !== undefined && !binding.writable && binding.published
  }
  const tripWatched = icTripWatchedPaths(plant).filter(path => {
    const owner = ownerOf(path)
    return owner !== undefined && owner.metadata?.loopId === undefined
  })
  const energyEnds = graph.components
    .filter(component => component.semantics.energy.some(role => role.role === 'source' || role.role === 'sink'))
    .flatMap(component => component.semantics.keyValues.slice(0, 1))
  return [...new Set([...tripWatched, ...energyEnds])].filter(readable).slice(0, COMPOSED_READOUTS_MAX_SIGNALS)
}
