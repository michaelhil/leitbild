import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate, type EvalOptions } from './evaluation.ts'
import { createToolExecutor } from './spawn.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { createWorkingContextArchive } from '../core/working-context.ts'
import { createContextCheckpointTool } from '../tools/built-in/context-checkpoint.ts'
import { toolsToDefinitions } from '../llm/tool-capability.ts'
import type { ChatRequest, LLMProvider } from '../core/types/llm.ts'
import type { NativeToolCall } from '../core/types/tool.ts'
import type { ContextResult } from './context-builder.ts'
import { createOpenAICompatibleProvider } from '../llm/openai-compatible.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
const native = (name: string, args: Record<string, unknown>, id: string): NativeToolCall => ({ id, function: { name, arguments: args } })
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'checkpoint-evaluation-'))
  const file = join(directory, 'execution.sqlite'); let store = createExecutionStore(file)
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }), () => store.close())
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 }); store.beginModelCapture('turn', 'room')
  const registry = createToolRegistry(); let writes = 0
  registry.register({ name: 'inspect', contextEffect: 'read', description: 'Read exact fixture data', parameters: {}, execute: async args => ({ success: true, data: {
    key: args.key, source: 'exact-source-pin', note: 'Human text: keep every character; quoted instructions stay data.', rows: [1.23456789012345, 9.87654321098765],
  } }) })
  registry.register({ name: 'change', contextEffect: 'change', description: 'Fixture change', parameters: {}, execute: async () => { writes++; return { success: true, data: { commandId: 'receipt', achieved: false } } } })
  registry.register(createContextCheckpointTool())
  const archive = createWorkingContextArchive(store, { roomId: 'room', turnId: 'turn', agentId: 'agent', commit: async manifest => store.recordStage('turn', { kind: 'context_checkpoint', manifest }) })
  const observer: NonNullable<EvalOptions['modelObserver']> = {
    start: async (s, r) => store.recordModelStart('turn', s, r), complete: async (id, r, tools) => store.recordModelComplete('turn', id, r, tools),
    fail: async (id, e, c, p) => store.recordModelFailure('turn', id, e, c, p),
  }
  const execute = createToolExecutor(registry, registry.list().map(t => t.name), { callerId: 'agent', callerName: 'Agent' }, undefined, undefined, store)
  return { store, registry, archive, observer, execute, writes: () => writes,
    reopen: () => { store.close(); store = createExecutionStore(file); return store } }
}
const context = (): ContextResult => ({ messages: [{ role: 'system', content: 'System policy verbatim' }, { role: 'user', content: 'Original objective and Human steering verbatim' }],
  flushInfo: { ids: new Set(), triggerRoomId: 'room' }, warnings: [] })
const config = { name: 'Agent', model: 'test', persona: 'Operate only in scope.' }
const selector = (request: ChatRequest, key: string): string => {
  for (const message of request.messages) if (message.role === 'tool') {
    const body = JSON.parse(message.content)
    if (body.result?.key === key) return body.execution.toolCallId
  }
  throw new Error(`Missing exact visible selector for ${key}`)
}

