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

const workspaceId = newWorkspaceId()
const capabilityId = capabilityIdSchema.parse('world.simulation-run.read')
const writeCapabilityId = capabilityIdSchema.parse('world.simulation-run.write')
const moduleId = moduleIdSchema.parse('world')
const resourceType = resourceTypeSchema.parse('world.simulation-run')
const resourceId = resourceIdSchema.parse('run-01')
const resource = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: resourceType, id: resourceId })
const target = { moduleId, type: resourceType, id: resourceId }

const catalogFetch = (requests: Request[]): typeof fetch => (async (input, init) => {
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
  requests.push(request)
  if (request.url.endsWith('/resources')) return Response.json({
    workspaceId, modules: [{ moduleId, status: 'ready' }], resources: [{
      ref: resource, title: 'Run 01', capabilityIds: [capabilityId, writeCapabilityId], links: [], summary: [], observedAt: new Date().toISOString(),
    }],
  })
  if (request.url.endsWith('/definitions')) return Response.json({ workspaceId, modules: [{ moduleId, status: 'ready' }], definitions: [] })
  if (request.url.endsWith('/capabilities')) return Response.json({
    workspaceId, modules: [{ moduleId, status: 'ready' }], capabilities: [{
      id: capabilityId, moduleId, kind: 'query', scope: { kind: 'resource', resourceType }, title: 'Read Run', description: 'Reads live simulation state.', risk: 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    }, {
      id: writeCapabilityId, moduleId, kind: 'command', scope: { kind: 'resource', resourceType }, title: 'Write Run', description: 'Changes simulation state.', risk: 'write', idempotent: false, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    }],
  })
  return Response.json({ result: { runId: resourceId, state: 'running' } })
}) as typeof fetch

const create = (options: { linked?: boolean; exact?: boolean; requests?: Request[] } = {}) => createWorkspaceCapabilityTools({
  workspaceId,
  hostBaseUrl: 'https://host.test',
  getToolGrants: () => options.exact ? [{ capabilityId }] : [{ scope: 'room-linked-resource', risk: 'read' }],
  getRoomCompanionOf: roomId => options.linked && roomId === 'room' ? resource : undefined,
  fetchImpl: catalogFetch(options.requests ?? []),
})

