import { afterEach, expect, test } from 'bun:test'
import { engineeringInputBasisSchema } from '@leitbild/contracts'
import { createExecutionStore } from '../core/executions/store.ts'
import type { Tool } from '../core/types/tool.ts'
import { assertEngineeringSeries, assertSnapshotRefresh, bindEngineeringInputs, engineeringBindingsSchema, retainedEngineeringBasis } from './engineering-inputs.ts'

const workspaceId='6f1c4b8e-3a2d-4c1b-9f0e-1a2b3c4d5e6f'
const source={workspaceId,moduleId:'world',type:'world.simulation-run',id:'run-1'}
const basis=engineeringInputBasisSchema.parse({source,profile:'plant-thermal',subjectId:'plant:unit-1',profileRevision:'engineering-research-1',
  frame:{epoch:'ddc967e1-5ce7-4acb-ad0e-a95c945210a2',scenarioDigest:'a'.repeat(64),restrictionRevision:0,sequence:10,simulationAt:'2026-11-08T10:00:00.000Z',observedAt:'2026-11-08T12:00:00.000Z'},
  quantities:[{id:'temperature',label:'Temperature',quantity:'temperature',unit:'K',value:450,quality:'good'}],digest:'b'.repeat(64)})
const stores:ReturnType<typeof createExecutionStore>[]=[]
afterEach(()=>{for(const store of stores.splice(0))store.close()})
const setup=(changes:Record<string,unknown>={})=>{
  const store=createExecutionStore(':memory:');stores.push(store)
  store.beginTurn({id:'old',roomId:'room',agentId:'agent',startedAt:1})
  const entry={key:'basis',operationId:'world.engineering.inputs.capture',target:{kind:'resource',ref:source},input:{profile:basis.profile,subjectId:basis.subjectId}}
  store.recordAttempt('old',{id:'call_1_0',tool:'workspace_call',arguments:{calls:[entry]},startedAt:1})
  store.recordOutcome('old','call_1_0',{success:true,data:{results:[{...entry,success:true,data:{...basis,...changes}}]}})
  const binding={kind:'retained' as const,name:'T',turnId:'old',toolCallId:'call_1_0',key:'basis',quantityId:'temperature'}
  const invocations:unknown[]=[]
  let allowed=true
  const workspaceCall:Tool={name:'workspace_call',contextEffect:'read',description:'test owner',parameters:{},execute:async(input)=>{invocations.push(input);return{success:true,data:{results:[{success:true,data:{allowed,...(allowed?{}:{code:'epoch_changed',reason:'Run reset'})}}]}}}}
  return{store,binding,workspaceCall,invocations,revoke:()=>{allowed=false}}
}
const context={callerId:'agent',callerName:'Agent',roomId:'room'}

test('binds original retained quantities and acquisition times, requalifying each execution',async()=>{
  const state=setup()
  const deps={...state,workspaceId}
  const result=await bindEngineeringInputs(deps,context,[state.binding,{kind:'assumption',name:'C',value:120,quantity:'heat-capacity',unit:'MJ/K',note:'Reduced model assumption'}])
  expect(result.inputs).toMatchObject([{name:'T',value:450,origin:'observation',simulationAt:basis.frame.simulationAt},{name:'C',value:120,origin:'assumption'}])
  expect(state.invocations).toMatchObject([{calls:[{operationId:'world.engineering.inputs.qualify',input:{frame:{epoch:basis.frame.epoch,restrictionRevision:0}}}]}])
  state.revoke()
  await expect(bindEngineeringInputs(deps,context,[state.binding])).rejects.toThrow('Run reset')
})
test('rejects cross-Room, mismatched target/profile and missing quantity without substitution',async()=>{
  const state=setup()
  expect(()=>retainedEngineeringBasis(state.store,'other',state.binding,workspaceId)).toThrow('absent')
  expect(()=>retainedEngineeringBasis(state.store,'room',state.binding,crypto.randomUUID())).toThrow('source differs')
  await expect(bindEngineeringInputs({...state,workspaceId},context,[{...state.binding,quantityId:'invented'}])).rejects.toThrow('absent')
  const mismatch=setup({profile:'grid-balance'})
  expect(()=>retainedEngineeringBasis(mismatch.store,'room',mismatch.binding,workspaceId)).toThrow('profile or subject')
})
test('refuses unknown quality and ambiguity, and never upgrades assumptions into observations',async()=>{
  const state=setup({quantities:[{...basis.quantities[0],quality:'unknown'}]})
  await expect(bindEngineeringInputs({...state,workspaceId},context,[state.binding])).rejects.toThrow('Unknown-quality')
  expect(engineeringBindingsSchema.safeParse([state.binding,state.binding]).success).toBe(false)
  expect(engineeringBindingsSchema.safeParse([{kind:'assumption',name:'x',value:1,quantity:'mass',unit:'kg',origin:'observation',note:'x'}]).success).toBe(false)
})

test('reviewed series preserve signal and trajectory lineage; snapshot refresh never collapses a window',async()=>{
  const state=setup()
  const later={...basis,digest:'c'.repeat(64),frame:{...basis.frame,sequence:20,simulationAt:'2026-11-08T10:00:07.000Z'}}
  const record=(value:typeof basis,id:string)=>{
    const entry={key:'basis',operationId:'world.engineering.inputs.capture',target:{kind:'resource',ref:value.source},input:{profile:value.profile,subjectId:value.subjectId}}
    state.store.recordAttempt('old',{id,tool:'workspace_call',arguments:{calls:[entry]},startedAt:2})
    state.store.recordOutcome('old',id,{success:true,data:{results:[{...entry,success:true,data:value}]}})
    return {...state.binding,name:'T2',toolCallId:id,quantityId:value.quantities[0]!.id}
  }
  const method={method:'sample_changes' as const,samples:['T','T2']}
  const bound=await bindEngineeringInputs({...state,workspaceId},context,[state.binding,record(later,'call_1_1')])
  expect(()=>assertEngineeringSeries(method,bound)).not.toThrow()
  expect(bound.observationRefs).toEqual([{name:'T',basisDigest:basis.digest,quantityId:'temperature'},{name:'T2',basisDigest:later.digest,quantityId:'temperature'}])
  expect(()=>assertSnapshotRefresh(bound.sources)).toThrow('historical time window')
  expect(()=>assertSnapshotRefresh([basis,basis])).not.toThrow()
  // The permission tuple is shared even though sample frames/digests differ.
  expect(state.invocations).toHaveLength(1)
  const changes=[{source:{...basis.source,id:'other-run'}},{subjectId:'plant:other'},{frame:{...later.frame,epoch:crypto.randomUUID()}},{quantities:[{...basis.quantities[0]!,id:'other-temperature'}]}]
  for(const [i,change] of changes.entries()){
    const other=record(engineeringInputBasisSchema.parse({...later,...change,digest:String(i+1).repeat(64)}),`call_2_${i}`)
    const mixed=await bindEngineeringInputs({...state,workspaceId},context,[state.binding,other])
    expect(()=>assertEngineeringSeries(method,mixed)).toThrow('one observed signal')
    expect(()=>assertEngineeringSeries({method:'reservoir_balance',initial:'T',streams:[{name:'flow',direction:'in',samples:['T','T2']}],interpolation:'linear',maxGapSeconds:20,from:basis.frame.simulationAt,to:later.frame.simulationAt,boundary:'fixture',omittedTerms:[]},mixed)).toThrow('one observed signal')
  }
})
