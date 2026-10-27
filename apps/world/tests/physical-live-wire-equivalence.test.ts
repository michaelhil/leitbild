import { expect, test } from 'bun:test'
import { z } from 'zod'
import { newWorkspaceId } from '@leitbild/contracts'
import { layoutLiveResponseSchema, layoutLiveExpectedSchema } from '../src/ui/physical-layout/read-model.ts'
import { layoutLiveResponseSchema as beforeHoist } from './fixtures/layout-live-before-hoist.ts'
import { resolvePhysicalSubjectOperation } from '../src/ui/physical-layout/operation.ts'
import { createLayoutLiveSession, layoutLiveRoutes, type LayoutLiveSnapshot } from '../src/ui/physical-layout/client.ts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'
import { configureActiveRoleSet, currentActiveRoleSet } from '../src/ui/roles/role-session.ts'

const at='2026-10-27T12:00:00.000Z',owner='plant:wire'
const value=(id:string,boolean=false)=>({ref:`${owner}#${id}`,label:`Plant qualified reading ${id} · ${'qualified '.repeat(12)}`,quantity:boolean?'state':'flow',unit:boolean?'':'kg/s',valueType:boolean?'boolean':'number',thresholds:[],series:null})
const alert=()=>({key:`${owner}|pump-alarm`,objectId:owner,objectLabel:'Plant',packId:'process-plant',categoryId:'plants',group:{objectId:owner},priority:'alarm',state:'active-unack',raised:{at,clock:'simulation'},alert:{id:'pump-alarm',kind:'process-alarm',message:'Pump fault',severity:'critical',priority:'alarm',raisedAt:at,acknowledged:false,subject:{element:'pump'}}})
const wire=()=>{
  const flow=value('flow'),alternate=value('alternate'),guard=value('guard',true),running=value('running',true)
  const incident={id:'pipe',from:{elementId:'pump',label:'Pump',port:'outlet'},to:{elementId:'tank',label:'Tank',port:'inlet'},medium:{id:'water',label:'Water',kind:'fluid'},directed:true}
  return {
    scope:{runId:'run-wire',layoutObjectId:'layout:wire',revision:'exact-layout',objectId:owner,packId:'process-plant',modelDigest:'a'.repeat(64),epoch:'owner-epoch',sequence:77},acquiredAt:at,
    sample:{at:{at,clock:'simulation',paused:true},observations:[{ref:flow.ref,value:12},{ref:alternate.ref,value:-4},{ref:guard.ref,value:false},{ref:running.ref,value:true}].map(observation=>({...observation,at,clock:'simulation',quality:'good',priority:'none'})),alerts:[],entities:{},slots:{},maps:{}},
    subjects:[
      {elementId:'pump',label:'Pump',values:[running],word:null,devices:[],topology:{kind:'node',class:'mover',equipmentKind:'centrifugal-pump',connections:[incident],values:[running],bindings:[{role:'running',ref:running.ref}]}},
      {elementId:'pipe',label:'Pump to tank',values:[flow],word:null,devices:[],topology:{kind:'connection',from:incident.from,to:incident.to,medium:incident.medium,directed:true,values:[flow,alternate,guard],bindings:[{role:'flow',ref:flow.ref},{role:'flow',ref:alternate.ref,while:guard.ref}]}},
    ],
  }
}
// Raw HTTP JSON is intentionally untrusted; mutations must express invalid
// shapes which production TypeScript would otherwise prohibit constructing.
type Raw = Record<string, any>
const jsonWire=():Raw=>JSON.parse(JSON.stringify(wire()))
const outcome=(schema:z.ZodType,input:unknown)=>{
  try{return{accepted:true,data:JSON.parse(JSON.stringify(schema.parse(input)))}}
  catch(error){return error instanceof z.ZodError?{accepted:false,issues:JSON.parse(JSON.stringify(error.issues))}:{accepted:false,error:error instanceof Error?{name:error.name,message:error.message}:String(error)}}
}
const equivalent=(input:unknown)=>{const expected=outcome(beforeHoist,input),actual=outcome(layoutLiveResponseSchema,input);expect(actual).toEqual(expected);return actual}

