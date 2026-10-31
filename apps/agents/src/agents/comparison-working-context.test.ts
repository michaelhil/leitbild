import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComparisons, type Comparisons } from './comparisons.ts'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { createContextCheckpointTool } from '../tools/built-in/context-checkpoint.ts'
import { createConversationReadTool } from '../tools/built-in/conversation-read.ts'
import type { ChatRequest, ChatResponse, LLMProvider } from '../core/types/llm.ts'
import type { LLMService } from '../llm/llm-service.ts'
import type { ExecutionGrowth } from './spawn.ts'

const response = (content = ''): ChatResponse => ({ content, generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } })
const invoke = (name: string, args: Record<string, unknown> = {}): ChatResponse => ({ ...response(), toolCalls: [{ id: `wire-${name}`, function: { name, arguments: args } }] })
const resultIn = (request: ChatRequest, name: string) => {
  const message = request.messages.findLast(message => message.role === 'tool' && message.name === name)
  if (!message) throw new Error(`Fixture did not receive ${name}`)
  return JSON.parse(message.content)
}
const hasDurableCheckpointReceipt = (directory: string | undefined): boolean => directory !== undefined && existsSync(directory)
  && readdirSync(directory).filter(file => file.endsWith('.json')).some(file => {
    const value = JSON.parse(readFileSync(join(directory, file), 'utf8')) as { calls: Array<{ tool: string; completedAt?: number; result?: { success: boolean } }> }
    return value.calls.some(call => call.tool === 'context_checkpoint' && call.completedAt !== undefined && call.result?.success)
  })
const untilFinished = async (service: Comparisons, roomId: string, messageId: string, id: string) => {
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    const value = await service.detail(roomId, messageId, id)
    if (value.status !== 'running') return value
    await Bun.sleep(1)
  }
  throw new Error('Comparison did not finish')
}
const setup = async (chat: LLMProvider['chat'], growth: ExecutionGrowth = async (_bytes, work) => work()) => {
  const root = mkdtempSync(join(tmpdir(), 'leitbild-comparison-checkpoint-'))
  const rooms = createRoomDirectory(), room = rooms.createRoom({ name: 'Isolated comparison', createdBy: 'human' })
  room.addMember('agent')
  const message = room.post({ senderId: 'agent', type: 'chat', content: 'Original answer is not comparison evidence.' })
  const executions = createExecutionStore(':memory:'), registry = createToolRegistry(), requests: ChatRequest[] = []
  registry.register(createContextCheckpointTool())
  registry.register(createConversationReadTool(rooms, executions))
  registry.register({ name: 'product_read', contextEffect: 'read', description: 'Read source', parameters: {}, execute: async input => ({ success: true, data: { source: input.path, exact: `retained-${input.path}` } }) })
  const provider: LLMProvider = { models: async () => ['fixture:model'], modelInfo: async id => ({ id, provider: 'fixture', source: 'fixture', contextMax: 100_000 }), chat: async request => { requests.push(structuredClone(request)); return chat(request) } }
  const deps = { root, rooms, executions, registry, llm: { bound: () => provider } as LLMService, growth }
  const service = createComparisons(deps)
  await service.capture({ executionTurnId: 'original-turn', roomId: room.profile.id, agentId: 'agent', config: { name: 'Agent', persona: '', model: 'fixture:model' },
    context: { messages: [{ role: 'user', content: 'Assess exact source evidence.' }], warnings: [], flushInfo: { ids: new Set(), triggerRoomId: room.profile.id } },
    toolDefinitions: ['product_read', 'conversation_read', 'context_checkpoint'].map(name => ({ type: 'function', function: { name, description: name, parameters: {} } })), focusedSubjects: [] })
  service.link({ executionTurnId: 'original-turn', roomId: room.profile.id, messageId: message.id })
  return { root, room, message, executions, requests, service, deps, close: async () => { await service.close(); executions.close(); rmSync(root, { force: true, recursive: true }) } }
}

test('comparison checkpoint projects whole native groups, recalls exact archived evidence and survives restart without normal-history writes', async () => {
  let round = 0, archived: { turnId: string; toolCallId: string; part: 'result' } | undefined
  const continuation = { provider: 'openrouter' as const, model: 'fixture:model', endpointHash: 'test', reasoning: 'private native continuation' }
  const state = await setup(async request => {
    switch (++round) {
      case 1: return { ...invoke('product_read', { path: 'old-source' }), continuation }
      case 2:
        archived = resultIn(request, 'product_read').execution
        return { ...invoke('product_read', { path: 'current-source' }), continuation }
      case 3: return invoke('context_checkpoint', { reason: 'Completed source comparison', retain: [{ toolCallId: resultIn(request, 'product_read').execution.toolCallId, reason: 'Current deciding source' }] })
      case 4:
        expect(request.messages.filter(message => message.role === 'tool' && message.name === 'product_read')).toHaveLength(1)
        expect(resultIn(request, 'product_read').result.source).toBe('current-source')
        expect(request.messages.find(message => message.role === 'assistant' && message.toolCalls?.[0]?.function.name === 'product_read')?.continuation).toEqual(continuation)
        return invoke('conversation_read', archived!)
      default:
        expect(resultIn(request, 'conversation_read').result.result.data).toEqual({ source: 'old-source', exact: 'retained-old-source' })
        return response('Exact archived source checked.')
    }
  })
  let reloaded: Comparisons | undefined
  try {
    const history = state.room.getRetainedMessages()
    const started = await state.service.start(state.room.profile.id, state.message.id, 'fixture:model')
    const result = await untilFinished(state.service, state.room.profile.id, state.message.id, started.id)
    expect(result.status).toBe('completed')
    expect(result.content).toBe('Exact archived source checked.')
    expect(result.execution.stages.filter(stage => stage.event.kind === 'context_checkpoint')).toHaveLength(1)
    expect(result.execution.models[3]?.contextCheckpointId).toBe('context_1')
    expect(result.calls.map(call => call.result?.recall?.turnId)).toEqual(Array(4).fill(started.id))
    expect(result.calls[0]?.providerCallId).toBe('wire-product_read')
    expect(state.executions.listTurns(state.room.profile.id)).toEqual([])
    expect(state.room.getRetainedMessages()).toEqual(history)
    await state.service.close()
    reloaded = createComparisons(state.deps)
    const after = await reloaded.detail(state.room.profile.id, state.message.id, started.id)
    expect(after.calls).toEqual(result.calls)
    expect(after.execution.stages).toEqual(result.execution.stages)
    expect((await reloaded.model(state.room.profile.id, state.message.id, started.id, 'model_4', true))?.request).toEqual(state.requests[3])
    await reloaded.remove(state.room.profile.id, state.message.id, started.id)
    await expect(reloaded.detail(state.room.profile.id, state.message.id, started.id)).rejects.toThrow('Comparison not found')
  } finally { await reloaded?.close(); await state.close() }
})

