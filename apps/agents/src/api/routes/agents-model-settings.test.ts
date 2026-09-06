import { afterEach, describe, expect, test } from 'bun:test'
import { createAIAgent, type Decision } from '../../agents/ai-agent.ts'
import { createTeam } from '../../agents/team.ts'
import { createRoomDirectory } from '../../core/rooms/directory.ts'
import { createToolRegistry } from '../../core/tool-registry.ts'
import type { AIAgentConfig } from '../../core/types/agent.ts'
import type { LLMProvider } from '../../core/types/llm.ts'
import type { AgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import { createOpenAICompatibleProvider } from '../../llm/openai-compatible.ts'
import { agentRoutes } from './agents.ts'
import type { RouteContext } from './types.ts'
import { validateWSInbound } from '../ws-commands/validate.ts'
import { roomDefinitionSchema, getBundledRoomDefinition } from '../../core/definitions/room-definition-catalog.ts'
import { registerAgentTools } from '../../integrations/mcp/tools/agent-tools.ts'
import { z } from 'zod'

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })

const setup = (provider: LLMProvider) => {
  const team = createTeam()
  const decisions: Decision[] = []
  let saves = 0
  const system = {
    team,
    rooms: createRoomDirectory({}),
    toolRegistry: createToolRegistry(),
    skillStore: { list: () => [], get: () => undefined },
    llm: provider,
    spawnAIAgent: async (config: AIAgentConfig) => {
      const agent = createAIAgent(config, provider, decision => decisions.push(decision))
      team.addAgent(agent)
      return agent
    },
    notifyAgentSettingsChanged: () => { saves++ },
  } as unknown as AgentsWorkspaceRuntime
  const request = async (method: string, path: string, body?: unknown) => {
    const route = agentRoutes.find(entry => entry.method === method && entry.pattern.test(path))!
    return route.handler(new Request(`http://localhost${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    }), path.match(route.pattern)!, { system, broadcastToWorkspace: () => {} } as unknown as RouteContext)
  }
  return { system, decisions, request, saves: () => saves }
}

describe('Agent model settings API', () => {
  test('WS and Room Definition schemas preserve optional settings and reject invalid values', () => {
    const config = { name: 'Helper', model: 'fixture', persona: 'Help', reasoningEffort: 'high', historyTokenBudget: 20_000 } as const
    expect(validateWSInbound({ type: 'create_agent', config })).toEqual({ ok: true, value: { type: 'create_agent', config } })
    expect(validateWSInbound({ type: 'create_agent', config: { ...config, historyTokenBudget: -1 } }).ok).toBe(false)
    expect(validateWSInbound({ type: 'update_agent', name: 'Helper', reasoningEffort: null, historyTokenBudget: null }).ok).toBe(true)
    expect(validateWSInbound({ type: 'update_agent', name: 'Helper', reasoningEffort: 'invented' }).ok).toBe(false)
    const base = getBundledRoomDefinition('leitbild-assistant')!
    const definition = { ...base, room: { ...base.room, agents: [{ ...base.room.agents[0], reasoningEffort: 'high', historyTokenBudget: 20_000 }] } }
    expect(roomDefinitionSchema.parse(definition).room.agents[0]).toMatchObject({ reasoningEffort: 'high', historyTokenBudget: 20_000 })
    expect(roomDefinitionSchema.safeParse({ ...definition, room: { ...definition.room, agents: [{ ...definition.room.agents[0], reasoningEffort: 'invented' }] } }).success).toBe(false)
    expect(base.room.agents[0]).not.toHaveProperty('reasoningEffort')
  })

  test('MCP creation validates and forwards settings to the live Agent', async () => {
    const { system } = setup({ chat: async () => ({ content: '', generationMs: 0, tokensUsed: { prompt: 0, completion: 0 } }), models: async () => [] })
    const registered = new Map<string, { shape: z.ZodRawShape; run: (args: unknown) => Promise<unknown> }>()
    registerAgentTools({ tool: (name: string, _description: string, shape: z.ZodRawShape, run: (args: unknown) => Promise<unknown>) => registered.set(name, { shape, run }) } as never, system)
    const create = registered.get('create_agent')!
    const args = z.object(create.shape).parse({ name: 'MCP Helper', model: 'fixture', persona: 'Help', reasoningEffort: 'low', historyTokenBudget: 10_000, thinking: true })
    await create.run(args)
    const agent = system.team.getAgent('MCP Helper') as ReturnType<typeof createAIAgent>
    expect(agent.getConfig()).toMatchObject({ reasoningEffort: 'low', historyTokenBudget: 10_000, thinking: true })
    expect(z.object(create.shape).safeParse({ ...args, historyTokenBudget: 0 }).success).toBe(false)
  })

  test('create/edit/reset reaches real adapter request and exact generation query', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async request => {
      if (new URL(request.url).pathname === '/models') return Response.json({ data: [{
        id: 'fixture/reasoner', context_length: 128_000,
        reasoning: { supported_efforts: ['high', 'low'], default_effort: 'low', mandatory: true },
      }] })
      bodies.push(await request.json() as Record<string, unknown>)
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })
    } })
    servers.push(server)
    const adapter = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => server.url.toString().replace(/\/$/, ''), getApiKey: () => 'fixture-only' })
    // Exercise the real non-streaming adapter, not an external provider.
    const provider: LLMProvider = { chat: adapter.chat, models: adapter.models, modelInfo: adapter.modelInfo }
    const { system, decisions, request } = setup(provider)
    expect((await request('POST', '/agents', { name: 'Helper', model: 'fixture/reasoner', persona: 'Read carefully.', reasoningEffort: 'high', thinking: true, historyTokenBudget: 12_000 })).status).toBe(201)
    const agent = system.team.getAgent('Helper')! as ReturnType<typeof createAIAgent>
    expect(agent.getConfig()).toMatchObject({ reasoningEffort: 'high', thinking: true, historyTokenBudget: 12_000 })
    const detail = await (await request('GET', '/agents/Helper')).json()
    expect(detail).toMatchObject({ reasoningEffort: 'high', thinking: true, historyTokenBudget: 12_000, modelInfo: { provider: 'openrouter', reasoning: { supportedEfforts: ['high', 'low'] } } })
    agent.receive({ id: 'first', roomId: 'room', senderId: 'human', content: 'Status?', type: 'chat', timestamp: 1 })
    await agent.whenIdle()
    expect(bodies[0]?.reasoning).toEqual({ effort: 'high' })
    expect(bodies[0]).not.toHaveProperty('think')
    expect(decisions[0]?.generationQuery).toMatchObject({ reasoningEffort: 'high', think: true })

    expect((await request('PATCH', '/agents/Helper', { reasoningEffort: 'low', thinking: false, historyTokenBudget: 8_000 })).status).toBe(200)
    const restoredConfig = JSON.parse(JSON.stringify(agent.getConfig())) as AIAgentConfig
    const restored = createAIAgent(restoredConfig, provider, () => {})
    expect(restored.getConfig()).toMatchObject({ reasoningEffort: 'low', thinking: false, historyTokenBudget: 8_000 })
    expect((await request('PATCH', '/agents/Helper', { reasoningEffort: null, historyTokenBudget: null })).status).toBe(200)
    expect(agent.getReasoningEffort()).toBeUndefined()
    expect(agent.getHistoryTokenBudget()).toBeUndefined()
    expect(JSON.parse(JSON.stringify(agent.getConfig()))).not.toHaveProperty('reasoningEffort')
    agent.receive({ id: 'second', roomId: 'room', senderId: 'human', content: 'Again?', type: 'chat', timestamp: 2 })
    await agent.whenIdle()
    expect(bodies[1]).not.toHaveProperty('reasoning')
    expect(decisions[1]?.generationQuery?.reasoningEffort).toBeUndefined()
  })

  test('invalid settings fail before changing existing Agent state; metadata failure stays editable', async () => {
    const provider: LLMProvider = {
      chat: async () => ({ content: 'Done', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } }),
      models: async () => ['fixture'],
      modelInfo: async () => { throw new Error('catalog offline') },
    }
    const { system, request, saves } = setup(provider)
    await request('POST', '/agents', { name: 'Helper', model: 'fixture', persona: 'Original' })
    for (const settings of [{ reasoningEffort: 'invented' }, { historyTokenBudget: 0 }, { historyTokenBudget: 1.5 }, { thinking: 'true' }]) {
      expect((await request('PATCH', '/agents/Helper', { persona: 'Must not apply', ...settings })).status).toBe(400)
    }
    expect((system.team.getAgent('Helper') as ReturnType<typeof createAIAgent>).getPersona()).toBe('Original')
    expect(saves()).toBe(0)
    expect(await (await request('GET', '/agents/Helper')).json()).toMatchObject({ modelInfoError: 'Model metadata unavailable: catalog offline' })
    // Unknown availability is not a new configuration whitelist.
    expect((await request('PATCH', '/agents/Helper', { reasoningEffort: 'high' })).status).toBe(200)
    expect((await request('PATCH', '/agents/Helper', { reasoningEffort: null })).status).toBe(200)
    expect((await request('POST', '/agents', { name: 'Bad', model: 'fixture', persona: 'Bad', reasoningEffort: null })).status).toBe(400)
  })
})