test('hoisted parsing preserves full actual JSON values, qualified labels and owner-local reading counts',()=>{
  const input=jsonWire();input.subjects[1].values[0].simulated=true;input.subjects[1].values[0].element={id:'flow-sensor',class:'instrument',label:'Flow sensor',parent:'pipe'}
  input.sample.alerts=[alert()]
  input.subjects[1].values[0].tag='FLOW';input.subjects[1].values[0].lead=1;input.subjects[1].values[0].meaningfulWhile='Guard is valid'
  const result=equivalent(input);expect(result.accepted).toBe(true)
  const parsed=layoutLiveResponseSchema.parse(input)
  expect(parsed.subjects).toHaveLength(2);expect(parsed.sample.observations).toHaveLength(4)
  expect(parsed.sample.alerts).toHaveLength(1)
  expect(parsed.subjects[1]!.values[0]!.label.length).toBeGreaterThan(80)
  expect(parsed.subjects[1]!.values[0]!.simulated).toBe(true)
  expect(parsed.subjects[1]!.values[0]!.element).toMatchObject({id:'flow-sensor',parent:'pipe'})
  expect(parsed.subjects[1]!.values[0]).not.toHaveProperty('tag');expect(parsed.subjects[1]!.values[0]).not.toHaveProperty('lead')
  const shared=jsonWire();shared.subjects.push({...shared.subjects[1],elementId:'second-pipe',label:'Second physical connection'})
  expect(equivalent(shared).accepted).toBe(true)
  const sharedParsed=layoutLiveResponseSchema.parse(shared);expect(sharedParsed.subjects).toHaveLength(3);expect(sharedParsed.sample.observations).toHaveLength(4)
  expect(sharedParsed.subjects[1]!.topology!.values).toHaveLength(3);expect(sharedParsed.subjects[2]!.topology!.values).toHaveLength(3)
})

const invalid:ReadonlyArray<readonly[string,(input:Raw)=>void]>=[
  ['foreign owner scope',d=>{d.scope.objectId='plant:other'}],
  ['foreign displayed value',d=>{d.subjects[0].values[0].ref='plant:other#running'}],
  ['foreign semantic value',d=>{d.subjects[1].topology.values[0].ref='plant:other#flow'}],
  ['foreign observation',d=>{d.sample.observations[0].ref='plant:other#flow'}],
  ['foreign alert Pack',d=>{d.sample.alerts=[{...alert(),packId:'other-pack'}]}],
  ['foreign alert owner with internally valid lifecycle',d=>{d.sample.alerts=[{...alert(),objectId:'plant:other',group:{objectId:'plant:other'},key:'plant:other|pump-alarm'}]}],
  ['alert lifecycle presentation mismatch',d=>{d.sample.alerts=[{...alert(),state:'active-ack'}]}],
  ['duplicate subject ids',d=>{d.subjects.push(d.subjects[0])}],
  ['duplicate acquired observation refs',d=>{d.sample.observations.push(d.sample.observations[0])}],
  ['duplicate values within one topology',d=>{d.subjects[1].topology.values.push(d.subjects[1].topology.values[0])}],
  ['semantic reading not acquired',d=>{d.sample.observations.splice(0,1)}],
  ['guard declared but not acquired',d=>{d.sample.observations.splice(2,1)}],
  ['guard acquired but not locally declared',d=>{d.subjects[1].topology.values.splice(2,1)}],
  ['binding declared only on another subject',d=>{d.subjects[1].topology.bindings[0].ref=`${owner}#running`}],
  ['binding to unknown semantic ref',d=>{d.subjects[1].topology.bindings[0].ref=`${owner}#absent`}],
  ['duplicate incident connection ids',d=>{d.subjects[0].topology.connections.push(d.subjects[0].topology.connections[0])}],
  ['incident connection unrelated to its component',d=>{d.subjects[0].topology.connections[0].from.elementId='unrelated'}],
  ['wrong unit for quantity',d=>{d.subjects[1].values[0].unit='degC'}],
  ['missing required series contract',d=>{delete d.subjects[1].values[0].series}],
  ['unrecognised quality',d=>{d.sample.observations[0].quality='apparently-good'}],
  ['oversized qualified label',d=>{d.subjects[1].values[0].label='x'.repeat(1001)}],
  ['arbitrary value metadata',d=>{d.subjects[1].values[0].hiddenPlant={private:true}}],
  ['copied device read plan',d=>{d.subjects[1].values[0].element={id:'sensor',class:'instrument',label:'Sensor',lead:[`${owner}#flow`]}}],
  ['arbitrary sample data',d=>{d.sample.hiddenPlant={private:true}}],
  ['negative sequence',d=>{d.scope.sequence=-1}],
  ['forged role scope field',d=>{d.scope.roleIds=['controller']}],
  ['undeclared endpoint metadata',d=>{d.subjects[1].topology.from.hiddenPlant='private'}],
]
for(const[name,mutate]of invalid)test(`hoisted wire refusal preserves every issue: ${name}`,()=>{const input=jsonWire();mutate(input);expect(equivalent(input).accepted).toBe(false)})

