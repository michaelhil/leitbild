import {test,expect} from 'bun:test'
import type {ObjectId} from '../src/core/model/index.ts'
import {compileProcessPlant,createPwrReferencePlantDefinition,createProcessPlantRuntime} from '../src/packs/process-plant/index.ts'
import {lineStateSignals} from '../src/packs/process-plant/observation/line-state.ts'
import {plantDeclaration,lineStateProjectionRevision,declarationRevision} from '../src/packs/process-plant/observation/declarations.ts'
import {servedPlantTopology} from '../src/packs/process-plant/observation/topology.ts'
import {answerProcessPlantObservationQuery,processPlantObservationCapabilityIds} from '../src/packs/process-plant/observation/query.ts'
import type {ProcessPlantRuntimeInstance} from '../src/packs/process-plant/runtime-instance.ts'
import {observationShapes,observationDeclarationSchema} from '../src/core/observation/capabilities.ts'

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
test('known physical model revisions cannot mask new read semantics, while current projections round-trip unchanged',()=>{
  const plants=new Map([[id,{plant,runtime:createProcessPlantRuntime({system:plant})} as unknown as ProcessPlantRuntimeInstance]])
  const ask=(capabilityId:string,input:unknown)=>answerProcessPlantObservationQuery({request:{capabilityId,input},plants,recording:null})
  const topology=observationShapes.topology.output.parse(ask(processPlantObservationCapabilityIds.topology,{objectId:id,known:plant.modelDigest}))
  expect('unchanged'in topology).toBe(false)
  expect(topology.revision).toBe(lineStateProjectionRevision(plant))
  expect(ask(processPlantObservationCapabilityIds.topology,{objectId:id,known:topology.revision})).toEqual({objectId:id,revision:topology.revision,unchanged:true})
  const current=declarationRevision(plant,null,'powerOperation'),old=current.replace(lineStateProjectionRevision(plant),plant.modelDigest)
  const response=observationShapes.declarations.output.parse(ask(processPlantObservationCapabilityIds.declarations,{objectIds:[id],known:{[id]:old}}))
  expect('unchanged'in response.declarations[0]!).toBe(false)
  const declared=observationDeclarationSchema.parse(response.declarations[0])
  expect(declared.observables.some(observable=>observable.ref===`${id}#main-feedwater-pump-a-to-header.flowKgPerS`)).toBe(true)
  expect(ask(processPlantObservationCapabilityIds.declarations,{objectIds:[id],known:{[id]:declared.revision}})).toEqual({declarations:[{objectId:id,revision:declared.revision,unchanged:true}]})
})
test('semantic revision follows actual line readability and declaration content without changing physical identity',()=>{
  const signal=lineStateSignals(plant.graph).byLink.get('main-feedwater-pump-a-to-header')![0]!.signal
  const old=lineStateProjectionRevision(plant)
  for(const changed of [{...signal,capabilities:{...signal.capabilities,readable:false}},{...signal,label:'Alternative owner-authored mass-flow label'}]){
    const graph={...plant.graph,signalBindingByPath:new Map(plant.graph.signalBindingByPath).set(signal.path,changed),signalBindings:plant.graph.signalBindings.map(binding=>binding.path===signal.path?changed:binding)}
    const revised={...plant,graph}
    expect(revised.modelDigest).toBe(plant.modelDigest)
    expect(lineStateProjectionRevision(revised)).not.toBe(old)
    expect(servedPlantTopology(id,revised).revision).toBe(lineStateProjectionRevision(revised))
  }
})