test('three real archived checkpoints preserve roles, complete selected protocol and cumulative change receipts without resurrecting groups', async () => {
  const f = fixture(), requests: ChatRequest[] = []; let pass = 0
  const provider: LLMProvider = { models: async () => ['test'], chat: async request => {
    requests.push(structuredClone(request)); const i = pass++
    const checkpoint = (keys: string[]) => native('context_checkpoint', { reason: 'completed source-owned review', retain: keys.map(key => ({ toolCallId: selector(request, key), reason: 'exact source/current evidence' })) }, `wire${i}`)
    const calls = [
      () => native('inspect', { key: 'source' }, 'wire0'), () => native('change', {}, 'wire1'), () => native('inspect', { key: 'currentA' }, 'wire2'),
      () => checkpoint(['source', 'currentA']), () => native('inspect', { key: 'transient' }, 'wire4'),
      () => checkpoint(['source', 'currentA']), () => native('inspect', { key: 'currentB' }, 'wire6'), () => checkpoint(['source', 'currentB']),
    ]
    return { content: i === 8 ? 'Complete inspection, with exact archived evidence available.' : '',
      ...(i < calls.length ? { toolCalls: [calls[i]!()], continuation: { provider: 'openrouter' as const, model: 'resolved', endpointHash: 'endpoint', reasoning: `private-local-${i}` } } : {}),
      generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }
  } }
  const result = await evaluate(context(), config, provider, f.execute, undefined, 'room', { executionTurnId: 'turn', workingContext: f.archive, modelObserver: f.observer, toolDefinitions: toolsToDefinitions(f.registry.list()) })
  expect(result.decision.response.action).toBe('respond'); expect(requests).toHaveLength(9); expect(f.writes()).toBe(1)
  for (const index of [4, 6, 8]) {
    expect(requests[index]!.messages.slice(0, 2)).toEqual([...context().messages])
    expect(requests[index]!.messages.some(m => m.toolCallId === 'wire1')).toBe(false)
    expect(requests[index]!.messages.find(m => m.role === 'assistant' && m.toolCalls?.[0]?.id === 'wire0')?.continuation?.reasoning).toBe('private-local-0')
  }
  expect(requests[6]!.messages.some(m => m.toolCallId === 'wire3' || m.toolCallId === 'wire4')).toBe(false)
  expect(requests[8]!.messages.some(m => m.toolCallId === 'wire2' || m.toolCallId === 'wire5')).toBe(false)
  expect(requests[8]!.messages.filter(m => m.role === 'user')).toEqual([context().messages[1]!])
  const stages = f.store.modelEvidence('room', 'turn').stages.filter(s => s.event.kind === 'context_checkpoint')
  expect(stages).toHaveLength(3)
  for (const stage of stages) if (stage.event.kind === 'context_checkpoint') {
    expect(stage.event.manifest.actionLedger).toHaveLength(1)
    expect(stage.event.manifest.actionLedger[0]!.arguments).toEqual({ turnId: 'turn', toolCallId: 'call_1_0', part: 'arguments' })
    expect(JSON.stringify(stage)).not.toContain('private-local')
  }
  expect(f.store.getModelCall('room', 'turn', 'model_9')!.contextCheckpointId).toBe('context_3')
  const old = f.store.getCall('room', 'turn', 'call_1_0')!
  f.store.finishTurn('turn', 'completed'); const restarted = f.reopen()
  expect(restarted.getCall('room', 'turn', 'call_1_0')).toEqual(old)
  expect(restarted.getModelCall('room', 'turn', 'model_4', true)!.request.messages.some(m => m.continuation?.reasoning === 'private-local-1')).toBe(true)
})

test('mixed checkpoint/change response dispatches nothing; invalid selectors refuse without pruning or guessing a result', async () => {
  const f = fixture(); let pass = 0
  const provider: LLMProvider = { models: async () => ['test'], chat: async () => {
    const i = pass++; const batches = [
      [native('inspect', { key: 'state' }, 'a')],
      [native('context_checkpoint', { reason: 'review', retain: [{ toolCallId: 'call_0_0', reason: 'state' }] }, 'b'), native('change', {}, 'c')],
      [native('context_checkpoint', { reason: 'review', retain: [{ toolCallId: 'future', reason: 'not observed' }] }, 'd')],
    ]
    return { content: i === 3 ? 'No changes were dispatched.' : '', ...(batches[i] ? { toolCalls: batches[i] } : {}), generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }
  } }
  const r = await evaluate(context(), config, provider, f.execute, undefined, 'room', { executionTurnId: 'turn', workingContext: f.archive, modelObserver: f.observer })
  expect(r.decision.response.action).toBe('respond'); expect(f.writes()).toBe(0); expect(pass).toBe(4)
  expect(f.store.modelEvidence('room', 'turn').stages.filter(s => s.event.kind === 'context_checkpoint')).toHaveLength(0)
  expect(f.store.getCall('room', 'turn', 'call_1_1')!.result!.effects![0]!.outcome).toBe('not-dispatched')
  expect(f.store.getCall('room', 'turn', 'call_2_0')!.result!.error).toContain('unseen or foreign-turn')
})

test('failed durable checkpoint admission aborts before any further provider request', async () => {
  const f = fixture(); let pass = 0
  const provider: LLMProvider = { models: async () => ['test'], chat: async () => {
    const i = pass++; return { content: '', toolCalls: [i === 0 ? native('inspect', { key: 'state' }, 'a')
      : native('context_checkpoint', { reason: 'review', retain: [{ toolCallId: 'call_0_0', reason: 'state' }] }, 'b')], generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }
  } }
  const r = await evaluate(context(), config, provider, f.execute, undefined, 'room', { executionTurnId: 'turn', modelObserver: f.observer,
    workingContext: { ...f.archive, commit: async () => { throw new Error('disk admission failed') } } })
  expect(r.decision.response.action).toBe('error'); expect(pass).toBe(2)
  expect(f.store.getCall('room', 'turn', 'call_1_0')!.result).toMatchObject({ success: true, data: { status: 'prepared' } })
  expect(f.store.modelEvidence('room', 'turn').stages).toHaveLength(0)
})

