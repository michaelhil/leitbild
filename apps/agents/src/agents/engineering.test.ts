import { afterEach, expect, test } from 'bun:test'
import { workspaceIdSchema } from '@leitbild/contracts'
import { createRoom } from '../core/rooms/room.ts'
import type { RoomDirectory } from '../core/rooms/directory.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import type { Tool } from '../core/types/tool.ts'
import type { ChatRequest, LLMProvider } from '../core/types/llm.ts'
import { toolsToDefinitions } from '../llm/tool-capability.ts'
import { createEngineering, type EngineeringReceipt } from './engineering.ts'
import { createToolExecutor } from './spawn.ts'
import { evaluate } from './evaluation.ts'

const cleanup:Array<()=>void>=[]
afterEach(()=>{for(const fn of cleanup.splice(0))fn()})
const fixture=()=>{
  const room=createRoom({id:'room',name:'Research',createdBy:'human',createdAt:1,scope:{kind:'workspace'},scopeRevision:0})
  room.addMember('agent')
  const rooms={getRoom:(id:string)=>id==='room'?room:undefined} as RoomDirectory
  const store=createExecutionStore(':memory:');cleanup.push(()=>store.close())
  const workspaceCall:Tool={name:'workspace_call',description:'No owner evidence in this independent numerical fixture',parameters:{},execute:async()=>({success:false,error:'No source in numerical fixture'})}
  const service=createEngineering({workspaceId:workspaceIdSchema.parse('6f1c4b8e-3a2d-4c1b-9f0e-1a2b3c4d5e6f'),hostBaseUrl:'http://127.0.0.1:1',rooms,store,workspaceCall,growth:async(_bytes,work)=>work()})
  const registry=createToolRegistry();registry.registerAll(service.tools)
  return{room,store,service,registry}
}
const assumption=(name:string,value:number,quantity='dimensionless',unit='1')=>({kind:'assumption',name,value,quantity,unit,note:'Independent synthetic oracle; not a plant reading'})
const receiptFrom=(result:unknown):EngineeringReceipt=>(result as {data:{results:Array<{data:EngineeringReceipt}>}}).data.results[0]!.data

test('HTTP-owner execution retains source for reuse with changed inputs and unique immutable results',async()=>{
  const {service,store}=fixture()
  const first=await service.runForPerson('room',{operation:'run',input:{title:'Assumption sensitivity',bindings:[assumption('x',3)],program:{source:'({square:input.x.value ** 2})'}}},{kind:'anonymous'})
  const second=await service.runForPerson('room',{operation:'run',input:{title:'Changed assumption',bindings:[assumption('x',4)],program:{reuse:{turnId:first.turnId,toolCallId:first.toolCallId}}}},{kind:'anonymous'})
  expect(first.receipt.outcome).toMatchObject({status:'completed',output:{square:9}})
  expect(second.receipt.outcome).toMatchObject({status:'completed',output:{square:16}})
  expect(second.receipt.inputDigest).not.toBe(first.receipt.inputDigest)
  expect((second.receipt.outcome as {sourceHash:string}).sourceHash).toBe((first.receipt.outcome as {sourceHash:string}).sourceHash)
  expect((await service.read('room',first.turnId,first.toolCallId,{kind:'anonymous'})).receipt).toEqual(first.receipt)
  expect(store.getTurn('room',first.turnId)?.agentId).toBe('anonymous-operator')
  await expect(service.read('wrong-room',first.turnId,first.toolCallId,{kind:'anonymous'})).rejects.toThrow('Room')
})

