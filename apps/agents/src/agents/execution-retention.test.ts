import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionStore } from '../core/executions/store.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { createWorkspaceSettings } from '../core/workspaces/settings.ts'
import { createTeam } from './team.ts'
import { __testSeam, spawnAIAgent, type RunToolOperation } from './spawn.ts'
import { createConversationReadTool } from '../tools/built-in/conversation-read.ts'
import { roomRoutes } from '../api/routes/rooms.ts'
import type { RouteContext } from '../api/routes/types.ts'
import type { LLMProvider } from '../core/types/llm.ts'
import type { NativeToolCall, ToolResult } from '../core/types/tool.ts'
import type { LLMService } from '../llm/llm-service.ts'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const llm = (responses: ReadonlyArray<{ content?: string; toolCalls?: ReadonlyArray<NativeToolCall> }>): LLMProvider => {
  let index = 0
  return {
    models: async () => ['test'],
    chat: async () => ({ content: '', ...responses[index++]!, generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }),
  }
}
const native = (name: string): NativeToolCall => ({ id: 'Ab123Cd45', function: { name, arguments: { exact: { unchanged: 17 } } } })

test('attempt is durable before dispatch, outcome before return, and failed admission dispatches nothing', async () => {
  const store = createExecutionStore(':memory:')
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 })
  const registry = createToolRegistry()
  let dispatches = 0
  registry.register({ name: 'mutate', description: '', parameters: {}, execute: async () => {
    dispatches++
    expect(store.getCall('room', 'turn', 'call')?.arguments).toEqual({ value: 3 })
    return { success: true, data: { changed: true } }
  } })
  const context = { callerId: 'agent', callerName: 'Agent' }
  const execute = __testSeam.createToolExecutor(registry, ['mutate'], context, undefined, undefined, store)
  const result = await execute([{ callId: 'call', tool: 'mutate', arguments: { value: 3 } }], 'room', undefined, 'turn')
  expect(store.getCall('room', 'turn', 'call')?.result).toEqual(result[0])
  const rejected = __testSeam.createToolExecutor(registry, ['mutate'], context, undefined, undefined, store, async () => { throw new Error('quota') })
  await expect(rejected([{ callId: 'blocked', tool: 'mutate', arguments: {} }], 'room', undefined, 'turn')).rejects.toThrow('quota')
  expect(dispatches).toBe(1)
  expect(store.getCall('room', 'turn', 'blocked')).toBeUndefined()
  store.close()
})

test('outcome persistence failure stops subsequent dispatch and leaves unknown evidence', async () => {
  const store = createExecutionStore(':memory:')
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 })
  const registry = createToolRegistry()
  let dispatches = 0
  registry.register({ name: 'act', description: '', parameters: {}, execute: async () => { dispatches++; return { success: true } } })
  const failedStore = { ...store, recordOutcome: () => { throw new Error('disk write failed') } }
  const execute = __testSeam.createToolExecutor(registry, ['act'], { callerId: 'agent', callerName: 'Agent' }, undefined, undefined, failedStore)
  await expect(execute([
    { callId: 'first', tool: 'act', arguments: {} }, { callId: 'second', tool: 'act', arguments: {} },
  ], 'room', undefined, 'turn')).rejects.toThrow('disk write failed')
  expect(dispatches).toBe(1)
  expect(store.getCall('room', 'turn', 'first')?.result).toBeUndefined()
  expect(store.getCall('room', 'turn', 'second')).toBeUndefined()
  store.close()
})

test('Workspace admission rejection and cancellation before admitted dispatch do not invent outcomes', async () => {
  const store = createExecutionStore(':memory:')
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 })
  const registry = createToolRegistry()
  let dispatches = 0
  registry.register({ name: 'act', description: '', parameters: {}, execute: async () => { dispatches++; return { success: true } } })
  const context = { callerId: 'agent', callerName: 'Agent' }
  const denied = __testSeam.createToolExecutor(registry, ['act'], context, undefined, undefined, store, undefined,
    async () => { throw new Error('Workspace is deleting') })
  await expect(denied([{ callId: 'denied', tool: 'act', arguments: {} }], 'room', undefined, 'turn')).rejects.toThrow('Workspace is deleting')
  expect(store.getCall('room', 'turn', 'denied')?.result).toBeUndefined()
  const queued = deferred<void>()
  const admitted = deferred<void>()
  const released = deferred<void>()
  const operation: RunToolOperation = async work => {
    queued.resolve()
    await admitted.promise
    try { return await work() } finally { released.resolve() }
  }
  const execute = __testSeam.createToolExecutor(registry, ['act'], context, undefined, undefined, store, undefined, operation)
  const abort = new AbortController()
  const pending = execute([{ callId: 'cancelled', tool: 'act', arguments: {} }], 'room', abort.signal, 'turn')
  await queued.promise
  abort.abort()
  await expect(pending).rejects.toThrow('outcome is unknown')
  admitted.resolve()
  await released.promise
  expect(dispatches).toBe(0)
  expect(store.getCall('room', 'turn', 'cancelled')?.result).toBeUndefined()
  store.close()
})

