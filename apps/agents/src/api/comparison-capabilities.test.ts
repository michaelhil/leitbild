import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createAgentsModuleState } from '../core/workspaces/module-state.ts'
import { createWorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import { createWorkspaceCapabilityTools } from '../tools/built-in/workspace-capability-tools.ts'
import { handleAgentsModuleApi } from './workspace-module-api.ts'

test('actual Agents room descriptors prevent comparison answer leakage through workspace calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leitbild-comparison-capabilities-'))
  const previousHome = process.env.LEITBILD_HOME
  process.env.LEITBILD_HOME = directory
  const state = createAgentsModuleState()
  const registry = createWorkspaceRuntimeRegistry({ deployment: createDeploymentRuntime(), moduleState: state })
  const workspaceId = newWorkspaceId()
  const api = async (path: string, method = 'GET', body?: unknown): Promise<Response> => {
    const url = new URL(path, 'http://agents.test')
    const response = await handleAgentsModuleApi(new Request(url.href, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    }), url, { state, registry })
    if (!response) throw new Error(`Unhandled Module path: ${path}`)
    return response
  }
  try {
    expect((await api(`/internal/workspaces/${workspaceId}`, 'PUT', { workspaceId })).status).toBe(201)
    const runtime = await registry.getOrLoad(workspaceId)
    const created = await runtime.createRoom({ name: 'Comparison boundary test', createdBy: 'tester' })
    const room = created.value
    room.post({ senderId: 'original-agent', senderName: 'Original model', content: 'ORIGINAL_ANSWER_MUST_NOT_LEAK', type: 'chat' })
    const resource = { workspaceId, moduleId: 'agents', type: 'agents.room', id: room.profile.id }
    const invocations: string[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      const pathname = new URL(request.url).pathname
      const operation = pathname.match(/\/capabilities\/([^/]+)\/invoke$/)?.[1]
      if (operation) {
        invocations.push(operation)
        const body = await request.json() as { resource?: unknown; definition?: unknown; input: unknown; actor: unknown }
        return api(`/internal/workspaces/${workspaceId}/capabilities/${operation}/invoke`, 'POST', {
          workspaceId, capabilityId: operation,
          ...(body.resource ? { resource: body.resource } : {}),
          ...(body.definition ? { definition: body.definition } : {}),
          input: body.input,
          access: { workspaceId, requestId: crypto.randomUUID(), actor: body.actor, client: { id: 'test-host', kind: 'service' } },
        })
      }
      const collection = pathname.split('/').at(-1)!
      const response = await api(`/internal/workspaces/${workspaceId}/${collection}`)
      if (!response.ok) return response
      return Response.json({ workspaceId, modules: [{ moduleId: 'agents', status: 'ready' }], ...await response.json() as object })
    }) as typeof fetch
    const [explore, call] = createWorkspaceCapabilityTools({
      workspaceId, hostBaseUrl: 'http://host.test', fetchImpl, getRoomScope: () => ({ kind: 'workspace' }),
    })
    const context = { callerId: 'test-agent', callerName: 'Comparison', roomId: room.profile.id }
    const comparison = {
      ...context,
      comparison: { resourceKeys: [`${workspaceId}:agents:agents.room:${room.profile.id}`], definitionKeys: [], messageIds: [], turnIds: [] },
    }
    const operationIds = ['agents.room.read', 'agents.room.inspect']
    const discovered = await explore!.execute({ view: 'operations', operationIds }, comparison)
    expect(discovered).toMatchObject({ success: true, data: { operations: [] } })
    for (const operationId of operationIds) {
      const params = { calls: [{ key: operationId, operationId, target: { kind: 'resource', ref: resource }, input: {} }] }
      const denied = await call!.execute(params, comparison)
      expect(denied).toMatchObject({ success: true, data: { results: [{ success: false }] } })
      expect(JSON.stringify(denied)).not.toContain('ORIGINAL_ANSWER_MUST_NOT_LEAK')
      expect(invocations).toHaveLength(0)
    }
    // Normal execution must retain the same full read capabilities. The
    // restriction belongs only to comparisons, not ordinary Agent access.
    for (const operationId of operationIds) {
      const allowed = await call!.execute({ calls: [{ key: operationId, operationId, target: { kind: 'resource', ref: resource }, input: {} }] }, context)
      expect(allowed).toMatchObject({ success: true, data: { results: [{ success: true }] } })
      expect(JSON.stringify(allowed)).toContain('ORIGINAL_ANSWER_MUST_NOT_LEAK')
    }
    expect(invocations).toEqual(operationIds)
  } finally {
    await registry.shutdown()
    if (previousHome === undefined) delete process.env.LEITBILD_HOME
    else process.env.LEITBILD_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
