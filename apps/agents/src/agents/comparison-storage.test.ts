import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComparisonStorage } from './comparison-storage.ts'
import { createComparisons } from './comparisons.ts'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import type { LLMService } from '../llm/llm-service.ts'
import type { LLMProvider } from '../core/types/llm.ts'

test('storage keeps source immutable, updates only one alternative, reloads and deletes independently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-comparison-storage-'))
  const store = createComparisonStorage(root, async (_bytes, work) => work())
  try {
    await store.writeSource('room', 'message', JSON.stringify({ source: 'original' }))
    await store.writeAlternative('room', 'message', 'one', JSON.stringify({ id: 'one', status: 'running' }))
    await store.writeAlternative('room', 'message', 'two', JSON.stringify({ id: 'two', status: 'completed' }))
    const sourcePath = join(root, 'room/message/source.json')
    const siblingPath = join(root, 'room/message/alternatives/two.json')
    const before = await Promise.all([stat(sourcePath), stat(siblingPath)])
    await store.writeSource('room', 'message', JSON.stringify({ source: 'replacement' }))
    await store.writeAlternative('room', 'message', 'one', JSON.stringify({ id: 'one', status: 'completed' }))
    expect((await stat(sourcePath)).mtimeMs).toBe(before[0]!.mtimeMs)
    expect((await stat(siblingPath)).mtimeMs).toBe(before[1]!.mtimeMs)
    expect((await store.read('room', 'message'))?.source).toEqual({ source: 'original' })
    await store.removeAlternative('room', 'message', 'one')
    expect((await store.read('room', 'message'))?.alternatives).toEqual([{ id: 'two', status: 'completed' }])
    expect(() => store.remove('../outside')).toThrow('Invalid comparison identifier')
    await store.remove('room', 'message')
    expect(await store.read('room', 'message')).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('durable service retains concurrent alternatives, marks crash state interrupted and evicts inactive records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-comparison-service-'))
  const rooms = createRoomDirectory()
  const room = rooms.createRoom({ name: 'Comparison', createdBy: 'human' })
  room.addMember('agent')
  const original = room.post({ senderId: 'agent', type: 'chat', content: 'Original' })
  const executions = createExecutionStore(':memory:')
  const provider: LLMProvider = {
    models: async () => ['provider:model'],
    modelInfo: async id => ({ id, provider: 'provider', source: 'test', contextMax: 100000 }),
    chat: async () => ({ content: 'Alternative', generationMs: 1, tokensUsed: { prompt: 10, completion: 2 } }),
  }
  const deps = { root, rooms, executions, registry: createToolRegistry(), llm: { bound: () => provider } as unknown as LLMService, growth: async <T>(_bytes: number, work: () => Promise<T>): Promise<T> => work() }
  let service = createComparisons(deps)
  try {
    await service.capture({
      executionTurnId: 'turn', roomId: room.profile.id, agentId: 'agent', config: { name: 'Agent', model: 'provider:model', persona: 'Test' },
      context: { messages: [{ role: 'user', content: 'Assess.' }], warnings: [], flushInfo: { ids: new Set(), triggerRoomId: room.profile.id } },
      toolDefinitions: [], focusedSubjects: [],
    })
    service.link({ executionTurnId: 'turn', roomId: 'wrong-room', messageId: original.id })
    service.link({ executionTurnId: 'turn', roomId: room.profile.id, messageId: original.id })
    await service.close()
    service = createComparisons(deps)
    const results = await Promise.all([service.start(room.profile.id, original.id, 'provider:model'), service.start(room.profile.id, original.id, 'provider:model')])
    await service.close()
    service = createComparisons(deps)
    expect((await service.list(room.profile.id, original.id)).alternatives).toHaveLength(2)
    const file = join(root, room.profile.id, original.id, 'alternatives', `${results[0]!.id}.json`)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    await Bun.write(file, JSON.stringify({ ...saved, status: 'running', finishedAt: undefined }))
    // A prior list must not boot-cache the completed historical record.
    expect((await service.detail(room.profile.id, original.id, results[0]!.id)).status).toBe('interrupted')
    expect(JSON.parse(await readFile(file, 'utf8')).status).toBe('interrupted')
    await service.remove(room.profile.id, original.id, results[0]!.id)
    expect((await service.list(room.profile.id, original.id)).alternatives.map(a => a.id)).toEqual([results[1]!.id])
    service.removeMessages(room.profile.id, original.id)
    await service.close()
    service = createComparisons(deps)
    expect((await service.list(room.profile.id, original.id)).available).toBe(false)
  } finally { await service.close(); executions.close(); await rm(root, { recursive: true, force: true }) }
})

test('deleting the source during asynchronous model preflight cannot launch a paid comparison', async () => {
  const rooms=createRoomDirectory()
  const room=rooms.createRoom({name:'Delete during preflight',createdBy:'human'})
  room.addMember('agent')
  const message=room.post({senderId:'agent',type:'chat',content:'Original'})
  const executions=createExecutionStore(':memory:')
  let ready!:()=>void, resume!:()=>void, calls=0
  const entered=new Promise<void>(resolve=>{ready=resolve})
  const gate=new Promise<void>(resolve=>{resume=resolve})
  const provider:LLMProvider={
    models:async()=>[],
    modelInfo:async id=>{ready();await gate;return {id,provider:'provider',source:'test',contextMax:100000}},
    chat:async()=>{calls++;return {content:'Must not run',generationMs:1,tokensUsed:{prompt:1,completion:1}}},
  }
  const service=createComparisons({rooms,executions,registry:createToolRegistry(),llm:{bound:()=>provider} as unknown as LLMService,growth:async(_bytes,work)=>work()})
  try{
    await service.capture({executionTurnId:'turn',roomId:room.profile.id,agentId:'agent',config:{name:'Agent',model:'provider:model',persona:''},context:{messages:[{role:'user',content:'Assess.'}],warnings:[],flushInfo:{ids:new Set(),triggerRoomId:room.profile.id}},toolDefinitions:[],focusedSubjects:[]})
    service.link({executionTurnId:'turn',roomId:room.profile.id,messageId:message.id})
    const starting=service.start(room.profile.id,message.id,'provider:model')
    await entered
    room.deleteMessage(message.id)
    service.removeMessages(room.profile.id,message.id)
    resume()
    await expect(starting).rejects.toThrow('source was removed')
    expect(calls).toBe(0)
  }finally{resume();await service.close();executions.close()}
})
