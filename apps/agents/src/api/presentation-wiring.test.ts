import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { newWorkspaceId, presentationPromptEvidenceSchema, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createAgentsModuleState } from '../core/workspaces/module-state.ts'
import { createWorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from './__fixtures__/stub-gateway.ts'
import { handleWSMessage } from './ws-handler.ts'
import { handleAgentsModuleApi } from './workspace-module-api.ts'
import { messagePresentation } from '../core/message-presentation.ts'
import type { ChatRequest, StreamChunk } from '../core/types/llm.ts'
import type { AIAgent } from '../core/types/agent.ts'
import type { WSManager } from './ws-types.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'

test('real human WS post carries only transient recipient to actual dispatch and publishes durable causal prompt/response evidence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'leitbild-presentation-'))
  const oldHome = process.env.LEITBILD_HOME
  process.env.LEITBILD_HOME = home
  const workspaceId = newWorkspaceId(), observedAt = new Date().toISOString()
  const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run' })
  const recipient = { subject: run, clientId: 'actual-browser', documentId: 'actual-document', leaseId: 'actual-lease', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const requestOp = 'world.simulation-run.presentation.request', resultOp = 'world.simulation-run.presentation.result'
  const invocations: Array<{ input: Record<string, unknown> }> = [], modelRequests: ChatRequest[] = []
  let admissionId = ''
  const host = Bun.serve({ port: 0, fetch: async request => {
    const path = new URL(request.url).pathname
    if (path.endsWith('/resources')) return Response.json({ workspaceId, modules: [], resources: [{ ref: run, title: 'Run', links: [], summary: [], observedAt, capabilityIds: [requestOp, resultOp] }] })
    if (path.endsWith('/definitions')) return Response.json({ workspaceId, modules: [], definitions: [] })
    if (path.endsWith('/capabilities')) return Response.json({ workspaceId, modules: [], capabilities: [requestOp, resultOp].map((id, i) => ({ id, moduleId: 'world', kind: i === 0 ? 'command' : 'query', scope: { kind: 'resource', resourceType: run.type }, title: 'Attention', description: 'Current browser attention', risk: i === 0 ? 'write' : 'read', idempotent: i !== 0, acceptsPresentationRecipient: true, ...(i === 0 ? { publishes: ['presentation'] } : {}), inputSchema: {}, outputSchema: {} })) })
    const body = await request.json() as { input: Record<string, unknown> }
    invocations.push(body)
    if (path.includes(encodeURIComponent(requestOp))) admissionId = String(body.input.requestId)
    return Response.json({ result: { requestId: admissionId, status: 'pending' } })
  } })
  const gateway = { ...makeStubGateway(), stream: async function* (request: ChatRequest): AsyncIterable<StreamChunk> {
    modelRequests.push(structuredClone(request))
    const ordinal = modelRequests.length
    if (ordinal === 1 || ordinal === 4) {
      yield { delta: '', done: true, finishReason: 'tool_calls', toolCalls: [{ function: { name: 'workspace_call', arguments: { calls: [{ key: 'cue', operationId: requestOp, input: { target: { subject: run, type: 'world.object', id: 'unit' }, action: { kind: 'highlight' }, purpose: 'Review evidence', recipient: { subject: run, clientId: 'forged', documentId: 'forged', leaseId: 'forged', expiresAt: recipient.expiresAt }, requestId: 'forged' } }] } } }] }
      return
    }
    if (ordinal === 2) {
      yield { delta: '', done: true, finishReason: 'tool_calls', toolCalls: [{ function: { name: 'workspace_call', arguments: { calls: [{ key: 'receipt', operationId: resultOp, input: { requestId: admissionId } }] } } }] }
      return
    }
    yield { delta: 'The request is pending; the available evidence is unchanged.', done: false }
    yield { delta: '', done: true, finishReason: 'stop', tokensUsed: { prompt: 2, completion: 2 } }
  } }
  const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(gateway) })
  const state = createAgentsModuleState()
  const registry = createWorkspaceRuntimeRegistry({ deployment, moduleState: state, workspaceHostUrl: `http://127.0.0.1:${host.port}`, idleMs: 1_000_000 })
  try {
    await state.provision(workspaceId)
    const runtime = await registry.getOrLoad(workspaceId)
    const room = runtime.rooms.createRoom({ name: 'Run Assistant', createdBy: 'test', scope: { kind: 'resource', resource: run } })
    const assistant = await runtime.spawnAIAgent({ name: 'Analyst', model: 'mock-model', persona: 'Help.' }) as AIAgent
    const human = await runtime.spawnHumanAgent({ name: 'Actual person' }, () => {})
    await runtime.addAgentToRoom(assistant.id, room.profile.id)
    await runtime.addAgentToRoom(human.id, room.profile.id)
    const wire: WSOutbound[] = []
    const socket = { send: (text: string) => { wire.push(JSON.parse(text)) }, getBufferedAmount: () => 0, close: () => {} }
    const manager = { safeSend: (ws: typeof socket, text: string) => { ws.send(text); return true } } as unknown as WSManager
    const session = { workspaceId, sessionToken: 'test-session', lastActivity: Date.now() }
    const link = { requestId: 'guide-draft-request', subject: run, sourceId: 'guide-attempt', sourceExecutionId: 'guide-step-attempt' }
    await handleWSMessage(socket, session, JSON.stringify({ type: 'post_message', target: { rooms: [room.profile.id] }, senderId: human.id,
      content: 'My edited sitrep question', presentationRecipient: recipient, presentationDraft: link }), runtime, manager)
    await assistant.whenIdle()
    const ack = wire.find(event => event.type === 'presentation_prompt_posted')!
    expect(structuredClone(ack)).toMatchObject({ type: 'presentation_prompt_posted', link, roomId: room.profile.id, messageId: expect.any(String) })
    if (ack.type !== 'presentation_prompt_posted') throw new Error('Expected real post acknowledgement')
    const prompt = room.getRetainedMessages().find(message => message.id === ack.messageId)!
    expect(prompt.senderId).toBe(human.id)
    expect(messagePresentation(prompt)).toEqual(recipient)
    expect(prompt).not.toHaveProperty('presentationRecipient')
    expect(prompt.presentationPrompt).toEqual(link)
    expect(invocations).toHaveLength(2)
    expect(invocations[0]!.input).toMatchObject({ recipient, executionId: expect.any(String), initiatingRoom: { id: room.profile.id } })
    expect(invocations[0]!.input.requestId).not.toBe('forged')
    expect(invocations[1]!.input).toEqual({ recipient, requestId: admissionId })
    // The model's own attempted forged address is in its request evidence;
    // trusted actual browser delivery metadata never enters the subsequent prompt.
    expect(JSON.stringify(modelRequests.slice(1).map(request => request.messages))).not.toContain('actual-lease')
    const read = async () => {
      const capabilityId = 'agents.room.prompt-evidence.read'
      const url = new URL(`http://agents.test/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`)
      const response = await handleAgentsModuleApi(new Request(url.href, { method: 'POST', body: JSON.stringify({ workspaceId, capabilityId,
        resource: { workspaceId, moduleId: 'agents', type: 'agents.room', id: room.profile.id }, input: { requestId: link.requestId, messageId: ack.messageId, subject: run },
        access: { workspaceId, requestId: crypto.randomUUID(), actor: { kind: 'human', id: human.id }, client: { id: 'workspace-host', kind: 'service' } },
      }) }), url, { state, registry })
      expect(response?.status).toBe(200)
      return presentationPromptEvidenceSchema.parse((await response!.json() as { result: unknown }).result)
    }
    const evidence = await read()
    expect(structuredClone(evidence)).toMatchObject({ found: true, submission: { messageId: prompt.id, senderId: human.id, source: link }, responses: [{ kind: 'chat', executionStatus: 'completed', senderId: assistant.id, turnId: expect.any(String) }] })
    // Scheduled turns cannot reuse the most recent human's browser address.
    await assistant.fireTriggerExecute!('Assess the current evidence.', room.profile.id)
    expect(invocations).toHaveLength(2)
    expect(JSON.stringify(modelRequests.at(-1))).toContain('no_recipient')
    await registry.autoSaverFor(workspaceId)!.flush()
    // Turn-completion evidence capture releases its Workspace operation asynchronously.
    await Bun.sleep(10)
    await registry.evictOne(workspaceId)
    const restored = await registry.getOrLoad(workspaceId)
    const restoredPrompt = restored.rooms.getRoom(room.profile.id)!.getRetainedMessages().find(message => message.id === prompt.id)!
    expect(messagePresentation(restoredPrompt)).toBeUndefined()
    expect(restoredPrompt.presentationPrompt).toEqual(link)
    expect((await read()).responses).toEqual(evidence.responses)
    restored.rooms.getRoom(room.profile.id)!.setScope({ kind: 'workspace' }, restored.rooms.getRoom(room.profile.id)!.profile.scopeRevision)
    await expect(restored.readPromptEvidence(room.profile.id, { requestId: link.requestId, messageId: prompt.id, subject: run })).rejects.toMatchObject({ code: 'prompt_evidence_scope_mismatch' })
  } finally {
    await registry.shutdown(); host.stop(true)
    if (oldHome === undefined) delete process.env.LEITBILD_HOME
    else process.env.LEITBILD_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
