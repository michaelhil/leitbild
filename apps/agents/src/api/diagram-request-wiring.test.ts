import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId, newRequestId, accessContextSchema } from '@leitbild/contracts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createAgentsWorkspaceRuntime } from '../workspace-runtime.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from './__fixtures__/stub-gateway.ts'
import { handleAPI } from './http-routes.ts'
import { diagramRequestPath, diagramReply, replacementFromReply } from '../core/diagram-request.ts'
import { serializeModuleSnapshots, saveWorkspaceModuleSnapshots, loadWorkspaceModuleSnapshots } from '../core/storage/module-snapshots.ts'
import { workspaceModulePaths } from '../core/paths.ts'
import type { AIAgent } from '../core/types/agent.ts'
import type { ChatRequest, StreamChunk } from '../core/types/llm.ts'
import type { Message } from '../core/types/messaging.ts'
import type { RouteContext } from './routes/types.ts'
import { serveDisplayHost } from './__fixtures__/display-host.ts'

let home: string, previousHome: string | undefined
const hosts: Array<{ stop: () => void }> = []
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'diagram-request-')); previousHome = process.env.LEITBILD_HOME; process.env.LEITBILD_HOME = home })
afterEach(async () => { for (const host of hosts.splice(0)) host.stop(); await rm(home, { recursive: true, force: true }); if (previousHome === undefined) delete process.env.LEITBILD_HOME; else process.env.LEITBILD_HOME = previousHome })

const setup = async () => {
  const requests: ChatRequest[] = []
  const output = '```mermaid\nflowchart TB\nB["Manual revision with detail"] --> C["Finish"]\n```'
  const gateway = {
    ...makeStubGateway(),
    stream: async function* (request: ChatRequest): AsyncIterable<StreamChunk> {
      requests.push(structuredClone(request))
      yield { delta: output, done: false }
      yield { delta: '', done: true, finishReason: 'stop', tokensUsed: { prompt: 1, completion: 1 } }
    },
  }
  const workspaceId = newWorkspaceId()
  const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(gateway) })
  const host = serveDisplayHost(workspaceId, { publishes: false }); hosts.push(host)
  const system = createAgentsWorkspaceRuntime({ deployment, workspaceId, workspaceHostUrl: host.url })
  const broadcasts: Message[] = []
  system.setOnRoomCreated(() => {})
  system.setOnDeliveryModeChanged(() => {})
  system.setOnMembershipChanged(() => {})
  system.setOnMessagePosted((_roomId, message) => { broadcasts.push(JSON.parse(JSON.stringify(message)) as Message) })
  const room = system.rooms.createRoom({ name: 'Diagrams', createdBy: 'test' })
  room.setDeliveryMode('manual')
  const ai = await system.spawnAIAgent({ name: 'Assistant', model: 'mock-model', persona: 'Draw only the requested diagram.' }) as AIAgent
  const human = await system.spawnHumanAgent({ name: 'Hilde' }, () => {})
  await system.addAgentToRoom(ai.id, room.profile.id, 'test')
  await system.addAgentToRoom(human.id, room.profile.id, 'test')
  const originalContent = '```mermaid\nflowchart LR\nA --> B\n```\n\n```mermaid\nflowchart LR\nB --> C\n```'
  const original = room.post({ senderId: ai.id, content: originalContent, type: 'chat', generationTraceId: 'original-turn' })
  const body = { requesterId: human.id, diagramIndex: 1, initialSource: 'flowchart LR\nB --> C', source: 'flowchart LR\nB["Manual revision"] --> C["Finish"]', instruction: 'Add detail and make it vertical' }
  const path = diagramRequestPath(room.profile.id, original.id)
  const accessContext = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'anonymous' } })
  const post = (value: unknown, at = path) => handleAPI(new Request(`http://test${at}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  }), at, system, workspaceId, accessContext, {} as Omit<RouteContext, 'system' | 'accessContext' | 'workspaceId'>)
  return { system, room, ai, human, requests, output, original, originalContent, body, post, workspaceId, broadcasts }
}

test('selected diagram request crosses real route, turn, durable message and realtime/UI relation without replacing the original', async () => {
  const { system, room, ai, requests, output, original, originalContent, body, post, workspaceId, broadcasts } = await setup()
  try {
    const response = await post(body)
    expect(response?.status).toBe(202)
    const accepted = await response!.json() as { requestId: string; queued: boolean }
    expect(accepted.requestId).toMatch(/^[a-f0-9-]{36}$/)
    await ai.whenIdle()
    const reply = room.getRetainedMessages().find(message => message.cause?.kind === 'diagram-request')!
    expect(reply).toMatchObject({ senderId: ai.id, type: 'chat', inReplyTo: [original.id], content: output,
      cause: { kind: 'diagram-request', name: 'Hilde', requestId: accepted.requestId, diagramIndex: 1 } })
    expect(requests).toHaveLength(1)
    expect(diagramReply(broadcasts, original.id, ai.id, accepted.requestId)?.cause).toEqual(reply.cause)
    expect(requests[0]!.messages.at(-1)!.content).toContain(JSON.stringify(body.source))
    expect(room.getRetainedMessages().find(message => message.id === original.id)?.content).toBe(originalContent)
    await saveWorkspaceModuleSnapshots(serializeModuleSnapshots(system), workspaceModulePaths(workspaceId))
    const snapshots = await loadWorkspaceModuleSnapshots(workspaceModulePaths(workspaceId))
    const retained = snapshots.rooms!.rooms.find(value => value.profile.id === room.profile.id)!.messages
    const matched = diagramReply(retained, original.id, ai.id, accepted.requestId)!
    expect(matched.cause).toEqual(reply.cause)
    expect(replacementFromReply(matched)).toContain('Manual revision with detail')
    expect(diagramReply(retained, original.id, ai.id, crypto.randomUUID())).toBeUndefined()
    expect(diagramReply(retained, original.id, 'another-agent', accepted.requestId)).toBeUndefined()
  } finally { ai.close() }
})

test('strict route and Room gates refuse invalid requests without starting an Agent turn', async () => {
  const { room, ai, body, post, requests } = await setup()
  try {
    for (const invalid of [{ ...body, extra: true }, { ...body, source: 'x'.repeat(50_001) }, { ...body, diagramIndex: -1 }, { ...body, instruction: '' }, { ...body, source: ' ' }]) {
      expect((await post(invalid))?.status).toBe(400)
    }
    for (const [value, code] of [[{ ...body, requesterId: ai.id }, 'requester_invalid'], [{ ...body, diagramIndex: 2 }, 'diagram_missing'], [{ ...body, initialSource: 'flowchart LR\nA --> B' }, 'diagram_missing']] as const) {
      const response = await post(value)
      expect(await response?.json()).toMatchObject({ code })
    }
    room.setPaused(true)
    expect(await (await post(body))?.json()).toMatchObject({ code: 'room_paused' })
    room.setPaused(false)
    room.setMuted(ai.id, true)
    expect(await (await post(body))?.json()).toMatchObject({ code: 'agent_unavailable' })
    expect(requests).toHaveLength(0)
  } finally { ai.close() }
})
