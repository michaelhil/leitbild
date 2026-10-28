import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionStore } from '../core/executions/store.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { createWorkspaceSettings } from '../core/workspaces/settings.ts'
import { createTeam } from './team.ts'
import { spawnAIAgent } from './spawn.ts'
import { roomRoutes } from '../api/routes/rooms.ts'
import type { RouteContext } from '../api/routes/types.ts'
import type { LLMProvider } from '../core/types/llm.ts'
import type { LLMService } from '../llm/llm-service.ts'
import type { LLMServiceBindOptions } from '../llm/llm-service.ts'
import { createCloudProviderError } from '../llm/errors.ts'
import type { AIAgent } from '../core/types/agent.ts'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

test('a real Agent/tool/inspection chain retains every request, correction and repeated provider-id execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'leitbild-model-chain-')); temporary.push(dir)
  const store = createExecutionStore(join(dir, 'executions.sqlite'))
  const rooms = createRoomDirectory({ deliver: () => {} }), room = rooms.createRoom({ name: 'Room', createdBy: 'test' })
  const tools = createToolRegistry()
  tools.register({ name: 'read_value', description: 'Read current value', parameters: {}, execute: async () => ({ success: true, data: { reading: 42 } }) })
  let pass = 0
  let chainSwitch: LLMServiceBindOptions['onChainSwitch']
  let liveFallbacks = 0
  const provider: LLMProvider = { models: async () => ['test'], chat: async request => {
    pass++
    const turn = store.listTurns(room.profile.id)[0]!, evidence = store.modelEvidence(room.profile.id, turn.id)
    expect(evidence.models).toHaveLength(pass) // Durable before the provider receives the request.
    expect(store.getModelCall(room.profile.id, turn.id, `model_${pass}`, true)?.request).toEqual(request)
    if (pass <= 2) chainSwitch?.('test', 'backup', 'preferred_unavailable')
    return { content: pass <= 2 ? '' : pass === 3 ? '```map\n{"type":"bad"}\n```' : 'Measured value is available.',
      ...(pass <= 2 ? { toolCalls: [{ id: 'same-provider-id', function: { name: 'read_value', arguments: { pass } } }] } : {}),
      ...(pass === 1 ? { continuation: { provider: 'openrouter' as const, model: 'test', endpointHash: 'test-endpoint', reasoning: 'opaque-test-protocol' } } : {}),
      generationMs: 1, tokensUsed: { prompt: pass, completion: 1 }, model: 'test', provider: 'unit-test' }
  } }
  const agent = await spawnAIAgent({ name: 'Agent', model: 'test', persona: 'Use evidence.', tools: ['read_value'] },
    { bound: options => { chainSwitch = options.onChainSwitch; return provider } } satisfies LLMService, rooms, createWorkspaceSettings(), createTeam(),
    (_target, params) => [room.post(params)], tools, { executionStore: store, onEvalEvent: (_scope, event) => { if (event.kind === 'model_fallback') liveFallbacks++ } })
  room.addMember(agent.id); await agent.join(room)
  agent.receive(room.post({ senderId: 'human', content: 'Inspect the value, verify it and show a map.', type: 'chat' }))
  await agent.whenIdle()
  try {
    const turn = store.listTurns(room.profile.id)[0]!, evidence = store.modelEvidence(room.profile.id, turn.id)
    expect(turn.status).toBe('completed')
    expect(evidence.models.map(model => model.phase)).toEqual(['initial', 'tool-response', 'tool-response', 'correction'])
    expect(evidence.models.every(model => model.status === 'completed')).toBe(true)
    expect(evidence.models[0]?.requestedTools).toEqual([{ executionCallId: 'call_0_0', providerCallId: 'same-provider-id', tool: 'read_value' }])
    expect(evidence.models[1]?.requestedTools?.[0]?.executionCallId).toBe('call_1_0')
    expect(store.listCalls(room.profile.id, turn.id).map(call => call.id)).toEqual(['call_0_0', 'call_1_0'])
    expect(store.getModelCall(room.profile.id, turn.id, 'model_1')?.request.messages.some(message => message.role === 'tool')).toBe(false)
    expect(store.getModelCall(room.profile.id, turn.id, 'model_2')?.request.messages.some(message => message.role === 'tool')).toBe(true)
    expect(store.getModelCall(room.profile.id, turn.id, 'model_4')?.request.messages.at(-1)?.content).toContain('invalid fenced blocks')
    expect(evidence.stages.map(stage => stage.event.kind)).toContain('correction')
    expect(evidence.stages.filter(stage => stage.event.kind === 'model_fallback')).toHaveLength(2)
    expect(liveFallbacks).toBe(1) // Live notice dedup never discards inspection evidence.
    expect(evidence.stages[0]?.event).toMatchObject({ kind: 'context_ready' })
    const path = `/rooms/${room.profile.id}/executions/${turn.id}`
    const endpoint = roomRoutes.find(route => route.method === 'GET' && route.pattern.test(path))!
    const context = { system: { rooms, executionStore: store } } as unknown as RouteContext
    const response = await endpoint.handler(new Request(`http://local${path}`), path.match(endpoint.pattern)!, context)
    expect(await response.json()).toMatchObject({ modelCapture: 'recorded', models: [{ id: 'model_1' }, { id: 'model_2' }, { id: 'model_3' }, { id: 'model_4' }] })
    const detailPath = `${path}/models/model_2`, detailRoute = roomRoutes.find(route => route.method === 'GET' && route.pattern.test(detailPath))!
    const detail = await detailRoute.handler(new Request(`http://local${detailPath}`), detailPath.match(detailRoute.pattern)!, context)
    const readable = await detail.json()
    expect(readable).toMatchObject({ id: 'model_2', status: 'completed', request: { model: 'openrouter:test' }, protocolWithheld: true })
    expect(JSON.stringify(readable)).not.toContain('opaque-test-protocol')
    const sensitive = await detailRoute.handler(new Request(`http://local${detailPath}?sensitive=1`), detailPath.match(detailRoute.pattern)!, context)
    expect(JSON.stringify(await sensitive.json())).toContain('opaque-test-protocol')
    const invalid = await detailRoute.handler(new Request(`http://local${detailPath}?sensitive=true`), detailPath.match(detailRoute.pattern)!, context)
    expect(invalid.status).toBe(400)
  } finally { store.close() }
})

