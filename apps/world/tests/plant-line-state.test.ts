import {test,expect} from 'bun:test'
import type {ObjectId} from '../src/core/model/index.ts'
import {compileProcessPlant,createPwrReferencePlantDefinition} from '../src/packs/process-plant/index.ts'
import {lineStateSignals} from '../src/packs/process-plant/observation/line-state.ts'
import {plantDeclaration} from '../src/packs/process-plant/observation/declarations.ts'
import {servedPlantTopology} from '../src/packs/process-plant/observation/topology.ts'

const id='plant:line-state' as ObjectId,plant=compileProcessPlant(createPwrReferencePlantDefinition({id,loopCount:4}))
test('solved mass flow and energized reads are declared independently of the compact push selection',()=>{
  const index=lineStateSignals(plant.graph),topology=servedPlantTopology(id,plant),declaration=plantDeclaration(id,plant,null)
  const fluid=index.byLink.get('main-feedwater-pump-a-to-header')![0]!,electrical=index.byLink.get('unit-bus-a-to-mainFeedwaterPumpA')![0]!
  expect(fluid.role).toBe('flow')
  expect(fluid.signal.published).toBe(false)
  expect(topology.edges.find(edge=>edge.id==='main-feedwater-pump-a-to-header')!.bindings).toEqual([{role:'flow',ref:`${id}#${fluid.signal.path}`}])
  expect(electrical.role).toBe('conducting')
  expect(topology.edges.find(edge=>edge.id==='unit-bus-a-to-mainFeedwaterPumpA')!.bindings).toEqual([{role:'conducting',ref:`${id}#${electrical.signal.path}`}])
  for(const{signal}of[fluid,electrical])expect(declaration.observables.find(observable=>observable.ref===`${id}#${signal.path}`)).toMatchObject({basis:'model',series:null})
  expect(index.paths.has('main-feedwater-pump-a-to-header.temperatureC' as typeof fluid.signal.path)).toBe(false)
  expect(index.paths.has('rcs-hot-leg-a.leakFlowKgPerS' as typeof fluid.signal.path)).toBe(false)
})
test('a primary reading still respects explicit readability and fault-truth exclusion',()=>{
  const original=lineStateSignals(plant.graph).byLink.get('main-feedwater-pump-a-to-header')![0]!.signal
  for(const signal of [{...original,capabilities:{...original.capabilities,readable:false}},{...original,faultTruth:true as const}]){
    const graph={...plant.graph,signalBindingByPath:new Map(plant.graph.signalBindingByPath).set(signal.path,signal)}
    expect(lineStateSignals(graph).byLink.has('main-feedwater-pump-a-to-header')).toBe(false)
    expect(lineStateSignals(graph).paths.has(signal.path)).toBe(false)
  }
})