test('a mixed checkpoint group rejects every call before dispatch and leaves the prompt intact', async () => {
  let round = 0
  const state = await setup(async request => {
    if (++round === 1) return invoke('product_read', { path: 'source' })
    if (round === 2) return { ...response(), toolCalls: [
      { id: 'checkpoint', function: { name: 'context_checkpoint', arguments: { reason: 'Invalid mixed response', retain: [{ toolCallId: resultIn(request, 'product_read').execution.toolCallId, reason: 'Source' }] } } },
      { id: 'forbidden-peer', function: { name: 'product_read', arguments: { path: 'must-not-run' } } },
    ] }
    expect(request.messages.filter(message => message.role === 'tool' && message.name === 'product_read')).toHaveLength(2)
    return response('Mixed calls were refused.')
  })
  try {
    const started = await state.service.start(state.room.profile.id, state.message.id, 'fixture:model')
    const result = await untilFinished(state.service, state.room.profile.id, state.message.id, started.id)
    expect(result.status).toBe('completed')
    expect(result.calls.slice(1).every(call => call.result?.error?.startsWith('context_checkpoint_requires_own_response'))).toBe(true)
    expect(result.calls.slice(1).every(call => call.result?.effects?.[0]?.outcome === 'not-dispatched')).toBe(true)
    expect(result.execution.stages.some(stage => stage.event.kind === 'context_checkpoint')).toBe(false)
    expect(result.execution.models.every(model => model.contextCheckpointId === undefined)).toBe(true)
  } finally { await state.close() }
})

test('checkpoint admission failure stops before the next model request', async () => {
  let round = 0, receiptDirectory: string | undefined, rejected = false
  const state = await setup(async request => {
    if (++round === 1) return invoke('product_read', { path: 'source' })
    return invoke('context_checkpoint', { reason: 'Completed source read', retain: [{ toolCallId: resultIn(request, 'product_read').execution.toolCallId, reason: 'Deciding source' }] })
  }, async (_bytes, work) => {
    // The response and call receipt still admit successfully; reject only the
    // durable checkpoint stage, exactly at its model-evidence write boundary.
    if (!rejected && hasDurableCheckpointReceipt(receiptDirectory)) { rejected = true; throw new Error('Fixture storage admission rejected checkpoint') }
    return work()
  })
  try {
    receiptDirectory = join(state.root, state.room.profile.id, state.message.id, 'alternatives')
    const started = await state.service.start(state.room.profile.id, state.message.id, 'fixture:model')
    const result = await untilFinished(state.service, state.room.profile.id, state.message.id, started.id)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('storage admission rejected checkpoint')
    expect(state.requests).toHaveLength(2)
    expect(result.execution.stages.some(stage => stage.event.kind === 'context_checkpoint')).toBe(false)
  } finally { await state.close() }
})

test('cancellation during checkpoint admission preserves the full archive and prevents another model call', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let round = 0, receiptDirectory: string | undefined, paused = false
  const state = await setup(async request => {
    if (++round === 1) return invoke('product_read', { path: 'source' })
    return invoke('context_checkpoint', { reason: 'Completed source read', retain: [{ toolCallId: resultIn(request, 'product_read').execution.toolCallId, reason: 'Deciding source' }] })
  }, async (_bytes, work) => {
    if (!paused && hasDurableCheckpointReceipt(receiptDirectory)) { paused = true; entered.resolve(); await release.promise }
    return work()
  })
  try {
    receiptDirectory = join(state.root, state.room.profile.id, state.message.id, 'alternatives')
    const started = await state.service.start(state.room.profile.id, state.message.id, 'fixture:model')
    await entered.promise
    await state.service.cancel(state.room.profile.id, state.message.id, started.id)
    release.resolve()
    const result = await untilFinished(state.service, state.room.profile.id, state.message.id, started.id)
    expect(result.status).toBe('interrupted')
    expect(state.requests).toHaveLength(2)
    expect(result.calls[0]?.result?.data).toEqual({ source: 'source', exact: 'retained-source' })
    expect(result.execution.stages.some(stage => stage.event.kind === 'context_checkpoint')).toBe(false)
  } finally { release.resolve(); await state.close() }
})
