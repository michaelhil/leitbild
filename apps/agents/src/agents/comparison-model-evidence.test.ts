import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComparisons, type Comparisons } from './comparisons.ts'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import type { ChatRequest, LLMProvider } from '../core/types/llm.ts'
import type { LLMService } from '../llm/llm-service.ts'
import { comparisonRoutes } from '../api/routes/comparisons.ts'
import type { RouteContext } from '../api/routes/types.ts'

const prepare = async (provider: LLMProvider) => {
  const root = mkdtempSync(join(tmpdir(), 'leitbild-comparison-models-'))
  const rooms = createRoomDirectory(), room = rooms.createRoom({ name: 'Comparison', createdBy: 'human' })
  room.addMember('agent')
  const message = room.post({ senderId: 'agent', type: 'chat', content: 'Original answer is outside the comparison evidence.' })
  const executions = createExecutionStore(':memory:'), registry = createToolRegistry()
  registry.register({ name: 'product_read', description: 'Read reference', parameters: {}, execute: async () => ({ success: true, data: { observed: 'source evidence' } }) })
  const deps = { root, rooms, executions, registry, llm: { bound: () => provider } as LLMService, growth: async <T>(_bytes: number, work: () => Promise<T>) => work() }
  const service = createComparisons(deps)
  await service.capture({ executionTurnId: 'original', roomId: room.profile.id, agentId: 'agent', config: { name: 'Agent', model: 'provider:model', persona: '' },
    context: { messages: [{ role: 'user', content: 'Assess current evidence.' }], systemBlocks: [{ text: 'Current task instructions', cacheable: true }], warnings: [], flushInfo: { ids: new Set(), triggerRoomId: room.profile.id } },
    toolDefinitions: [{ type: 'function', function: { name: 'product_read', description: 'Read reference', parameters: {} } }], focusedSubjects: [] })
  service.link({ executionTurnId: 'original', roomId: room.profile.id, messageId: message.id })
  return { root, room, message, executions, service, deps,
    close: async () => { await service.close(); executions.close(); rmSync(root, { force: true, recursive: true }) } }
}
const finished = async (service: Comparisons, roomId: string, messageId: string, id: string) => {
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    const result = await service.detail(roomId, messageId, id)
    if (result.status !== 'running') return result
    await Bun.sleep(1)
  }
  throw new Error('Comparison fixture did not finish')
}
const metadata = { models: async () => ['provider:model'], modelInfo: async (id: string) => ({ id, provider: 'provider', source: 'fixture' as const, contextMax: 100_000 }) }
const response = (content: string) => ({ content, generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } })

test('comparison tool, model, correction and selected HTTP records survive reload with explicit protocol disclosure', async () => {
  const requests: ChatRequest[] = []
  const continuation = { provider: 'openrouter' as const, model: 'model', endpointHash: 'fixture-route', reasoning: 'PRIVATE-PROTOCOL' }
  const provider: LLMProvider = { ...metadata, chat: async request => {
    requests.push(structuredClone(request))
    return requests.length === 1 ? { ...response(''), continuation, toolCalls: [{ id: 'wire', function: { name: 'product_read', arguments: { path: 'reference' } } }] }
      : requests.length === 2 ? response('```map\n{"features":[{"type":"marker","lat":999,"lng":5}]}\n```') : response('Corrected answer.')
  } }
  const state = await prepare(provider)
  let reloaded: Comparisons | undefined
  try {
    const started = await state.service.start(state.room.profile.id, state.message.id, 'provider:model')
    const result = await finished(state.service, state.room.profile.id, state.message.id, started.id)
    expect(result.execution.models.map(call => call.phase)).toEqual(['initial', 'tool-response', 'correction'])
    expect(result.execution.calls.map(call => call.id)).toEqual(['call_0_0'])
    expect(result.execution.models[0]?.requestedTools?.[0]?.executionCallId).toBe('call_0_0')
    expect(JSON.stringify(result.execution)).not.toContain('PRIVATE-PROTOCOL')
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      const normal = await state.service.model(state.room.profile.id, state.message.id, started.id, `model_${ordinal}`)
      const exact = await state.service.model(state.room.profile.id, state.message.id, started.id, `model_${ordinal}`, true)
      expect(JSON.stringify(normal)).not.toContain('PRIVATE-PROTOCOL')
      expect(exact?.request).toEqual(requests[ordinal - 1])
    }
    expect(JSON.stringify(requests)).not.toContain('Original answer is outside')
    const path = `/rooms/${state.room.profile.id}/messages/${state.message.id}/comparisons/${started.id}/models/model_2`
    const endpoint = comparisonRoutes.find(route => route.method === 'GET' && route.pattern.test(path))!
    const context = { system: { comparisons: state.service } } as unknown as RouteContext
    const normal = await endpoint.handler(new Request(`http://fixture${path}`), path.match(endpoint.pattern)!, context)
    expect(JSON.stringify(await normal.json())).not.toContain('PRIVATE-PROTOCOL')
    const sensitive = await endpoint.handler(new Request(`http://fixture${path}?sensitive=1`), path.match(endpoint.pattern)!, context)
    expect(JSON.stringify(await sensitive.json())).toContain('PRIVATE-PROTOCOL')
    const invalid = await endpoint.handler(new Request(`http://fixture${path}?sensitive=yes`), path.match(endpoint.pattern)!, context)
    expect(invalid.status).toBe(400)
    await expect(state.service.model('unrelated-room', state.message.id, started.id, 'model_1', true)).rejects.toThrow()
    await state.service.close()
    reloaded = createComparisons(state.deps)
    expect((await reloaded.detail(state.room.profile.id, state.message.id, started.id)).execution.models).toHaveLength(3)
    expect((await reloaded.model(state.room.profile.id, state.message.id, started.id, 'model_3'))?.response?.content).toBe('Corrected answer.')
    const directory = join(state.root, state.room.profile.id, state.message.id, 'models', started.id)
    expect(existsSync(directory)).toBe(true)
    rmSync(directory, { recursive: true })
    const withoutCapture = await reloaded.detail(state.room.profile.id, state.message.id, started.id)
    expect(withoutCapture.execution.modelCapture).toBe('unavailable')
    expect(withoutCapture.execution.models).toEqual([])
    expect(withoutCapture.metrics?.modelCalls).toBe(3) // Counts do not reconstruct missing requests.
    await reloaded.remove(state.room.profile.id, state.message.id, started.id)
    expect(existsSync(directory)).toBe(false)
    await expect(reloaded.model(state.room.profile.id, state.message.id, started.id, 'model_1')).rejects.toThrow('Comparison not found')
  } finally { await reloaded?.close(); await state.close() }
})

