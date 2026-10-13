// ============================================================================
// Integration test: what an Agent knows of Workspace operations at the start
// of a turn crosses Workspace Host → workspace runtime → agent → model
// request. The Room Scope's operation index reaches the cacheable system
// prompt, revalidated by the catalog's ETag at every turn; what one turn's
// workspace calls established reaches the next turn inline with its answer.
// ============================================================================

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createAgentsWorkspaceRuntime } from '../workspace-runtime.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from './__fixtures__/stub-gateway.ts'
import type { ChatRequest, StreamChunk } from '../core/types/llm.ts'
import type { AIAgent } from '../core/types/agent.ts'

const START = 'world.procedure.run.start'
const STEP_READ = 'world.procedure.run.step.read'

describe('operation context wiring', () => {
  let homeDir: string
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'leitbild-operation-context-'))
    process.env.LEITBILD_HOME = homeDir
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
    delete process.env.LEITBILD_HOME
  })

  test('a turn reads the operation index, and the next turn the working set of the answer before it', async () => {
    const workspaceId = newWorkspaceId()
    const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' })
    const operation = (id: string, title: string, risk: 'read' | 'write') => ({
      id, moduleId: 'world', kind: risk === 'read' ? 'query' : 'command', scope: { kind: 'resource', resourceType: run.type },
      title, description: title, risk, idempotent: risk === 'read', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    })
    const catalogRequests: Array<{ readonly ifNoneMatch: string | null }> = []
    const host = Bun.serve({
      port: 0,
      fetch: request => {
        const path = new URL(request.url).pathname
        if (path.endsWith('/capabilities')) {
          catalogRequests.push({ ifNoneMatch: request.headers.get('if-none-match') })
          if (request.headers.get('if-none-match') === '"catalog-1"') return new Response(null, { status: 304 })
          return Response.json({ workspaceId, modules: [{ moduleId: 'world', status: 'ready' }], capabilities: [
            operation(START, 'Start procedure run', 'write'), operation(STEP_READ, 'Read procedure run step', 'read'),
          ] }, { headers: { etag: '"catalog-1"' } })
        }
        if (path.endsWith('/resources')) return Response.json({ workspaceId, modules: [{ moduleId: 'world', status: 'ready' }], resources: [
          { ref: run, title: 'Halden', capabilityIds: [START, STEP_READ], links: [], summary: [], observedAt: new Date().toISOString() },
        ] })
        if (path.endsWith('/definitions')) return Response.json({ workspaceId, modules: [{ moduleId: 'world', status: 'ready' }], definitions: [] })
        if (path.endsWith(`/capabilities/${START}/invoke`)) return Response.json({ result: {
          ok: true, commandId: 'command:start-1', acceptedAt: 'x', pinned: { runId: 'procedure-run:1', sourceId: 'westinghouse' }, next: { sequence: 7 },
        } })
        return Response.json({ error: { code: 'not_found', message: path } }, { status: 404 })
      },
    })
    try {
      const requests: ChatRequest[] = []
      const gateway = {
        ...makeStubGateway(),
        stream: async function* (request: ChatRequest): AsyncIterable<StreamChunk> {
          requests.push(structuredClone(request))
          if (requests.length === 1) {
            // Turn 1 starts E-0 without naming the target: the one Run in scope.
            yield { delta: '', done: true, finishReason: 'tool_calls', tokensUsed: { prompt: 1, completion: 1 }, toolCalls: [{ id: 'c1', function: { name: 'workspace_call', arguments: {
              calls: [{ key: 'start', operationId: START, input: { procedureId: 'E-0', scope: { plantId: 'plant:halden-2', label: 'Halden Unit 2' } } }],
            } } }] }
            return
          }
          yield { delta: 'Holding.', done: false }
          yield { delta: '', done: true, finishReason: 'stop', tokensUsed: { prompt: 1, completion: 1 } }
        },
      }
      const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(gateway) })
      const system = createAgentsWorkspaceRuntime({ deployment, workspaceId, workspaceHostUrl: `http://127.0.0.1:${host.port}` })
      const room = system.rooms.createRoom({ name: 'Procedures', createdBy: 'test' })
      const assistant = await system.spawnAIAgent({ name: 'Assistant', model: 'mock-model', persona: 'Run procedures.' }) as AIAgent
      const human = await system.spawnHumanAgent({ name: 'Alice' }, () => {})
      await system.addAgentToRoom(assistant.id, room.profile.id, 'test')
      await system.addAgentToRoom(human.id, room.profile.id, 'test')

      for (const content of ['Start E-0 on unit 2.', 'continue']) {
        system.routeMessage({ rooms: [room.profile.id] }, { senderId: human.id, senderName: 'Alice', content, type: 'chat' })
        await assistant.whenIdle()
      }

      // Turn 1: the start and its answer; turn 2: one request.
      expect(requests).toHaveLength(3)
      const index = [
        'Resource world.simulation-run:',
        `- ${START} [write]`,
        `- ${STEP_READ}`,
      ].join('\n')
      for (const request of requests) {
        const stable = request.systemBlocks?.find(block => block.cacheable)?.text ?? ''
        expect(stable).toContain('<leitbild:operations>')
        expect(stable).toContain(`${index}\n</leitbild:operations>`)
      }
      // Identical bytes on both turns: each later read was a revalidation.
      expect(requests[2]!.systemBlocks).toEqual(requests[0]!.systemBlocks)
      expect(catalogRequests[0]).toEqual({ ifNoneMatch: null })
      expect(catalogRequests.slice(1).every(entry => entry.ifNoneMatch === '"catalog-1"')).toBe(true)

      // Turn 2 replays turn 1's answer with what its call established.
      const answer = requests[2]!.messages.find(message => message.role === 'assistant')!.content
      expect(answer).toContain(`- operations: ${START} {procedureId, scope}`)
      expect(answer).toContain(`- target: ${JSON.stringify({ kind: 'resource', ref: run })}`)
      expect(answer).toContain('- ids: procedureId E-0; plantId plant:halden-2; runId procedure-run:1; sourceId westinghouse')
    } finally {
      host.stop(true)
    }
  })
})
