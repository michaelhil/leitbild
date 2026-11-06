import { expect, test } from 'bun:test'
import { buildToolSupport } from './spawn.ts'
import { evaluate } from './evaluation.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import type { ChatRequest, LLMProvider } from '../core/types/llm.ts'
import { recordedExecutionCosts } from '../ui/modules/modals/execution-journey.ts'

const result = (content = 'Result') => ({ content, generationMs: 0, tokensUsed: { prompt: 7, completion: 3 }, finishReason: 'stop', billing: { costUsd: 0.25 } })
const until = async (condition: () => boolean) => {
  const deadline = performance.now() + 30000 // Test watchdog, not a model/tool budget.
  while (!condition()) { if (performance.now() > deadline) throw new Error('Actual late outcome not retained'); await Bun.sleep(1) }
}

test('cancellation blocks later nested requests and retains the actual late billed result under its interrupted tool', async () => {
  const abort = new AbortController(), store = createExecutionStore(':memory:'), registry = createToolRegistry()
  let calls = 0
  const provider: LLMProvider = { models: async () => ['fixture'], chat: async () => { calls++; abort.abort(); return result() } }
  registry.register({ name: 'nested', description: 'Nested helper', parameters: {}, execute: async (_params, context) => {
    await context.llm!({ messages: [{ role: 'user', content: 'First' }] })
    await context.llm!({ messages: [{ role: 'user', content: 'Second must not dispatch' }] })
    return { success: true }
  } })
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 })
  try {
    const support = await buildToolSupport(['nested'], registry, { id: 'agent', name: 'Agent', currentLLMSettings: () => ({ model: 'fixture' }) }, provider, undefined, store)
    await expect(support.toolExecutor!([{ callId: 'call_0_0', tool: 'nested', arguments: {} }], 'room', abort.signal, 'turn')).rejects.toThrow('outcome is unknown')
    await until(() => store.getCall('room', 'turn', 'call_0_0')?.result !== undefined)
    expect(calls).toBe(1)
    expect(store.getTurn('room', 'turn')!.status).toBe('interrupted')
    const models = store.modelEvidence('room', 'turn').models
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ phase: 'nested', parentToolCallId: 'call_0_0', status: 'completed', metrics: { costUsd: 0.25 } })
    expect(store.getModelCall('room', 'turn', models[0]!.id)!.request.messages).toEqual([{ role: 'user', content: 'First' }])
    expect(recordedExecutionCosts(models)).toEqual({ attempts: 1, costReportedCalls: 1, unknownCalls: 0, reportedCostUsd: 0.25 })
  } finally { store.close() }
})

test('a stream-capable nested provider receives the tool abort and leaves explicit partial evidence', async () => {
  const abort = new AbortController(), entered = Promise.withResolvers<void>(), store = createExecutionStore(':memory:'), registry = createToolRegistry()
  let received: AbortSignal | undefined
  const provider: LLMProvider = {
    models: async () => ['fixture'], chat: async () => { throw new Error('Streaming provider should receive abort') },
    stream: async function* (_request, signal) {
      received = signal; entered.resolve()
      yield { delta: 'Partial', done: false }
      await new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason)
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
  }
  registry.register({ name: 'nested', description: 'Nested helper', parameters: {}, execute: async (_params, context) => ({ success: true, data: await context.llm!({ messages: [{ role: 'user', content: 'Work' }] }) }) })
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 })
  try {
    const support = await buildToolSupport(['nested'], registry, { id: 'agent', name: 'Agent', currentLLMSettings: () => ({ model: 'fixture' }) }, provider, undefined, store)
    const execution = support.toolExecutor!([{ callId: 'call_0_0', tool: 'nested', arguments: {} }], 'room', abort.signal, 'turn')
    await entered.promise; abort.abort()
    await expect(execution).rejects.toThrow('outcome is unknown')
    await until(() => store.getCall('room', 'turn', 'call_0_0')?.result !== undefined)
    expect(received?.aborted).toBe(true)
    const model = store.modelEvidence('room', 'turn').models[0]!
    expect(model.status).toBe('cancelled')
    expect(store.getModelCall('room', 'turn', model.id)!.response!.content).toBe('Partial')
    expect(recordedExecutionCosts([model]).unknownCalls).toBe(1)
  } finally { store.close() }
})

