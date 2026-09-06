import { expect, test } from 'bun:test'
import { createRoom } from '../../core/rooms/room.ts'
import type { RoomDirectory } from '../../core/rooms/directory.ts'
import { createConversationReadTool } from './conversation-read.ts'
import { formatMessage } from '../../agents/context-builder.ts'
import { createExecutionStore } from '../../core/executions/store.ts'

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
  room.replaceCompression([message.id], 'A draft was validated.')
  expect(await tool.execute({messageId:message.id,toolCallId:'call'},context)).toMatchObject({
    success:true,data:{arguments:{calls:[{input:{source}}]}},
  })
})

test('comparison history excludes the original answer, later conversation and sibling executions', async () => {
  const room = createRoom({ id: 'room', name: 'Room', createdBy: 'human', createdAt: 1, scope: { kind: 'workspace' }, scopeRevision: 0 })
  room.addMember('agent')
  const prior = room.post({ senderId: 'human', type: 'chat', content: 'Earlier question' })
  const original = room.post({ senderId: 'agent', type: 'chat', content: 'Original model answer with privileged evidence' })
  const later = room.post({ senderId: 'human', type: 'chat', content: 'Later follow-up' })
  const store = createExecutionStore(':memory:')
  try {
    for (const id of ['prior', 'original', 'later', 'sibling', 'own']) {
      // Identical timestamps intentionally rule out timestamp-only isolation.
      store.beginTurn({ id, roomId: 'room', agentId: 'agent', startedAt: 10 })
      store.recordAttempt(id, { id: 'call', tool: 'read_state', arguments: { selectedBy: id }, startedAt: 10 })
      store.recordOutcome(id, 'call', { success: true, data: { evidenceFor: id } })
      if (id !== 'own') store.finishTurn(id, 'completed')
    }
    const tool = createConversationReadTool({ getRoom: (id: string) => id === 'room' ? room : undefined } as RoomDirectory, store)
    const context = {
      callerId: 'agent', callerName: 'Agent', roomId: 'room',
      comparison: { resourceKeys: [], definitionKeys: [], messageIds: [prior.id], turnIds: ['prior', 'own'] },
    }
    const list = await tool.execute({}, context)
    expect(list).toMatchObject({ success: true, data: { total: 1, messages: [{ messageId: prior.id }] } })
    const payload = list.data as { executionTurns: Array<{ id: string }> }
    expect(payload.executionTurns.map(turn => turn.id).sort()).toEqual(['own', 'prior'])
    expect(JSON.stringify(list)).not.toContain('privileged evidence')
    expect(JSON.stringify(list)).not.toContain('Later follow-up')
    for (const messageId of [original.id, later.id]) {
      expect(await tool.execute({ messageId }, context)).toMatchObject({ success: false, error: 'comparison_evidence_out_of_scope: only evidence available before this task may be retrieved' })
    }
    for (const turnId of ['original', 'later', 'sibling']) {
      expect(await tool.execute({ turnId, toolCallId: 'call', part: 'result' }, context)).toMatchObject({ success: false })
    }
    expect(await tool.execute({ turnId: 'own', toolCallId: 'call', part: 'result' }, context))
      .toMatchObject({ success: true, data: { result: { data: { evidenceFor: 'own' } } } })
    expect(await tool.execute({ turnId: 'prior', toolCallId: 'call', part: 'arguments' }, context))
      .toMatchObject({ success: true, data: { arguments: { selectedBy: 'prior' } } })
    expect(await tool.execute({ messageId: prior.id }, { ...context, callerId: 'stranger' })).toMatchObject({ success: false })
  } finally {
    store.close()
  }
})