test('provider failure keeps the exact attempted request and observed error without fabricating a response', async () => {
  const store = createExecutionStore(':memory:'), rooms = createRoomDirectory({ deliver: () => {} }), room = rooms.createRoom({ name: 'Room', createdBy: 'test' })
  const provider: LLMProvider = { models: async () => ['test'], chat: async () => { throw new Error('Provider refused this request') } }
  const agent = await spawnAIAgent({ name: 'Agent', model: 'test', persona: '' }, { bound: () => provider } as unknown as LLMService,
    rooms, createWorkspaceSettings(), createTeam(), (_target, params) => [room.post(params)], createToolRegistry(), { executionStore: store })
  room.addMember(agent.id); await agent.join(room)
  agent.receive(room.post({ senderId: 'human', content: 'Inspect the failed model pass', type: 'chat' }))
  await agent.whenIdle()
  try {
    const turn = store.listTurns(room.profile.id)[0]!, detail = store.getModelCall(room.profile.id, turn.id, 'model_1')!
    expect(turn.status).toBe('failed')
    expect(detail.status).toBe('failed')
    expect(detail.error).toBe('Provider refused this request')
    expect(detail.request.messages.some(message => message.content.includes('Inspect the failed model pass'))).toBe(true)
    expect(detail).not.toHaveProperty('response')
  } finally { store.close() }
})