test('nonfinite observations and numeric declaration fields fail identically without JSON coercion',()=>{
  for(const number of [NaN,Infinity,-Infinity]){
    const input=jsonWire();input.sample.observations[0].value=number;expect(equivalent(input).accepted).toBe(false)
    const declaration=jsonWire();declaration.subjects[1].values[0].span={min:0,max:number};expect(equivalent(declaration).accepted).toBe(false)
  }
})

test('fresh, bad and frozen quality still resolve conditional flow without inventing no-flow',()=>{
  for(const quality of ['good','bad','stale','uncertain','not-applicable'] as const)for(const alternate of [false,true]){
    const input=jsonWire();input.sample.observations[2].value=alternate;input.sample.observations[2].quality=quality
    expect(equivalent(input).accepted).toBe(true)
    const parsed=layoutLiveResponseSchema.parse(input),subject=parsed.subjects[1]!
    const current=resolvePhysicalSubjectOperation(subject,parsed.sample.observations,false)
    expect(current.flow?.direction).toBe(quality==='good'?alternate?'reverse':'forward':'unknown')
    expect(resolvePhysicalSubjectOperation(subject,parsed.sample.observations,true).flow?.direction).toBe('unknown')
  }
})

test('one parsed sample cannot lend its acquired refs to a later owner or sample',()=>{
  expect(equivalent(jsonWire()).accepted).toBe(true)
  const missing=jsonWire();missing.sample.observations=[];expect(equivalent(missing).accepted).toBe(false)
  const other=JSON.parse(JSON.stringify(wire()).replaceAll(owner,'plant:second'));expect(equivalent(other).accepted).toBe(true)
  const mixed=jsonWire();mixed.sample.observations=other.sample.observations;expect(equivalent(mixed).accepted).toBe(false)
})

test('valid wire shape still requires exact expected owner/model/Design and the complete admitted subject roster',async()=>{
  const input=jsonWire(),{epoch:_epoch,sequence:_sequence,...scope}=input.scope,expected=layoutLiveExpectedSchema.parse(scope)
  for(const patch of [{modelDigest:'b'.repeat(64)},{revision:'different-layout'},{}]){
    let latest:LayoutLiveSnapshot|null=null,reads=0
    const session=createLayoutLiveSession({expected,subjectIds:patch.modelDigest||patch.revision?['pump','pipe']:['pump','pipe','missing'],routes:{presence:async()=>({loaded:true,displayEpoch:'owner-epoch',snapshotSeq:77}),read:async()=>{reads++;return{...input,scope:{...input.scope,...patch}}}},onChange:value=>{latest=value},schedule:()=>()=>{}})
    session.start();for(let i=0;i<20;i++)await Promise.resolve()
    expect(reads).toBe(1);expect((latest as LayoutLiveSnapshot|null)?.phase).toBe('failed');expect((latest as LayoutLiveSnapshot|null)?.latest).toBeNull();session.close()
  }
})

test('layout transport carries the captured Workspace, Run and explicit role query without forging role fields',async()=>{
  const priorFetch=globalThis.fetch,priorRoles=currentActiveRoleSet(),workspace=newWorkspaceId(),calls:Array<{url:string;body:unknown;signal:AbortSignal|null}> = []
  configureActiveWorkspace(workspace)
  globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{const url=String(input);calls.push({url,body:init?.body?JSON.parse(String(init.body)):null,signal:init?.signal??null});return Response.json(url.includes('/presence')?{loaded:true,displayEpoch:'owner-epoch',snapshotSeq:77}:jsonWire())}) as typeof fetch
  try{
    const {epoch:_epoch,sequence:_sequence,...scope}=wire().scope,expected=layoutLiveExpectedSchema.parse(scope),request=new AbortController()
    for(const roles of [['operator'],['controller','instructor']]){
      configureActiveRoleSet(roles)
      expect(await layoutLiveRoutes.presence(expected.runId,request.signal)).toEqual({loaded:true,displayEpoch:'owner-epoch',snapshotSeq:77})
      expect(layoutLiveResponseSchema.parse(await layoutLiveRoutes.read(expected,request.signal)).subjects).toHaveLength(2)
      const suffix=`?roles=${encodeURIComponent(roles.join(','))}`,prefix=`/api/workspaces/${workspace}/world/simulation-runs/${expected.runId}`
      expect(calls.at(-2)!.url).toBe(prefix+'/presence'+suffix);expect(calls.at(-1)!.url).toBe(prefix+'/displays/layout'+suffix)
      expect(calls.at(-1)!.body).toEqual({layoutObjectId:expected.layoutObjectId,expectedRevision:expected.revision});expect(calls.at(-1)!.signal).toBe(request.signal)
    }
  }finally{globalThis.fetch=priorFetch;configureActiveRoleSet(priorRoles)}
})