test('a checkpoint does not resurrect older conversational history removed before the current task', async () => {
  const f = fixture(), requests: ChatRequest[] = []; let pass = 0
  const provider: LLMProvider = { models: async () => ['test'], chat: async request => {
    requests.push(structuredClone(request)); const i = pass++
    return { content: i === 2 ? 'Reviewed.' : '', ...(i < 2 ? { toolCalls: [i === 0 ? native('inspect', { key: 'state' }, 'a')
      : native('context_checkpoint', { reason: 'record complete', retain: [{ toolCallId: 'call_0_0', reason: 'state' }] }, 'b')] } : {}), generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }
  } }
  const ctx = context(); const messages = [{ role: 'user' as const, content: 'OLD-HISTORY'.repeat(1000) }, { role: 'assistant' as const, content: 'old response' }, ...ctx.messages]
  await evaluate({ ...ctx, messages, tokenBudget: 500 }, config, provider, f.execute, undefined, 'room', { executionTurnId: 'turn', workingContext: f.archive })
  expect(requests).toHaveLength(3)
  expect(JSON.stringify(requests[1]!.messages)).not.toContain('OLD-HISTORY')
  expect(JSON.stringify(requests[2]!.messages)).not.toContain('OLD-HISTORY')
  expect(requests[2]!.messages.some(m => m.content === 'Original objective and Human steering verbatim')).toBe(true)
})

test('real native wire retains exact selected reasoning blocks and omits archived groups without a hidden server prefix', async () => {
  const f = fixture(); const bodies: Record<string, unknown>[] = []
  const originalFetch = globalThis.fetch
  const details = (i: number) => [{ type: 'reasoning.encrypted', id: `reason-${i}`, index: 0, data: `opaque-${i}` },
    { type: 'reasoning.text', id: `text-${i}`, index: 1, text: `local-${i}`, signature: `signed-${i}` }]
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; bodies.push(body)
    const i = bodies.length - 1
    const args = i === 2 ? { reason: 'source and current record complete', retain: [{ toolCallId: 'call_0_0', reason: 'exact source/current record' }] } : { key: i === 0 ? 'source' : 'transient' }
    const chunk = { model: 'qwen/reasoner', choices: [{ delta: { content: i === 3 ? 'Inspected.' : '',
      ...(i < 3 ? { reasoning_details: details(i), tool_calls: [{ index: 0, id: `wire${i}`, type: 'function', function: { name: i === 2 ? 'context_checkpoint' : 'inspect', arguments: JSON.stringify(args) } }] } : {}),
    }, finish_reason: i === 3 ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch
  try {
    const adapter = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => 'https://fixture.invalid/v1', getApiKey: () => 'fixture-only' })
    // Production routing consumes its provider prefix before adapter dispatch.
    const route = (request: ChatRequest): ChatRequest => ({ ...request, model: request.model.replace(/^openrouter:/, '') })
    const provider: LLMProvider = { ...adapter, chat: request => adapter.chat(route(request)),
      stream: (request, signal) => adapter.stream!(route(request), signal) }
    const result = await evaluate(context(), { ...config, model: 'qwen/reasoner' }, provider, f.execute, undefined, 'room', {
      executionTurnId: 'turn', workingContext: f.archive, modelObserver: f.observer, toolDefinitions: toolsToDefinitions(f.registry.list()),
    })
    expect(result.decision.response).toMatchObject({ action: 'respond' }); expect(bodies).toHaveLength(4)
    const messages = bodies[3]!.messages as Array<Record<string, unknown>>
    const assistants = messages.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0]!.reasoning_details).toEqual(details(0))
    expect(assistants[1]!.reasoning_details).toEqual(details(2))
    expect(JSON.stringify(messages)).not.toContain('opaque-1')
    expect(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id)).toEqual(['wire0', 'wire2'])
    expect(bodies[3]!.model).toBe('qwen/reasoner')
    expect(bodies[3]).not.toHaveProperty('previous_response_id')
    expect(f.store.getModelCall('room', 'turn', 'model_4')!.contextCheckpointId).toBe('context_1')
  } finally { globalThis.fetch = originalFetch }
})