test('deleting an interrupted turn prevents late actual result resurrection', async () => {
  const store = createExecutionStore(':memory:')
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 })
  const registry = createToolRegistry()
  const entered = deferred<void>()
  const release = deferred<ToolResult>()
  const attemptedLateWrite = deferred<void>()
  registry.register({ name: 'act', description: '', parameters: {}, execute: async () => { entered.resolve(); return release.promise } })
  const observedStore = { ...store, recordOutcome: (...args: Parameters<typeof store.recordOutcome>) => {
    try { store.recordOutcome(...args) } finally { attemptedLateWrite.resolve() }
  } }
  const execute = __testSeam.createToolExecutor(registry, ['act'], { callerId: 'agent', callerName: 'Agent' }, undefined, undefined, observedStore)
  const abort = new AbortController()
  const pending = execute([{ callId: 'call', tool: 'act', arguments: {} }], 'room', abort.signal, 'turn')
  await entered.promise
  abort.abort()
  await expect(pending).rejects.toThrow('outcome is unknown')
  store.deleteRoom('room')
  release.resolve({ success: true, data: 'completed after deletion' })
  await attemptedLateWrite.promise
  expect(store.getTurn('room', 'turn')).toBeUndefined()
  expect(store.getCall('room', 'turn', 'call')).toBeUndefined()
  store.close()
})

test('cancelled Agent keeps completed call and unknown attempt without a message; restart reader and Inspector agree', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'leitbild-execution-chain-'))
  temporary.push(directory)
  const path = join(directory, 'executions.sqlite')
  let store = createExecutionStore(path)
  const rooms = createRoomDirectory({ deliver: () => {} })
  const room = rooms.createRoom({ name: 'Room', createdBy: 'test' })
  const registry = createToolRegistry()
  const entered = deferred<void>()
  const release = deferred<ToolResult>()
  const lateRecorded = deferred<void>()
  const operationReleased = deferred<void>()
  let activeOperations = 0
  let releasedOperations = 0
  const firstResult = { success: true, data: { exact: 'x'.repeat(100_000) } }
  registry.register({ name: 'first', description: '', parameters: {}, execute: async () => firstResult })
  registry.register({ name: 'second', description: '', parameters: {}, execute: async () => { entered.resolve(); return release.promise } })
  const realRecordOutcome = store.recordOutcome
  const observedStore = { ...store, recordOutcome: (...args: Parameters<typeof store.recordOutcome>) => {
    expect(activeOperations).toBe(1)
    realRecordOutcome(...args)
    if (args[1] === 'call_0_1') lateRecorded.resolve()
  } }
  const runToolOperation: RunToolOperation = async work => {
    activeOperations++
    try { return await work() }
    finally { activeOperations--; if (++releasedOperations === 2) operationReleased.resolve() }
  }
  const provider = llm([{ toolCalls: [native('first'), native('second')] }])
  const agent = await spawnAIAgent({ name: 'Agent', model: 'test', persona: '', tools: ['first', 'second'] },
    { bound: () => provider } as unknown as LLMService, rooms, createWorkspaceSettings(), createTeam(),
    (_target, params) => [room.post(params)], registry, { executionStore: observedStore, runToolOperation })
  room.addMember(agent.id)
  await agent.join(room)
  agent.receive(room.post({ senderId: 'human', content: 'do both', type: 'chat' }))
  await entered.promise
  agent.cancelGeneration()
  await agent.whenIdle()
  expect(activeOperations).toBe(1)
  const turn = store.listTurns(room.profile.id)[0]!
  expect(turn.status).toBe('interrupted')
  expect(turn.messageId).toBeUndefined()
  expect(store.getCall(room.profile.id, turn.id, 'call_0_0')?.result).toEqual(firstResult)
  expect(store.getCall(room.profile.id, turn.id, 'call_0_1')?.result).toBeUndefined()
  const reader = createConversationReadTool(rooms, store)
  const context = { callerId: agent.id, callerName: agent.name, roomId: room.profile.id }
  expect(await reader.execute({ turnId: turn.id, toolCallId: 'call_0_1', part: 'result' }, context)).toMatchObject({ success: false, error: expect.stringContaining('outcome_unknown') })
  release.resolve({ success: true, data: { changed: 'late' } })
  await lateRecorded.promise
  // A completion callback resolves before its enclosing operation finally;
  // microtask flushing verifies the actual lifetime has now been released.
  await operationReleased.promise
  await Promise.resolve()
  expect(activeOperations).toBe(0)
  store.close()
  store = createExecutionStore(path)
  try {
    expect(store.getTurn(room.profile.id, turn.id)?.status).toBe('interrupted')
    const restartedReader = createConversationReadTool(rooms, store)
    const exact = await restartedReader.execute({ turnId: turn.id, toolCallId: 'call_0_1', part: 'result' }, context)
    const endpoint = `/rooms/${room.profile.id}/executions/${turn.id}/calls/call_0_1`
    const route = roomRoutes.find(route => route.method === 'GET' && route.pattern.test(endpoint))!
    const response = await route.handler(new Request(`http://localhost${endpoint}`), endpoint.match(route.pattern)!, { system: { rooms, executionStore: store } } as unknown as RouteContext)
    const inspector = await response.json() as { result: ToolResult }
    expect(exact).toMatchObject({ success: true, data: { evidenceKind: 'execution', result: inspector.result } })
    expect(room.getRetainedMessages().filter(message => message.senderId === agent.id)).toEqual([])
    expect(await restartedReader.execute({ turnId: turn.id }, { ...context, callerId: 'stranger' })).toMatchObject({ success: false })
  } finally { store.close() }
})

