import { expect, test } from 'bun:test'
import { createRoom } from '../../core/rooms/room.ts'
import type { RoomDirectory } from '../../core/rooms/directory.ts'
import { createConversationReadTool } from './conversation-read.ts'
import { formatMessage } from '../../agents/context-builder.ts'

test('exact prior arguments survive prose summaries and room restore, without cross-room access', async () => {
  const room=createRoom({id:'room',name:'Room',createdBy:'human',createdAt:1,scope:{kind:'workspace'},scopeRevision:0})
  room.addMember('agent')
  const message=room.post({senderId:'agent',type:'chat',content:'Draft is valid.',toolTrace:[{tool:'workspace_call',success:true,argumentKeys:[],argumentBytes:0,resultPreview:'valid'}]})
  const source={id:'draft',timing:120,unchanged:{mobilizationSeconds:60,visibilityM:2500}}
  room.injectGenerationQueries([{messageId:message.id,traceId:'trace',query:{model:'test',messages:[
    {role:'assistant',content:'',toolCalls:[{id:'call',function:{name:'workspace_call',arguments:{calls:[{operationId:'world.scenario.preview',input:{source}}]}}}]},
    {role:'tool',toolCallId:'call',name:'workspace_call',content:'{"valid":true}'},
  ]}}])
  const tool=createConversationReadTool({getRoom:(id:string)=>id==='room'?room:undefined} as RoomDirectory)
  const context={callerId:'agent',callerName:'Agent',roomId:'room'}
  expect(formatMessage(message,'','agent',()=> 'Agent')!.content).toContain(message.id)
  expect(await tool.execute({messageId:message.id},context)).toMatchObject({success:true,data:{calls:[{toolCallId:'call'}]}})
  expect(await tool.execute({messageId:message.id,toolCallId:'call'},context)).toMatchObject({
    success:true,data:{arguments:{calls:[{input:{source}}]}},
  })
  expect(await tool.execute({messageId:message.id,toolCallId:'call',part:'result'},context))
    .toMatchObject({success:true,data:{result:'{"valid":true}'}})
  expect(await tool.execute({messageId:message.id},{...context,callerId:'stranger'})).toMatchObject({success:false})
  expect(await tool.execute({messageId:message.id},{...context,roomId:'other'})).toMatchObject({success:false})
})