for(const scenario of [
  {name:'thermal',bindings:[assumption('C',120,'heat-capacity','MJ/K'),assumption('T0',180,'temperature','°C'),assumption('Ta',30,'temperature','°C'),assumption('Q0',0.8,'power','MW'),assumption('h',0.020,'heat-transfer-coefficient','MW/K'),assumption('lambda',1/3600,'inverse-time','1/s'),assumption('t',1800,'time','s')],source:'const {C,T0,Ta,Q0,h,lambda,t}=Object.fromEntries(Object.entries(input).map(([k,v])=>[k,v.value])); const a=h/C; ({temperature:Ta+(T0-Ta)*Math.exp(-a*t)+(Q0/C)*(Math.exp(-lambda*t)-Math.exp(-a*t))/(a-lambda)})',expected:{temperature:149.1799867604}},
  {name:'grid',bindings:[assumption('supply',80,'power','MW'),assumption('d1',70,'power','MW'),assumption('d2',90,'power','MW'),assumption('d3',60,'power','MW'),assumption('hours',1/6,'time','h')],source:'const supply=input.supply.value, hours=input.hours.value; const net=[input.d1,input.d2,input.d3].map(d=>supply-d.value); ({netEnergy:net.reduce((s,x)=>s+x*hours,0),deficitEnergy:net.reduce((s,x)=>s+Math.max(0,-x)*hours,0)})',expected:{netEnergy:10/3,deficitEnergy:5/3}},
  {name:'repair',bindings:[assumption('x',3)],source:'({square:input.x.value ** 2})',expected:{square:9}},
])test(`scripted Agent loop executes, inspects and presents ${scenario.name} through actual tools`,async()=>{
  const {service,registry,store}=fixture()
  const turnId=`turn-${scenario.name}`
  store.beginTurn({id:turnId,roomId:'room',agentId:'agent',startedAt:Date.now()})
  const requests:ChatRequest[]=[]
  const provider:LLMProvider={models:async()=>[],chat:async request=>{
    requests.push(structuredClone(request))
    const calls=store.listCalls('room',turnId)
    const repair=scenario.name==='repair' && calls.length===0
    if(calls.length===0 || (scenario.name==='repair' && calls.length===1))return{content:'',generationMs:1,tokensUsed:{prompt:1,completion:1},toolCalls:[{id:`script-${calls.length}`,function:{name:'engineering_run',arguments:{title:`${scenario.name} research`,bindings:scenario.bindings,program:{source:repair?'({value:Infinity})':scenario.source}}}}]}
    const last=store.getCall('room',turnId,calls.at(-1)!.id)!
    const data=last.result!.data as {results:Array<{viewRef:string}>}
    return{content:`Exploratory calculation from declared assumptions.\n\n\`\`\`leitbild-view\nview ${data.results[0]!.viewRef}\n\`\`\``,generationMs:1,tokensUsed:{prompt:1,completion:1}}
  }}
  const executor=createToolExecutor(registry,service.tools.map(tool=>tool.name),{callerId:'agent',callerName:'Researcher'},undefined,undefined,store)
  const evaluated=await evaluate({messages:[{role:'user',content:'Run the quantitative research fixture, inspect its execution, and present its retained result.'}],flushInfo:{ids:new Set(),triggerRoomId:'room'},warnings:[]},{name:'Researcher',model:'scripted-fixture',persona:'Engineering test'},provider,executor,4,'room',{executionTurnId:turnId,toolDefinitions:toolsToDefinitions(service.tools)})
  expect(evaluated.decision.response.action).toBe('respond')
  const calls=store.listCalls('room',turnId)
  expect(calls.length).toBe(scenario.name==='repair'?2:1)
  const receipt=receiptFrom(store.getCall('room',turnId,calls.at(-1)!.id)!.result)
  const outcome=receipt.outcome as {status:string;output:Record<string,number>}
  expect(outcome.status).toBe('completed')
  for(const [name,value] of Object.entries(scenario.expected))expect(outcome.output[name]).toBeCloseTo(value,8)
  if(scenario.name==='repair')expect(receiptFrom(store.getCall('room',turnId,calls[0]!.id)!.result).outcome).toMatchObject({status:'failed',error:{code:'invalid_output'}})
  expect(requests.length).toBe(scenario.name==='repair'?3:2)
},15_000)

test('dispatch authority refuses strangers, comparisons and missing execution identity before computing',async()=>{
  const {service}=fixture()
  const tool=service.tools.find(tool=>tool.name==='engineering_run')!
  const input={title:'Guard',bindings:[assumption('x',1)],program:{source:'1'}}
  expect(await tool.execute(input,{callerId:'stranger',callerName:'Stranger',roomId:'room'})).toMatchObject({success:false,data:{code:'room_membership_required'}})
  expect(await tool.execute(input,{callerId:'agent',callerName:'Agent',roomId:'room'})).toMatchObject({success:false,data:{code:'execution_required'}})
  expect(await tool.execute(input,{callerId:'agent',callerName:'Agent',roomId:'room',comparison:{resourceKeys:[],definitionKeys:[],messageIds:[],turnIds:[]}})).toMatchObject({success:false,data:{code:'comparison_unsupported'}})
})
