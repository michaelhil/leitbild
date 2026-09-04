import { describe, expect, test } from 'bun:test'
import {
  capabilityIdSchema,
  moduleIdSchema,
  newWorkspaceId,
  resourceIdSchema,
  resourceTypeSchema,
  workspaceResourceReferenceSchema,
} from '@leitbild/contracts'
import { createWorkspaceCapabilityTools } from './workspace-capability-tools.ts'
import { __testSeam } from '../../agents/spawn.ts'
import { createToolRegistry } from '../../core/tool-registry.ts'

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
  test('capability discovery omits output schemas and unauthorized input schemas', async () => {
    let granted = false
    const tools = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getToolGrants: () => granted ? [{ capabilityId }] : [], fetchImpl: catalogFetch([]) })
    const context = { callerId: 'agent', callerName: 'Analyst' }
    const denied = await tools[1]!.execute({ capabilityId }, context)
    const deniedDescriptor = (denied.data as { capabilities: Record<string, unknown>[] }).capabilities[0]!
    expect(deniedDescriptor.granted).toBe(false)
    expect(deniedDescriptor.inputSchema).toBeUndefined()
    expect(deniedDescriptor.outputSchema).toBeUndefined()
    granted = true
    const broad = await tools[1]!.execute({}, context)
    const broadDescriptor = (broad.data as { capabilities: Record<string, unknown>[] }).capabilities[0]!
    expect(broadDescriptor.inputSchema).toBeUndefined()
    const allowed = await tools[1]!.execute({ capabilityId }, context)
    const allowedDescriptor = (allowed.data as { capabilities: Record<string, unknown>[] }).capabilities[0]!
    expect(allowedDescriptor.inputSchema).toEqual({ type: 'object' })
    expect(allowedDescriptor.outputSchema).toBeUndefined()
    const absent = await tools[1]!.execute({ capabilityId: 'world.missing.operation' }, context)
    expect(absent.data).toMatchObject({ capabilities: [] })
  })
  test('blank optional discovery filters are treated as omitted', async () => {
    const tools = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getToolGrants: () => [{ capabilityId }], fetchImpl: catalogFetch([]) })
    const context = { callerId: 'agent', callerName: 'Analyst' }
    const catalog = await tools[0]!.execute({ moduleId: '', definitionType: '', resourceType: '', capabilityId: '' }, context)
    const capabilities = await tools[1]!.execute({ moduleId: ' ', capabilityId: '', risk: '', kind: '' }, context)
    expect(catalog).toMatchObject({ success: true, data: { resources: [{ ref: { id: resourceId } }] } })
    expect(capabilities).toMatchObject({ success: true, data: { capabilities: [{ id: capabilityId, granted: true }] } })
  })
  test('current Room association remains discoverable when filtering for World resources', async () => {
    const ref = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: resourceType, id: resourceId })
    const linked = { ref: { workspaceId, moduleId: 'agents', type: 'agents.room', id: 'room' }, title: 'Conversation', capabilityIds: [], links: [{ rel: 'companion-of', ref }], observedAt: new Date().toISOString() }
    const base = catalogFetch([])
    const tools = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getToolGrants: () => [{ capabilityId }], fetchImpl: (async (input, init) => {
      const response = await base(input, init)
      if (!String(input).endsWith('/resources')) return response
      const body = await response.json() as { resources: unknown[] }
      return Response.json({ ...body, resources: [...body.resources, linked] })
    }) as typeof fetch })
    const result = await tools[0]!.execute({ moduleId: 'world' }, { callerId: 'agent', callerName: 'Analyst', roomId: 'room', focusedSubjects: [ref] })
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ focusedSubjects: [ref], currentRoom: linked, resources: [{ ref }] })
  })
  test('executor cancellation reaches the Workspace broker transport', async () => {
    let observedSignal: AbortSignal | undefined
    const started = Promise.withResolvers<void>()
    const transport = (async (_input, init) => {
      observedSignal = init?.signal ?? undefined
      started.resolve()
      return await new Promise<Response>((_resolve, reject) => observedSignal!.addEventListener('abort', () => reject(observedSignal!.reason), { once: true }))
    }) as typeof fetch
    const registry = createToolRegistry()
    registry.registerAll(createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getToolGrants: () => [{ capabilityId }], fetchImpl: transport }))
    const executor = __testSeam.createToolExecutor(registry, ['workspace_invoke'], { callerId: 'agent', callerName: 'Analyst' })
    const controller = new AbortController()
    const result = executor([{ tool: 'workspace_invoke', arguments: { capabilityId, input: {} } }], undefined, controller.signal)
    await started.promise
    controller.abort(new Error('Evaluation cancelled'))
    expect((await result)[0]?.success).toBe(false)
    expect(observedSignal?.aborted).toBe(true)
  })
  test('executor adds the current turn Resource focus to ToolContext', async () => {
    const ref = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: resourceType, id: resourceId })
    const registry = createToolRegistry()
    registry.register({
      name: 'focus_probe',
      description: 'Returns focused resources.',
      parameters: { type: 'object', additionalProperties: false },
      execute: async (_params, context) => ({ success: true, data: context.focusedSubjects }),
    })
    const executor = __testSeam.createToolExecutor(
      registry,
      ['focus_probe'],
      { callerId: 'agent', callerName: 'Analyst' },
      undefined,
      () => [ref],
    )
    expect((await executor([{ tool: 'focus_probe', arguments: {} }], 'room'))[0]?.data).toEqual([ref])
  })
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
