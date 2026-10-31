import { describe, expect, test } from 'bun:test'
import { capabilityIdSchema, newWorkspaceId, workspaceResourceReferenceSchema, type WorkspaceRoomScope } from '@leitbild/contracts'
import { createAIAgent, type AgentTurnStart, type Decision } from './ai-agent.ts'
import { createRunContextFetcher } from './run-context.ts'
import { estimateTokens } from './context-builder.ts'
import { OUTPUT_RESERVE, SAFETY_MARGIN } from './budget.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import { createRoom } from '../core/rooms/room.ts'
import { createContextPublisherLookup } from '../tools/built-in/workspace-capability-tools.ts'
import type { EvalEvent } from '../core/types/agent-eval.ts'
import type { ChatRequest, LLMProvider } from '../core/types/llm.ts'

const workspaceId = newWorkspaceId()
const ref = (id: string) => workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id })
const operationId = capabilityIdSchema.parse('world.simulation-run.context')
const at = '2026-10-29T08:00:00.000Z'
const answer = { content: 'Current evidence is available.', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }
const config = { name: 'Advisor', model: 'preferred', persona: 'Use current scoped evidence.', skills: ['advice'], historyLimit: 10 }
const humanMessage = (content: string) => ({ id: crypto.randomUUID(), roomId: 'room', senderId: 'human', content, timestamp: Date.now(), type: 'chat' as const })
const makeRoom = () => createRoom({ id: 'room', name: 'Advice', createdBy: 'human', createdAt: Date.now(), scope: { kind: 'workspace' }, scopeRevision: 0 })
const textOf = (request: ChatRequest) => JSON.stringify({ messages: request.messages, blocks: request.systemBlocks })

