import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createPwrReferencePlantDefinition, processPlantSignalView, type CompiledPlantGraph, type ProcessSignalBinding } from '../src/packs/process-plant/index.ts'
import { processPlantModelDigest, processPlantSourceDigest } from '../src/packs/process-plant/model-identity.ts'
import { declaredObservable, declarationRevision, lineStateProjectionRevision } from '../src/packs/process-plant/observation/declarations.ts'
import { objectIdSchema } from '../src/core/model/ids.ts'

const objectId = objectIdSchema.parse('plant:sg-authority')
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: objectId, loopCount: 4 }))
const primaryHeat = (binding: Pick<ProcessSignalBinding, 'path' | 'owner'>): boolean =>
  binding.owner.type === 'component' && plant.graph.components[binding.owner.componentIndex]?.kind === 'steamGenerator'
  && String(binding.path).endsWith('.heatTransferMw')

describe('SG heat diagnostic authority is authored data', () => {
  test('real signal discovery and World observations preserve diagnostics, instruments and commands distinctly', () => {
    for (const loop of ['A', 'B', 'C', 'D']) {
      const primary = plant.graph.signalBindingByPath.get(('sg' + loop + '.heatTransferMw') as never)!
      const secondary = plant.graph.signalBindingByPath.get(('sg' + loop + '.secondaryHeatTransferMw') as never)!
      expect(processPlantSignalView(primary).simulatorOnly).toBe(true)
      expect(processPlantSignalView(secondary).simulatorOnly).toBe(true)
      expect(declaredObservable(objectId, plant, null, primary.path)?.basis).toBe('model')
      expect(declaredObservable(objectId, plant, null, secondary.path)?.basis).toBe('model')
      expect(declaredObservable(objectId, plant, null, 'sg' + loop + '.metalStoredEnergyRateMw')?.basis).toBe('model')
      expect(declaredObservable(objectId, plant, null, 'sg' + loop + '.levelPercent')?.basis).toBe('instrument')
      expect(declaredObservable(objectId, plant, null, 'feedwaterControlValve' + loop + '.positionFraction')?.basis).toBe('command')
    }
    // UI visibility and tag identity are orthogonal to this authority.
    const level = plant.graph.signalBindingByPath.get('sgA.levelPercent' as never)!
    expect(level.capabilities.operatorFacing).toBe(false)
    expect(level.tagId).toBe('SG-A-LVL-NR')
    expect(level.simulatorOnly).toBeUndefined()
  })

  test('the explicit semantic correction changes model identity and invalidates declaration/topology caches', () => {
    // Reconstruct only the prior test declaration; there is no production
    // alias, old-model loader or compatibility classification.
    const variables = plant.graph.variables.map(variable => {
      if (!primaryHeat(variable)) return variable
      const { simulatorOnly: _mark, ...descriptor } = variable.descriptor
      return { ...variable, descriptor }
    })
    const signalBindings = plant.graph.signalBindings.map(binding => {
      if (!primaryHeat(binding)) return binding
      const { simulatorOnly: _mark, ...previous } = binding
      return previous
    })
    const graph: CompiledPlantGraph = { ...plant.graph, variables, signalBindings,
      signalBindingByPath: new Map(signalBindings.map(binding => [binding.path, binding])) }
    const previousDigest = processPlantModelDigest(processPlantSourceDigest(plant.sourceGraph), graph)
    const previous = { ...plant, graph, modelDigest: previousDigest }
    expect(previousDigest).not.toBe(plant.modelDigest)
    expect(declaredObservable(objectId, previous, null, 'sgA.heatTransferMw')?.basis).toBe('instrument')
    expect(declaredObservable(objectId, plant, null, 'sgA.heatTransferMw')?.basis).toBe('model')
    expect(declarationRevision(previous, null)).not.toBe(declarationRevision(plant, null))
    expect(lineStateProjectionRevision(previous)).not.toBe(lineStateProjectionRevision(plant))
    expect(lineStateProjectionRevision(plant)).toBe(lineStateProjectionRevision(plant))
  })
})