test('nested helpers freeze settings per invocation while the next invocation receives desired edits', async () => {
  const registry = createToolRegistry(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), requests: ChatRequest[] = []
  let model = 'original'
  const provider: LLMProvider = { models: async () => ['original', 'changed'], chat: async request => {
    requests.push(request)
    if (requests.length === 1) { entered.resolve(); await release.promise }
    return result()
  } }
  registry.register({ name: 'nested', description: 'Nested helper', parameters: {}, execute: async (_params, context) => {
    for (const content of ['One', 'Two']) await context.llm!({ messages: [{ role: 'user', content }] })
    return { success: true }
  } })
  const support = await buildToolSupport(['nested'], registry, { id: 'agent', name: 'Agent', currentLLMSettings: () => ({ model, seed: 17 }) }, provider)
  const first = support.toolExecutor!([{ tool: 'nested', arguments: {} }], 'room')
  await entered.promise; model = 'changed'; release.resolve(); await first
  const second = await support.toolExecutor!([{ tool: 'nested', arguments: {} }], 'room')
  expect(requests.map(request => request.model)).toEqual(['original', 'original', 'changed', 'changed'])
  expect(requests.every(request => request.seed === 17)).toBe(true)
  expect(second[0]!.nestedModelCalls).toHaveLength(2)
})

test('ordinary turn and Inspector include nested usage once without feeding billing metadata to the model', async () => {
  const store = createExecutionStore(':memory:'), registry = createToolRegistry(), requests: ChatRequest[] = []
  let outer = 0
  const provider: LLMProvider = { models: async () => ['fixture'], chat: async () => { throw new Error('Use stream') }, stream: async function* (request) {
    requests.push(request)
    if (request.tools === undefined) { yield { delta: 'Nested result', done: true, finishReason: 'stop', tokensUsed: { prompt: 7, completion: 3 }, billing: { costUsd: 0.25 } }; return }
    outer++
    yield { delta: outer === 1 ? '' : 'Done.', done: true, finishReason: 'stop', tokensUsed: { prompt: 2, completion: 1 }, billing: { costUsd: outer === 1 ? 0.1 : 0.2 },
      ...(outer === 1 ? { toolCalls: [{ function: { name: 'nested', arguments: {} } }] } : {}) }
  } }
  registry.register({ name: 'nested', description: 'Nested helper', parameters: {}, execute: async (_params, context) => ({ success: true, data: await context.llm!({ messages: [{ role: 'user', content: 'Only tool input' }] }) }) })
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 }); store.beginModelCapture('turn', 'room')
  try {
    const support = await buildToolSupport(['nested'], registry, { id: 'agent', name: 'Agent', currentLLMSettings: () => ({ model: 'fixture' }) }, provider, undefined, store)
    const answer = await evaluate({ messages: [{ role: 'user', content: 'Work' }], warnings: [], flushInfo: { ids: new Set(), triggerRoomId: 'room' } }, { name: 'Agent', model: 'fixture', persona: 'Help' }, provider, support.toolExecutor, undefined, 'room', {
      executionTurnId: 'turn', toolDefinitions: support.toolDefinitions,
      modelObserver: { start: async (summary, request) => store.recordModelStart('turn', summary, request), complete: async (id, response, tools) => store.recordModelComplete('turn', id, response, tools), fail: async (id, error, cancelled, partial) => store.recordModelFailure('turn', id, error, cancelled, partial) },
    })
    expect(answer.decision.metrics).toMatchObject({ modelCalls: 3, costReportedCalls: 3, promptTokens: 11, completionTokens: 5 })
    expect(answer.decision.metrics!.reportedCostUsd).toBeCloseTo(0.55)
    const models = store.modelEvidence('room', 'turn').models
    expect(models.map(model => model.phase)).toEqual(['initial', 'nested', 'tool-response'])
    expect(new Set(models.map(model => model.id)).size).toBe(3)
    expect(recordedExecutionCosts(models).reportedCostUsd).toBeCloseTo(0.55)
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain('nestedModelCalls')
  } finally { store.close() }
})

