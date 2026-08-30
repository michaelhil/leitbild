import { describe, expect, test } from 'bun:test'
import {
  capabilityIdSchema,
  moduleIdSchema,
  newWorkspaceId,
  resourceIdSchema,
  resourceTypeSchema,
} from '@leitbild/contracts'
import { createWorkspaceCapabilityTools } from './workspace-capability-tools.ts'

const workspaceId = newWorkspaceId()
const capabilityId = capabilityIdSchema.parse('world.simulation-run.read')
const moduleId = moduleIdSchema.parse('world')
const resourceType = resourceTypeSchema.parse('world.simulation-run')
const resourceId = resourceIdSchema.parse('run-01')

const catalogFetch = (requests: Request[]): typeof fetch => (async (input, init) => {
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
  requests.push(request)
  if (request.url.endsWith('/resources')) {
    return Response.json({
      workspaceId,
      modules: [{ moduleId, status: 'ready' }],
      resources: [{
        ref: { workspaceId, moduleId, type: resourceType, id: resourceId },
        title: 'Run 01',
        capabilityIds: [capabilityId],
        observedAt: new Date().toISOString(),
      }],
    })
  }
  if (request.url.endsWith('/definitions')) {
    return Response.json({ workspaceId, modules: [{ moduleId, status: 'ready' }], definitions: [] })
  }
  if (request.url.endsWith('/capabilities')) {
    return Response.json({
      workspaceId,
      modules: [{ moduleId, status: 'ready' }],
      capabilities: [{
        id: capabilityId,
        moduleId,
        kind: 'query',
        scope: { kind: 'resource', resourceType },
        title: 'Read Run',
        description: 'Reads a Simulation Run.',
        risk: 'read',
        idempotent: true,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      }],
    })
  }
  return Response.json({ result: { runId: resourceId, state: 'running' } })
}) as typeof fetch

describe('Workspace Capability tools', () => {
  test('discovers Resources and shows grant state without persisting a Resource id', async () => {
    const requests: Request[] = []
    const tools = createWorkspaceCapabilityTools({
      workspaceId,
      hostBaseUrl: 'https://host.test',
      getToolGrants: () => [{ capabilityId }],
      fetchImpl: catalogFetch(requests),
    })
    const context = { callerId: 'agent-1', callerName: 'Analyst' }
    const resources = await tools[0]!.execute({ capabilityId }, context)
    const capabilities = await tools[1]!.execute({}, context)
    expect(resources.success).toBe(true)
    expect((capabilities.data as { capabilities: Array<{ granted: boolean }> }).capabilities[0]?.granted).toBe(true)
    expect(requests).toHaveLength(3)
  })

  test('rejects an invocation with a specific grant failure before network access', async () => {
    const requests: Request[] = []
    const tools = createWorkspaceCapabilityTools({
      workspaceId,
      hostBaseUrl: 'https://host.test',
      getToolGrants: () => [],
      fetchImpl: catalogFetch(requests),
    })
    const result = await tools[2]!.execute({ capabilityId, input: {} }, { callerId: 'agent-1', callerName: 'Analyst' })
    expect(result).toEqual(expect.objectContaining({ success: false, error: expect.stringContaining('capability_not_granted') }))
    expect(requests).toHaveLength(0)
  })

  test('supplies Workspace scope at invocation and sends AI attribution', async () => {
    const requests: Request[] = []
    const tools = createWorkspaceCapabilityTools({
      workspaceId,
      hostBaseUrl: 'https://host.test',
      getToolGrants: () => [{ capabilityId }],
      fetchImpl: catalogFetch(requests),
    })
    const result = await tools[2]!.execute({
      capabilityId,
      resource: { moduleId, type: resourceType, id: resourceId },
      input: { include: 'summary' },
    }, { callerId: 'agent-1', callerName: 'Analyst' })
    expect(result).toEqual({ success: true, data: { runId: resourceId, state: 'running' } })
    const body = await requests[0]!.json() as Record<string, unknown>
    expect(body).toEqual({
      resource: { workspaceId, moduleId, type: resourceType, id: resourceId },
      input: { include: 'summary' },
      actor: { kind: 'ai', id: 'agent-1', displayName: 'Analyst' },
    })
  })
})