test('partial stream capture preserves the provider error classification used by the normal chat UI', async () => {
  const store = createExecutionStore(':memory:'), rooms = createRoomDirectory({ deliver: () => {} }), room = rooms.createRoom({ name: 'Room', createdBy: 'test' })
  const provider: LLMProvider = { models: async () => ['test'], chat: async () => { throw new Error('Unexpected chat') }, stream: async function* () {
    yield { delta: 'Known text before provider failure', done: false }
    throw createCloudProviderError({ code: 'auth', provider: 'test-provider', message: 'Provider authentication failed' })
  } }
  const agent = await spawnAIAgent({ name: 'Agent', model: 'test', persona: '' }, { bound: () => provider } as unknown as LLMService,
    rooms, createWorkspaceSettings(), createTeam(), (_target, params) => [room.post(params)], createToolRegistry(), { executionStore: store })
  room.addMember(agent.id); await agent.join(room)
  agent.receive(room.post({ senderId: 'human', content: 'Inspect', type: 'chat' }))
  await agent.whenIdle()
  try {
    const turn = store.listTurns(room.profile.id)[0]!, detail = store.getModelCall(room.profile.id, turn.id, 'model_1')!
    expect(detail.status).toBe('failed')
    expect(detail.response?.content).toBe('Known text before provider failure')
    expect(room.getRecent(1)[0]).toMatchObject({ type: 'error', errorCode: 'no_api_key', errorProvider: 'test-provider' })
  } finally { store.close() }
})

test('cancellation after input admission cannot dispatch a provider call', async () => {
  const store = createExecutionStore(':memory:'), rooms = createRoomDirectory({ deliver: () => {} }), room = rooms.createRoom({ name: 'Room', createdBy: 'test' })
  let dispatches = 0, admissions = 0
  let agent!: AIAgent, finished!: () => void
  const turnFinished = new Promise<void>(resolve => { finished = resolve })
  const provider: LLMProvider = { models: async () => ['test'], chat: async () => { dispatches++; return { content: 'Late answer', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } } } }
  agent = await spawnAIAgent({ name: 'Agent', model: 'test', persona: '' }, { bound: () => provider } as unknown as LLMService,
    rooms, createWorkspaceSettings(), createTeam(), (_target, params) => [room.post(params)], createToolRegistry(), {
      executionStore: store, onTurnFinished: finished,
      executionGrowth: async (_bytes, work) => {
        admissions++
        const result = await work()
        if (admissions === 2) agent.cancelGeneration()
        return result
      },
    })
  room.addMember(agent.id); await agent.join(room)
  agent.receive(room.post({ senderId: 'human', content: 'Inspect', type: 'chat' }))
  await turnFinished
  try {
    const turn = store.listTurns(room.profile.id)[0]!
    expect(dispatches).toBe(0)
    expect(turn.status).toBe('interrupted')
    expect(store.getModelCall(room.profile.id, turn.id, 'model_1')?.status).toBe('cancelled')
  } finally { store.close() }
})

test('cancelled model streams keep known partial text without inventing a completed answer or tools', async () => {
  const store = createExecutionStore(':memory:'), rooms = createRoomDirectory({ deliver: () => {} }), room = rooms.createRoom({ name: 'Room', createdBy: 'test' })
  let entered!: () => void
  const partial = new Promise<void>(resolve => { entered = resolve })
  let failed!: () => void
  const failureRecorded = new Promise<void>(resolve => { failed = resolve })
  let finished!: () => void
  const turnFinished = new Promise<void>(resolve => { finished = resolve })
  const observedStore = { ...store, recordModelFailure: (...args: Parameters<typeof store.recordModelFailure>) => { store.recordModelFailure(...args); failed() } }
  const provider: LLMProvider = { models: async () => ['test'], chat: async () => { throw new Error('Unexpected chat') },
    stream: async function* (_request, signal) {
      yield { delta: 'Known partial response', done: false }
      entered()
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('stream cancelled')), { once: true }))
    } }
  const agent = await spawnAIAgent({ name: 'Agent', model: 'test', persona: '' }, { bound: () => provider } as unknown as LLMService,
    rooms, createWorkspaceSettings(), createTeam(), (_target, params) => [room.post(params)], createToolRegistry(), { executionStore: observedStore, onTurnFinished: finished })
  room.addMember(agent.id); await agent.join(room)
  agent.receive(room.post({ senderId: 'human', content: 'Inspect', type: 'chat' }))
  await partial; agent.cancelGeneration(); await agent.whenIdle(); await failureRecorded; await turnFinished
  try {
    const turn = store.listTurns(room.profile.id)[0]!
    expect(turn.status).toBe('interrupted')
    const detail = store.getModelCall(room.profile.id, turn.id, 'model_1')!
    expect(detail.status).toBe('cancelled')
    expect(detail.response?.content).toBe('Known partial response')
    expect(store.listCalls(room.profile.id, turn.id)).toEqual([])
  } finally { store.close() }
})
