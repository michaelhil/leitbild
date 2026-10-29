import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createProcessPlantRuntime, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { processPlantModelDigest, processPlantSourceDigest } from '../src/packs/process-plant/model-identity.ts'
import type { CompiledPlantGraph } from '../src/packs/process-plant/graph/index.ts'

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:identity', loopCount: 4 }))
const source = processPlantSourceDigest(plant.sourceGraph)
const digest = (graph: CompiledPlantGraph): string => processPlantModelDigest(source, graph)

describe('resolved Process Plant model identity', () => {
  test('covers the resolved variable table, including changes without a source graph edit', () => {
    const changed = {
      ...plant.graph,
      variables: plant.graph.variables.map((entry, index) => index === 0
        ? { ...entry, descriptor: { ...entry.descriptor, writable: !entry.descriptor.writable } }
        : entry),
    }
    expect(digest(plant.graph)).toBe(plant.modelDigest)
    expect(digest(changed)).not.toBe(plant.modelDigest)
    expect(digest({ ...plant.graph, variables: [...plant.graph.variables].reverse() })).not.toBe(plant.modelDigest)
    expect(digest({ ...plant.graph, variables: plant.graph.variables.slice(1) })).not.toBe(plant.modelDigest)
  })

  test('includes component defaults, ports and compiled semantic contribution', () => {
    const changed = (replace: (component: CompiledPlantGraph['components'][number]) => CompiledPlantGraph['components'][number]) => ({
      ...plant.graph, components: plant.graph.components.map((component, index) => index === 0 ? replace(component) : component),
    })
    expect(digest(changed(component => ({ ...component, parameters: { ...(component.parameters as object), changedDefault: 1 } })))).not.toBe(plant.modelDigest)
    expect(digest(changed(component => ({ ...component, ports: {} })))).not.toBe(plant.modelDigest)
    expect(digest(changed(component => ({ ...component, semantics: { ...component.semantics, keyValues: [] } })))).not.toBe(plant.modelDigest)
  })

  test('keeps operator wording outside numerical identity', () => {
    const renamed = { ...plant.sourceGraph, components: plant.sourceGraph.components.map(component => ({
      ...component, metadata: { ...component.metadata, presentation: { ...component.metadata?.presentation, shortLabel: 'Operator wording' } },
    })) }
    expect(processPlantSourceDigest(renamed)).toBe(source)
    expect(digest({ ...plant.graph, components: plant.graph.components.map(component => ({ ...component, label: 'Operator wording' })) })).toBe(plant.modelDigest)
    const physical = { ...plant.sourceGraph, timestep: { ...plant.sourceGraph.timestep, fixedStepMs: plant.sourceGraph.timestep.fixedStepMs + 1 } }
    expect(processPlantSourceDigest(physical)).not.toBe(source)
  })

  test('refuses a checkpoint with a changed library identity before assigning its slots', () => {
    const runtime = createProcessPlantRuntime({ system: plant })
    const changedGraph = { ...plant.graph, variables: plant.graph.variables.slice(1) }
    const changedPlant = { ...plant, graph: changedGraph, modelDigest: digest(changedGraph) }
    expect(() => createProcessPlantRuntime({ system: changedPlant, restoredCheckpoint: runtime.checkpoint() })).toThrow('does not match Plant model')
    const restored = createProcessPlantRuntime({ system: plant, restoredCheckpoint: runtime.checkpoint() })
    expect(restored.checkpoint()).toEqual(runtime.checkpoint())
  })
})
