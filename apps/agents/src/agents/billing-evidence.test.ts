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
import type { ChatResponse, LLMProvider } from '../core/types/llm.ts'
import type { LLMService } from '../llm/llm-service.ts'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

for (const streaming of [false, true]) {
  test(`provider billing survives the Agent, durable evidence and inspection routes (${streaming ? 'stream' : 'chat'})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leitbild-billing-chain-')); temporary.push(dir)
    const path = join(dir, 'executions.sqlite'), store = createExecutionStore(path)
    const rooms = createRoomDirectory({ deliver: () => {} }), room = rooms.createRoom({ name: 'Billing', createdBy: 'test' })
    const tools = createToolRegistry()
    tools.register({ name: 'read_value', description: 'Read', parameters: {}, execute: async () => ({ success: true, data: { value: 42 } }) })
    let pass = 0
    const response = (): ChatResponse => {
      pass++
      return { content: pass < 3 ? '' : 'Value read.', generationMs: 1, tokensUsed: { prompt: 10, completion: 1 },
        ...(pass < 3 ? { toolCalls: [{ id: `native-${pass}`, function: { name: 'read_value', arguments: {} } }] } : {}),
        ...(pass < 3 ? { billing: { costUsd: pass === 1 ? 0.02 : 0, generationId: `generation-${pass}`, upstreamProvider: 'fixture-provider' } } : {}),
      }
    }
    const provider: LLMProvider = { models: async () => ['test'], chat: async () => response(),
      ...(streaming ? { stream: async function* () {
        const r = response()
        yield { delta: r.content, done: true, tokensUsed: r.tokensUsed, ...(r.toolCalls ? { toolCalls: r.toolCalls } : {}), ...(r.billing ? { billing: r.billing } : {}) }
      } } : {}),
    }
    const agent = await spawnAIAgent({ name: 'Billing Agent', model: 'test', persona: 'Read.', tools: ['read_value'] },
      { bound: () => provider } as unknown as LLMService, rooms, createWorkspaceSettings(), createTeam(),
      (_target, params) => [room.post(params)], tools, { executionStore: store })
    room.addMember(agent.id); await agent.join(room)
    agent.receive(room.post({ senderId: 'human', content: 'Read twice.', type: 'chat' }))
    await agent.whenIdle()
    const turn = store.listTurns(room.profile.id)[0]!
    try {
      const models = store.modelEvidence(room.profile.id, turn.id).models
      expect(models.map(model => model.metrics?.costUsd)).toEqual([0.02, 0, undefined])
      expect(models[0]?.metrics).toMatchObject({ generationId: 'generation-1', upstreamProvider: 'fixture-provider' })
      expect(models[2]?.metrics).not.toHaveProperty('costUsd')
      const message = room.getRecent(1)[0]!
      expect(message).toMatchObject({ reportedCostUsd: 0.02, costReportedCalls: 2, modelCalls: 3 })
      const get = async (suffix: string) => {
        const path = `/rooms/${room.profile.id}/${suffix}`
        const route = roomRoutes.find(route => route.method === 'GET' && route.pattern.test(path))!
        const context = { system: { rooms, executionStore: store } } as unknown as RouteContext
        const result = await route.handler(new Request(`http://local${path}`), path.match(route.pattern)!, context)
        expect(result.status).toBe(200)
        return result.json()
      }
      expect(await get(`executions/${turn.id}/models/model_2`)).toMatchObject({ metrics: { costUsd: 0, generationId: 'generation-2' } })
      expect(await get(`messages/${message.id}/generation-query`)).toMatchObject({ generation: { reportedCostUsd: 0.02, costReportedCalls: 2 } })
    } finally { store.close() }
    const restarted = createExecutionStore(path)
    try {
      expect(restarted.modelEvidence(room.profile.id, turn.id).models.map(model => model.metrics?.costUsd)).toEqual([0.02, 0, undefined])
    } finally { restarted.close() }
  })
}

test('a failed provider attempt keeps genuinely reported partial billing and leaves unreported cost unknown', async () => {
  for (const reportsBilling of [false, true]) {
    const store = createExecutionStore(':memory:')
    const rooms = createRoomDirectory({ deliver: () => {} }), room = rooms.createRoom({ name: 'Failure', createdBy: 'test' })
    const provider: LLMProvider = { models: async () => ['test'], chat: async () => { throw new Error('Not used') }, stream: async function* () {
      yield { delta: 'Partial', done: true, ...(reportsBilling ? { billing: { costUsd: 0.01, generationId: 'reported-failure' } } : {}) }
      throw new Error('Interrupted after observed usage')
    } }
    const agent = await spawnAIAgent({ name: 'Failure Agent', model: 'test', persona: 'Read.' }, { bound: () => provider } as unknown as LLMService,
      rooms, createWorkspaceSettings(), createTeam(), (_target, params) => [room.post(params)], createToolRegistry(), { executionStore: store })
    room.addMember(agent.id); await agent.join(room)
    agent.receive(room.post({ senderId: 'human', content: 'Read.', type: 'chat' }))
    await agent.whenIdle()
    try {
      const turn = store.listTurns(room.profile.id)[0]!, model = store.modelEvidence(room.profile.id, turn.id).models[0]!
      expect(model.status).toBe('failed')
      if (reportsBilling) expect(model.metrics).toMatchObject({ costUsd: 0.01, generationId: 'reported-failure' })
      else expect(model.metrics).not.toHaveProperty('costUsd')
      expect(room.getRecent(1)[0]).not.toHaveProperty('reportedCostUsd') // No completed-pass sum claims the failed amount.
    } finally { store.close() }
  }
})
