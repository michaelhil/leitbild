import type { Observable } from '../../../core/observation/model.ts'
import type { ProcessPlantIcSafetyFunctionCondition, ProcessPlantIcStatusTreeNode } from '../runtime/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { findProcessPlantSignalBinding, signalMeasuredOn } from '../signals.ts'
import { safetyFunctionRef } from './derived.ts'

// What decides each critical safety function (plan v5 W4.1, D-E): the
// equipment its status tree's readings are measured on, the one most of them
// are, the first in the Plant's order among equals (a heat sink read on every
// steam generator alike names the first). A press on the function's chip
// opens it. Static: read from the declared trees, never from a Run.

const decidedByPlant = new WeakMap<CompiledProcessPlant, ReadonlyMap<string, string>>()

/** Each safety function's deciding element, by the path its status observable reads at; none where its tree reads nothing. */
export const decidingElements = (plant: CompiledProcessPlant): ReadonlyMap<string, string> => decidedByPlant.get(plant) ?? (() => {
  const graph = plant.graph
  const decided = new Map(plant.automation.safetyFunctions.flatMap(safetyFunction => {
    const readings = new Map<number, number>()
    const read = (condition: ProcessPlantIcSafetyFunctionCondition): void => {
      if (condition.type === 'all' || condition.type === 'any') { for (const child of condition.conditions) read(child); return }
      const references = condition.type === 'comparison' ? [condition.signal] : condition.type === 'total' ? condition.signals : [condition.signal, condition.minus]
      for (const reference of references) {
        const binding = findProcessPlantSignalBinding(graph, reference)
        if (binding === undefined) continue
        const component = signalMeasuredOn(graph, binding.owner).index
        readings.set(component, (readings.get(component) ?? 0) + 1)
      }
    }
    const walk = (node: ProcessPlantIcStatusTreeNode): void => {
      if (!('question' in node)) return
      read(node.condition)
      walk(node.yes)
      walk(node.no)
    }
    walk(safetyFunction.tree)
    const most = [...readings].sort(([left, many], [right, more]) => more - many || left - right)[0]
    return most === undefined ? [] : [[safetyFunctionRef(safetyFunction.id), String(graph.components[most[0]]!.id)] as const]
  }))
  decidedByPlant.set(plant, decided)
  return decided
})()

/** The Plant's observables, each own state its deciding element names declared on it. */
export const withDecidingElements = (plant: CompiledProcessPlant, observables: ReadonlyArray<Observable>): Array<Observable> => {
  const decided = decidingElements(plant)
  return observables.map(observable => {
    const element = decided.get(observable.ref.slice(observable.ref.indexOf('#') + 1))
    return element === undefined ? observable : { ...observable, decidingElement: element }
  })
}