test('executed threshold outcome survives independently from final model request and compression', async () => {
  const previousCheckin = process.env.LEITBILD_TOOL_CHECKIN_ABANDON_MS
  process.env.LEITBILD_TOOL_CHECKIN_ABANDON_MS = '0'
  const store = createExecutionStore(':memory:')
  const rooms = createRoomDirectory({ deliver: () => {} })
  const room = rooms.createRoom({ name: 'Room', createdBy: 'test' })
  const registry = createToolRegistry()
  registry.register({ name: 'act', description: '', parameters: {}, execute: async () => ({ success: true, data: { revised: true } }) })
  const provider = llm([{ toolCalls: [native('act')] }])
  const agent = await spawnAIAgent({ name: 'Agent', model: 'test', persona: '', tools: ['act'], maxToolIterations: 0 },
    { bound: () => provider } as unknown as LLMService, rooms, createWorkspaceSettings(), createTeam(),
    (_target, params) => [room.post(params)], registry, { executionStore: store })
  if (previousCheckin === undefined) delete process.env.LEITBILD_TOOL_CHECKIN_ABANDON_MS
  else process.env.LEITBILD_TOOL_CHECKIN_ABANDON_MS = previousCheckin
  room.addMember(agent.id)
  await agent.join(room)
  agent.receive(room.post({ senderId: 'human', content: 'act', type: 'chat' }))
  await agent.whenIdle()
  try {
    const turn = store.listTurns(room.profile.id)[0]!
    expect(turn.status).toBe('failed')
    expect(turn.messageId).toBeDefined()
    expect(room.getGenerationQuery(turn.messageId!)?.query.messages.some(message => message.toolCalls?.length)).toBe(false)
    room.replaceCompression([turn.messageId!], 'The agent acted.')
    const result = await createConversationReadTool(rooms, store).execute({ turnId: turn.id, toolCallId: 'call_0_0', part: 'result' }, { callerId: agent.id, callerName: agent.name, roomId: room.profile.id })
    expect(result).toMatchObject({ success: true, data: { result: { success: true, data: { revised: true } } } })
    expect(store.listCalls(room.profile.id, turn.id)[0]?.providerCallId).toBe('Ab123Cd45')
  } finally { store.close() }
})