describe('Workspace Capability tools', () => {
  test('current catalog is compact and follows the current Room link', async () => {
    const base = catalogFetch([])
    const linkedRoom = { ref: { workspaceId, moduleId: 'agents', type: 'agents.room', id: 'room' }, title: 'Conversation', capabilityIds: [], links: [{ rel: 'companion-of', ref: resource }], summary: [], observedAt: new Date().toISOString() }
    const tools = createWorkspaceCapabilityTools({
      workspaceId, hostBaseUrl: 'https://host.test', getToolGrants: () => [{ scope: 'room-linked-resource', risk: 'read' }], getRoomCompanionOf: () => resource,
      fetchImpl: (async (input, init) => {
        const response = await base(input, init)
        if (!String(input).endsWith('/resources')) return response
        const body = await response.json() as { resources: unknown[] }
        return Response.json({ ...body, resources: [...body.resources, linkedRoom] })
      }) as typeof fetch,
    })
    const result = await tools[0]!.execute({}, { callerId: 'agent', callerName: 'Analyst', roomId: 'room' })
    expect(result).toMatchObject({ success: true, data: { currentRoom: linkedRoom, total: 2, resources: [{ ref: resource }, { ref: { id: 'room' } }] } })

    const wildcardResult = await tools[0]!.execute(
      { scope: 'current', moduleId: '*', definitionType: '*', resourceType: '*', capabilityId: '*' },
      { callerId: 'agent', callerName: 'Analyst', roomId: 'room' },
    )
    expect(wildcardResult).toMatchObject({ success: true, data: { total: 2 } })
  })

  test('searches descriptors and exposes schemas only for exact granted requests', async () => {
    const tools = create({ linked: true })
    const context = { callerId: 'agent', callerName: 'Analyst', roomId: 'room' }
    const broad = await tools[1]!.execute({ resource: target, queries: ['live state'] }, context)
    expect(broad.success).toBe(true)
    const broadMatch = (broad.data as { capabilities: Array<Record<string, unknown> & { id: string }> }).capabilities.find(item => item.id === capabilityId)!
    expect(broadMatch).toMatchObject({ id: capabilityId, granted: true, matchedQueries: ['live state'] })
    expect(broadMatch.inputSchema).toBeUndefined()
    const exact = await tools[1]!.execute({ resource: target, capabilityIds: [capabilityId], includeOutputSchema: true }, context)
    expect(exact).toMatchObject({ success: true, data: { capabilities: [{ inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }] } })

    const natural = await tools[1]!.execute({ resource: target, queries: ['current simulation execution state and time'] }, context)
    expect((natural.data as { capabilities: Array<{ id: string }> }).capabilities.map(item => item.id)).toContain(capabilityId)

    const combined = await tools[1]!.execute({ resource: target, queries: ['unrelated phrase'], capabilityIds: [capabilityId] }, context)
    expect(combined).toMatchObject({ success: true, data: { capabilities: [{ id: capabilityId, inputSchema: { type: 'object' } }] } })

    const unscopedWildcard = await tools[1]!.execute({
      resource: { moduleId: '*', type: '*', id: '*' },
      queries: ['simulation state'], risk: 'read', kind: 'query',
    }, context)
    expect(unscopedWildcard).toMatchObject({ success: true, data: { capabilities: [{ id: capabilityId }] } })

    const partialWildcard = await tools[1]!.execute({ resource: { moduleId: 'world', type: '*', id: '*' } }, context)
    expect(partialWildcard).toMatchObject({ success: false, error: expect.stringContaining('partial wildcards') })
  })

  test('semantic read grant rejects missing Room, wrong target, writes, and stale Capabilities with distinct reasons', async () => {
    const tools = create({ linked: true })
    const call = (id: string, selected = target, roomId?: string) => tools[2]!.execute({ calls: [{ key: 'x', capabilityId: id, resource: selected, input: {} }] }, { callerId: 'agent', callerName: 'Analyst', ...(roomId ? { roomId } : {}) })
    expect(await call(capabilityId, target, undefined)).toMatchObject({ success: true, data: { results: [{ error: expect.stringContaining('room_context_required') }] } })
    expect(await call(capabilityId, { ...target, id: resourceIdSchema.parse('other') }, 'room')).toMatchObject({ success: true, data: { results: [{ error: expect.stringContaining('target_not_linked') }] } })
    expect(await call(writeCapabilityId, target, 'room')).toMatchObject({ success: true, data: { results: [{ error: expect.stringContaining('risk_not_allowed') }] } })
    expect(await call('world.simulation-run.missing', target, 'room')).toMatchObject({ success: true, data: { results: [{ error: expect.stringContaining('capability_not_advertised') }] } })
  })

  test('runs independent reads concurrently and preserves keyed request order', async () => {
    const tools = create({ linked: true })
    const result = await tools[2]!.execute({ calls: [
      { key: 'summary', capabilityId, resource: target, input: {} },
      { key: 'state', capabilityId, resource: target, input: {} },
    ] }, { callerId: 'agent', callerName: 'Analyst', roomId: 'room' })
    expect(result).toMatchObject({ success: true, data: { results: [{ key: 'summary', success: true }, { key: 'state', success: true }] } })
  })

  test('rejects mixed write batches before invocation', async () => {
    const requests: Request[] = []
    const tools = create({ linked: true, requests })
    const result = await tools[2]!.execute({ calls: [
      { key: 'read', capabilityId, resource: target, input: {} },
      { key: 'write', capabilityId: writeCapabilityId, resource: target, input: {} },
    ] }, { callerId: 'agent', callerName: 'Analyst', roomId: 'room' })
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('batch_requires_read_capabilities') })
    expect(requests.filter(request => request.url.includes('/invoke'))).toHaveLength(0)
  })

  test('exact grants still authorize one operation without a Room link', async () => {
    const tools = create({ exact: true })
    const result = await tools[2]!.execute({ calls: [{ key: 'read', capabilityId, resource: target, input: {} }] }, { callerId: 'agent', callerName: 'Analyst' })
    expect(result).toMatchObject({ success: true, data: { results: [{ key: 'read', success: true, data: { state: 'running' } }] } })
  })
})