test('a failed comparison retains the failed model after an actual successful read', async () => {
  let pass = 0
  const state = await prepare({ ...metadata, chat: async () => {
    if (++pass === 1) return { ...response(''), toolCalls: [{ function: { name: 'product_read', arguments: {} } }] }
    throw new Error('Observed provider failure')
  } })
  try {
    const started = await state.service.start(state.room.profile.id, state.message.id, 'provider:model')
    const result = await finished(state.service, state.room.profile.id, state.message.id, started.id)
    expect(result.status).toBe('failed')
    expect(result.execution.models.map(call => call.status)).toEqual(['completed', 'failed'])
    expect((await state.service.call(state.room.profile.id, state.message.id, started.id, 'call_0_0'))?.result?.success).toBe(true)
    expect((await state.service.model(state.room.profile.id, state.message.id, started.id, 'model_2'))?.error).toBe('Observed provider failure')
  } finally { await state.close() }
})

test('cancelled model streams retain partial evidence and source removal removes the entire model lifetime', async () => {
  const entered = Promise.withResolvers<void>()
  const state = await prepare({ ...metadata, chat: async () => response('Unexpected'), stream: async function* (_request, signal) {
    yield { delta: 'Known partial text', done: false }
    entered.resolve()
    await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
  } })
  try {
    const started = await state.service.start(state.room.profile.id, state.message.id, 'provider:model')
    await entered.promise
    await state.service.cancel(state.room.profile.id, state.message.id, started.id)
    const result = await finished(state.service, state.room.profile.id, state.message.id, started.id)
    expect(result.status).toBe('interrupted')
    expect(result.execution.models[0]?.status).toBe('cancelled')
    expect((await state.service.model(state.room.profile.id, state.message.id, started.id, 'model_1'))?.response?.content).toBe('Known partial text')
    state.room.deleteMessage(state.message.id)
    state.service.removeMessages(state.room.profile.id, state.message.id)
    await state.service.close()
    expect(existsSync(join(state.root, state.room.profile.id, state.message.id))).toBe(false)
  } finally { await state.close() }
})

test('source deletion while a model is pending prevents late evidence resurrection', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let calls = 0
  const state = await prepare({ ...metadata, chat: async () => { calls++; entered.resolve(); await release.promise; return response('Late output') } })
  try {
    const started = await state.service.start(state.room.profile.id, state.message.id, 'provider:model')
    await entered.promise
    state.room.deleteMessage(state.message.id)
    state.service.removeMessages(state.room.profile.id, state.message.id)
    release.resolve()
    await state.service.close()
    expect(calls).toBe(1)
    expect(existsSync(join(state.root, state.room.profile.id, state.message.id))).toBe(false)
    await expect(state.service.model(state.room.profile.id, state.message.id, started.id, 'model_1')).rejects.toThrow()
  } finally { release.resolve(); await state.close() }
})