describe('Scheduled Agent turn preparation', () => {
  test.each(['question', 'trigger'] as const)('%s uses fresh scoped context, current model capacity, skills and retained preparation evidence', async origin => {
    const store = createExecutionStore(':memory:')
    const starts: AgentTurnStart[] = [], requests: ChatRequest[] = [], events: EvalEvent[] = [], readActors: unknown[] = []
    const metadata: string[] = []
    let owner = 'run-a', capacity = 12_000, sample = 0
    const fetchRunContext = createRunContextFetcher({
      publishers: async () => [{ operationId, resource: ref(owner) }],
      read: async (publisher, actor) => {
        readActors.push(actor)
        return { ok: true, context: { text: `Live ${publisher.resource.id} sample ${++sample}`, at, clock: 'simulation' } }
      },
    })
    const definitions = [{ type: 'function' as const, function: { name: 'read_state', description: 'Read live state', parameters: {} } }]
    const provider: LLMProvider = {
      models: async () => ['fallback'],
      modelInfo: async model => { metadata.push(model); return { id: model, provider: 'fixture', contextMax: capacity, source: 'fixture' } },
      chat: async request => { requests.push(structuredClone(request)); return answer },
    }
    const room = makeRoom()
    const decisions: Decision[] = []
    const agent = createAIAgent(config, provider, decision => decisions.push(decision), {
      executionStore: store, fetchRunContext, toolDefinitions: definitions,
      resolveEffectiveModel: () => ({ model: 'fallback', fallback: true, reason: 'preferred_unavailable' }),
      getSkills: () => 'Current advice skill',
      getActiveSkillsDeclarations: () => [{ name: 'advice', declaredTools: ['read_state', 'missing_tool'] }],
      onTurnStart: async input => { starts.push(input) },
      onEvalEvent: (_scope, event) => { events.push(event) },
    })
    await agent.join(room)
    const run = async (prompt: string) => {
      if (origin === 'trigger') await agent.fireTriggerExecute!(prompt, 'room')
      else { agent.receive(humanMessage(prompt)); await agent.whenIdle() }
    }
    try {
      await run('Report current conditions first.')
      owner = 'run-b'; capacity = 20_000
      await run('Report current conditions again.')
      expect(metadata).toEqual(['fallback', 'fallback'])
      expect(sample).toBe(2)
      expect(readActors).toEqual([{ id: agent.id, name: config.name }, { id: agent.id, name: config.name }])
      expect(decisions.map(decision => decision.response.action)).toEqual(['respond', 'respond'])
      expect(requests.map(textOf)[0]).toContain('Live run-a sample 1')
      expect(requests.map(textOf)[1]).toContain('Live run-b sample 2')
      expect(requests.map(textOf)[1]).not.toContain('Live run-a sample 1')
      expect(requests.every(request => textOf(request).includes('Current advice skill'))).toBe(true)
      const prompts = ['Report current conditions first.', 'Report current conditions again.']
      for (const [index, request] of requests.entries()) expect(request.messages.at(-1)?.content.endsWith(prompts[index]!)).toBe(true)
      const ready = events.filter(event => event.kind === 'context_ready')
      expect(ready).toHaveLength(2)
      for (const [index, event] of ready.entries()) expect(event.messages.at(-1)?.content.endsWith(prompts[index]!)).toBe(true)
      for (const [index, input] of starts.entries()) {
        const expectedBudget = [12_000, 20_000][index]! - estimateTokens(JSON.stringify(definitions)) - OUTPUT_RESERVE - SAFETY_MARGIN
        expect(input.context.tokenBudget).toBe(expectedBudget)
        expect(JSON.stringify(input.context)).not.toContain('Live run-') // Comparison policy is unchanged.
        const evidence = store.modelEvidence('room', input.executionTurnId)
        expect(evidence.stages.some(stage => stage.event.kind === 'context_ready')).toBe(true)
        expect(evidence.stages.some(stage => stage.event.kind === 'warning' && stage.event.message.includes('missing_tool'))).toBe(true)
        expect(store.getModelCall('room', input.executionTurnId, 'model_1')?.request).toEqual(requests[index])
      }
      expect(store.modelEvidence('room', starts[0]!.executionTurnId).stages.some(stage => stage.event.kind === 'model_fallback')).toBe(true)
      if (origin === 'trigger') {
        expect(starts.every(input => input.context.flushInfo.ids.size === 0)).toBe(true)
        agent.receive(humanMessage('A new ordinary question.'))
        await agent.whenIdle()
        expect(textOf(requests[2]!)).not.toContain('Report current conditions')
        expect(room.getRecent(room.getMessageCount()).some(message => message.content.includes('Report current conditions'))).toBe(false)
      }
    } finally { store.close() }
  })

  test.each(['metadata', 'run-context'] as const)('cancelling a trigger during %s prevents stale preparation from dispatching beside a new turn', async phase => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const requests: ChatRequest[] = [], starts: AgentTurnStart[] = [], events: EvalEvent[] = []
    let metadataCalls = 0, contextCalls = 0
    const provider: LLMProvider = {
      models: async () => ['preferred'],
      modelInfo: async model => {
        const first = ++metadataCalls === 1
        if (phase === 'metadata' && first) { entered.resolve(); await release.promise }
        return { id: model, provider: 'fixture', contextMax: first ? 10_000 : 20_000, source: 'fixture' }
      },
      chat: async request => { requests.push(request); return answer },
    }
    const agent = createAIAgent(config, provider, () => {}, {
      fetchRunContext: async () => {
        const first = ++contextCalls === 1
        if (phase === 'run-context' && first) { entered.resolve(); await release.promise; return 'STALE cancelled context' }
        return 'CURRENT new context'
      },
      onTurnStart: async input => { starts.push(input) },
      onEvalEvent: (_scope, event) => { events.push(event) },
    })
    const trigger = agent.fireTriggerExecute!('Cancelled scheduled advice', 'room')
    await entered.promise
    agent.cancelGeneration()
    agent.receive(humanMessage('A current question'))
    await agent.whenIdle()
    release.resolve()
    await trigger
    expect(requests).toHaveLength(1)
    expect(textOf(requests[0]!)).toContain('CURRENT new context')
    expect(textOf(requests[0]!)).not.toContain('Cancelled scheduled advice')
    expect(textOf(requests[0]!)).not.toContain('STALE')
    expect(starts).toHaveLength(1)
    expect(starts[0]!.context.tokenBudget).toBe(20_000 - estimateTokens('[]') - OUTPUT_RESERVE - SAFETY_MARGIN)
    expect(events.filter(event => event.kind === 'context_ready')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'eval_completed').map(event => event.outcome).sort()).toEqual(['cancelled', 'respond'])
  })

  test('a question arriving during trigger preparation gets its own fresh turn without consuming the trigger prompt', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const requests: ChatRequest[] = [], starts: AgentTurnStart[] = []
    let reads = 0
    const provider: LLMProvider = { models: async () => ['preferred'], chat: async request => { requests.push(request); return answer } }
    const agent = createAIAgent(config, provider, () => {}, {
      fetchRunContext: async () => {
        if (++reads === 1) { entered.resolve(); await release.promise }
        return `Current observation ${reads}`
      },
      onTurnStart: async input => { starts.push(input) },
    })
    const trigger = agent.fireTriggerExecute!('Scheduled condition report', 'room')
    await entered.promise
    const question = humanMessage('My question arrived during preparation')
    agent.receive(question)
    release.resolve()
    await trigger
    await agent.whenIdle()
    expect(reads).toBe(2)
    expect(requests).toHaveLength(2)
    expect(textOf(requests[0]!)).toContain('Scheduled condition report')
    expect(textOf(requests[0]!)).not.toContain(question.content)
    expect(textOf(requests[1]!)).toContain(question.content)
    expect(textOf(requests[1]!)).not.toContain('Scheduled condition report')
    expect(starts[0]!.context.flushInfo.ids.size).toBe(0)
    expect(starts[1]!.context.flushInfo.ids.has(question.id)).toBe(true)
  })

  test('scheduled preparation preserves the script context bypass', async () => {
    const requests: ChatRequest[] = []
    let contextReads = 0
    const agent = createAIAgent(config, {
      models: async () => ['preferred'], chat: async request => { requests.push(request); return answer },
    }, () => {}, {
      getScriptContext: () => ({ systemDoc: 'The current living script', dialogue: [] }),
      fetchRunContext: async () => { contextReads++; return 'Do not fetch a live Run for a scripted turn' },
    })
    await agent.fireTriggerExecute!('A transient script cue', 'room')
    expect(contextReads).toBe(0)
    expect(textOf(requests[0]!)).toContain('The current living script')
    expect(requests[0]!.messages.at(-1)?.content).toBe('A transient script cue')
  })

  test('scheduled context discovery rechecks a Room narrowed while Host catalogs load', async () => {
    let scope: WorkspaceRoomScope = { kind: 'workspace' }
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const invoked: string[] = [], requests: ChatRequest[] = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      const path = new URL(request.url).pathname
      if (path.endsWith('/resources')) {
        entered.resolve(); await release.promise
        return Response.json({ workspaceId, modules: [{ moduleId: 'world', status: 'ready' }], resources: ['run-a', 'run-b'].map(id => ({
          ref: ref(id), title: id, capabilityIds: [operationId], links: [], summary: [], observedAt: at,
        })) })
      }
      if (path.endsWith('/definitions')) return Response.json({ workspaceId, modules: [{ moduleId: 'world', status: 'ready' }], definitions: [] })
      if (path.endsWith('/capabilities')) return Response.json({ workspaceId, modules: [{ moduleId: 'world', status: 'ready' }], capabilities: [{
        id: operationId, moduleId: 'world', kind: 'query', scope: { kind: 'resource', resourceType: 'world.simulation-run' }, title: 'Run context', description: 'Read current context',
        risk: 'read', idempotent: true, publishes: ['context'], inputSchema: {}, outputSchema: {},
      }] })
      const body = await request.json() as { resource: { id: string }; actor: { id: string; kind: string } }
      invoked.push(body.resource.id)
      expect(body.actor.kind).toBe('ai')
      return Response.json({ result: { context: { text: `Only current ${body.resource.id}`, at, clock: 'simulation' } } })
    }) as typeof fetch
    const fetchRunContext = createRunContextFetcher(createContextPublisherLookup({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => scope, fetchImpl }))
    const agent = createAIAgent(config, { models: async () => ['preferred'], chat: async request => { requests.push(request); return answer } }, () => {}, { fetchRunContext })
    const trigger = agent.fireTriggerExecute!('Report the current scoped situation', 'room')
    await entered.promise
    scope = { kind: 'resource', resource: ref('run-b') }
    release.resolve()
    await trigger
    expect(invoked).toEqual(['run-b'])
    expect(textOf(requests[0]!)).toContain('Only current run-b')
    expect(textOf(requests[0]!)).not.toContain('run-a')
  })
})