test('failed nested completion retains observed billing and cannot be mistaken for a usable answer', async () => {
  const store = createExecutionStore(':memory:'), registry = createToolRegistry()
  const provider: LLMProvider = { models: async () => ['fixture'], chat: async () => ({ ...result('Partial'), finishReason: 'length' }) }
  registry.register({ name: 'nested', description: 'Nested helper', parameters: {}, execute: async (_params, context) => ({ success: true, data: await context.llm!({ messages: [{ role: 'user', content: 'Work' }] }) }) })
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 })
  try {
    const support = await buildToolSupport(['nested'], registry, { id: 'agent', name: 'Agent', currentLLMSettings: () => ({ model: 'fixture' }) }, provider, undefined, store)
    const result = (await support.toolExecutor!([{ callId: 'call_0_0', tool: 'nested', arguments: {} }], 'room', undefined, 'turn'))[0]!
    expect(result.success).toBe(false)
    expect(store.modelEvidence('room', 'turn').models[0]).toMatchObject({ status: 'failed', metrics: { costUsd: 0.25 } })
  } finally { store.close() }
})

test('an early nested stream consumer closes provider resources and records partial rather than ghost completion', async () => {
  const store = createExecutionStore(':memory:'), registry = createToolRegistry()
  let closed = false
  const provider: LLMProvider = { models: async () => ['fixture'], chat: async () => result(), stream: async function* () {
    try { yield { delta: 'First chunk', done: false }; yield { delta: 'Never consumed', done: true, finishReason: 'stop' } }
    finally { closed = true }
  } }
  registry.register({ name: 'nested', description: 'Nested helper', parameters: {}, execute: async (_params, context) => {
    for await (const _delta of context.llmStream!({ messages: [{ role: 'user', content: 'Work' }] })) break
    return { success: true }
  } })
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 })
  try {
    const support = await buildToolSupport(['nested'], registry, { id: 'agent', name: 'Agent', currentLLMSettings: () => ({ model: 'fixture' }) }, provider, undefined, store)
    await support.toolExecutor!([{ callId: 'call_0_0', tool: 'nested', arguments: {} }], 'room', undefined, 'turn')
    expect(closed).toBe(true)
    const model = store.modelEvidence('room', 'turn').models[0]!
    expect(model.status).toBe('failed')
    expect(store.getModelCall('room', 'turn', model.id)).toMatchObject({ error: 'Nested stream consumer stopped before completion', response: { content: 'First chunk' } })
  } finally { store.close() }
})

test('nested output preserves unexecuted native requests and withholds protocol under the existing Inspector boundary', async () => {
  const store = createExecutionStore(':memory:'), registry = createToolRegistry()
  const continuation = { provider: 'openrouter' as const, model: 'fixture', endpointHash: 'a'.repeat(64), reasoning: 'fixture-only opaque protocol' }
  const provider: LLMProvider = { models: async () => ['fixture'], chat: async () => result(), stream: async function* () {
    yield { delta: 'Observed output', done: true, finishReason: 'stop', continuation, toolCalls: [{ id: 'provider-request', function: { name: 'never_execute', arguments: { target: 'fixture' } } }] }
  } }
  registry.register({ name: 'nested', description: 'Nested helper', parameters: {}, execute: async (_params, context) => ({ success: true, data: await context.llm!({ messages: [{ role: 'user', content: 'Work' }] }) }) })
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 })
  try {
    const support = await buildToolSupport(['nested'], registry, { id: 'agent', name: 'Agent', currentLLMSettings: () => ({ model: 'fixture' }) }, provider, undefined, store)
    await support.toolExecutor!([{ callId: 'call_0_0', tool: 'nested', arguments: {} }], 'room', undefined, 'turn')
    const model = store.modelEvidence('room', 'turn').models[0]!
    expect(model.requestedTools).toEqual([{ tool: 'never_execute', providerCallId: 'provider-request' }])
    expect(store.listCalls('room', 'turn')).toHaveLength(1)
    const readable = store.getModelCall('room', 'turn', model.id)!
    expect(readable.protocolWithheld).toBe(true)
    expect(readable.response!.continuation).toBeUndefined()
    expect(store.getModelCall('room', 'turn', model.id, true)!.response!.continuation).toEqual(continuation)
  } finally { store.close() }
})
