import { expect, test } from 'bun:test'
import { engineeringInputBasisSchema, newWorkspaceId } from '@leitbild/contracts'
import { createRoom } from '../core/rooms/room.ts'
import type { RoomDirectory } from '../core/rooms/directory.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import { createWorkspaceCapabilityTools } from '../tools/built-in/workspace-capability-tools.ts'
import { createEngineering } from './engineering.ts'

test('actual owner transport refuses revoked reads and results revoked during computation', async () => {
  const workspaceId=newWorkspaceId()
  const source={workspaceId,moduleId:'world',type:'world.simulation-run',id:'run'}
  const now='2026-11-08T12:00:00.000Z'
  const basis=engineeringInputBasisSchema.parse({source,profile:'plant-thermal',subjectId:'plant:unit',profileRevision:'engineering-research-1',frame:{epoch:crypto.randomUUID(),scenarioDigest:'a'.repeat(64),restrictionRevision:0,sequence:1,simulationAt:now,observedAt:now},quantities:[{id:'TAVG',label:'Temperature',quantity:'temperature',unit:'degC',value:180,quality:'good'}],digest:'b'.repeat(64)})
  const ids=['world.engineering.inputs.capture','world.engineering.inputs.qualify']
  let qualificationCalls=0,refuseAt=Infinity
  const actors:unknown[]=[]
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
    const path=new URL(req.url).pathname
    const common={workspaceId,modules:[{moduleId:'world',status:'ready'}]}
    if(path.endsWith('/resources'))return Response.json({...common,resources:[{ref:source,title:'Research Run',capabilityIds:ids,links:[],summary:[],observedAt:now}]})
    if(path.endsWith('/definitions'))return Response.json({...common,definitions:[]})
    if(path.endsWith('/capabilities'))return Response.json({...common,capabilities:ids.map(id=>({id,moduleId:'world',kind:'query',scope:{kind:'resource',resourceType:source.type},title:id,description:'Test owner contract',risk:'read',idempotent:true,inputSchema:{type:'object'},outputSchema:{type:'object'}}))})
    if(path.endsWith('/invoke')){
      const body=await req.json() as {actor:unknown};actors.push(body.actor)
      if(path.includes('inputs.capture'))return Response.json({result:basis})
      qualificationCalls++
      return Response.json({result:qualificationCalls>=refuseAt?{allowed:false,code:'epoch_changed',reason:'Run reset'}:{allowed:true}})
    }
    return new Response('Not found',{status:404})
  }})
  const store=createExecutionStore(':memory:')
  try {
    const room=createRoom({id:'room',name:'Research',createdBy:'human',createdAt:1,scope:{kind:'resource',resource:basis.source},scopeRevision:0});room.addMember('agent')
    const rooms={getRoom:(id:string)=>id==='room'?room:undefined} as RoomDirectory
    const workspaceCall=createWorkspaceCapabilityTools({workspaceId,hostBaseUrl:server.url.origin,getRoomScope:id=>rooms.getRoom(id)?.profile.scope}).find(tool=>tool.name==='workspace_call')!
    const service=createEngineering({workspaceId,hostBaseUrl:server.url.origin,rooms,store,workspaceCall,growth:async(_bytes,work)=>work()})
    const args={calls:[{key:'capture',operationId:ids[0],target:{kind:'resource',ref:source},input:{profile:basis.profile,subjectId:basis.subjectId}}]}
    store.beginTurn({id:'captured',roomId:'room',agentId:'agent',startedAt:Date.now()})
    store.recordAttempt('captured',{id:'call_0_0',tool:'workspace_call',arguments:args,startedAt:Date.now()})
    store.recordOutcome('captured','call_0_0',await workspaceCall.execute(args,{callerId:'agent',callerName:'Agent',roomId:'room'}))
    const input={title:'Bound temperature',bindings:[{kind:'retained',name:'T',turnId:'captured',toolCallId:'call_0_0',key:'capture',quantityId:'TAVG'}],program:{source:'({temperature:input.T.value})'}}
    const first=await service.runForPerson('room',{operation:'run',input},{kind:'anonymous'})
    expect(first.receipt.outcome).toMatchObject({status:'completed',output:{temperature:180}})
    expect(actors.at(-1)).toEqual({kind:'anonymous'})
    refuseAt=qualificationCalls+1
    await expect(service.read('room',first.turnId,first.toolCallId,{kind:'anonymous'})).rejects.toThrow('Run reset')
    refuseAt=qualificationCalls+2 // admission succeeds, publication recheck refuses
    await expect(service.runForPerson('room',{operation:'run',input},{kind:'anonymous'})).rejects.toThrow('Run reset')
    const latest=store.listTurns('room')[0]!
    const refused=store.getCall('room',latest.id,store.listCalls('room',latest.id)[0]!.id)!
    expect(refused.result).toMatchObject({success:false,data:{code:'epoch_changed'}})
    expect(JSON.stringify(refused.result)).not.toContain('temperature')
    // Existing retained evidence is unchanged; the new result endpoint did not disclose it.
    expect(store.getCall('room',first.turnId,first.toolCallId)?.result?.success).toBe(true)
  } finally {store.close();await server.stop(true)}
},20_000)
