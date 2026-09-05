import { describe, expect, test } from 'bun:test'
import {
  capabilityIdSchema,
  moduleIdSchema,
  newWorkspaceId,
  workspaceDefinitionRevisionReferenceSchema,
  workspaceResourceReferenceSchema,
  type WorkspaceRoomScope,
} from '@leitbild/contracts'
import { createWorkspaceCapabilityTools } from './workspace-capability-tools.ts'

const workspaceId = newWorkspaceId()
const moduleId = moduleIdSchema.parse('world')
const readId = capabilityIdSchema.parse('world.simulation-run.read')
const writeId = capabilityIdSchema.parse('world.simulation-run.write')
const inspectDefinitionId = capabilityIdSchema.parse('world.scenario.inspect')
const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: 'world.simulation-run', id: 'run-01' })
const otherRun = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: 'world.simulation-run', id: 'run-02' })
const family = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: 'world.run-family', id: 'family-01' })
const definition = workspaceDefinitionRevisionReferenceSchema.parse({
  workspaceId, moduleId, type: 'world.scenario', id: 'scenario-01', revisionId: 'revision-01',
})
const runTarget = { kind: 'resource' as const, ref: run }
const now = new Date().toISOString()

const catalogFetch = (requests: Request[]): typeof fetch => (async (input, init) => {
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
  requests.push(request)
  const pathname = new URL(request.url).pathname
  if (pathname.endsWith('/resources')) return Response.json({
    workspaceId,
    modules: [{ moduleId, status: 'ready' }],
    resources: [
      { ref: run, title: 'Run 01', capabilityIds: [readId, writeId], links: [{ rel: 'member-of', ref: family }], summary: [], observedAt: now },
      { ref: otherRun, title: 'Run 02', capabilityIds: [readId], links: [{ rel: 'member-of', ref: family }], summary: [], observedAt: now },
      { ref: family, title: 'Run family', capabilityIds: [], links: [{ rel: 'contains', ref: run }, { rel: 'contains', ref: otherRun }], summary: [], observedAt: now },
    ],
  })
  if (pathname.endsWith('/definitions')) return Response.json({
    workspaceId,
    modules: [{ moduleId, status: 'ready' }],
    definitions: [{
      ref: { workspaceId, moduleId, type: definition.type, id: definition.id },
      title: 'Scenario 01', currentRevisionId: definition.revisionId,
      capabilityIds: [inspectDefinitionId], inspectionCapabilityId: inspectDefinitionId,
    }],
  })
  if (pathname.endsWith('/capabilities')) return Response.json({
    workspaceId,
    modules: [{ moduleId, status: 'ready' }],
    capabilities: [
      { id: readId, moduleId, kind: 'query', scope: { kind: 'resource', resourceType: run.type }, title: 'Read run', description: 'Read current live simulation state and time.', risk: 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
      { id: writeId, moduleId, kind: 'command', scope: { kind: 'resource', resourceType: run.type }, title: 'Change run', description: 'Change the live simulation.', risk: 'write', idempotent: false, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
      { id: inspectDefinitionId, moduleId, kind: 'query', scope: { kind: 'definition', definitionType: definition.type }, title: 'Inspect scenario', description: 'Read a scenario definition.', risk: 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
    ],
  })
  return Response.json({ result: { state: 'running' } })
}) as typeof fetch

const makeTools = (scope: WorkspaceRoomScope, requests: Request[] = []) => createWorkspaceCapabilityTools({
  workspaceId,
  hostBaseUrl: 'https://host.test',
  getRoomScope: roomId => roomId === 'room' ? scope : undefined,
  fetchImpl: catalogFetch(requests),
})

const context = { callerId: 'agent', callerName: 'Analyst', roomId: 'room' }

describe('Workspace progressive-discovery tools', () => {
  test('exposes only the two generic tools', () => {
    expect(makeTools({ kind: 'workspace' }).map(tool => tool.name)).toEqual(['workspace_explore', 'workspace_call'])
  })

  test('explores compact Resources and exact operation schemas inside Room Scope', async () => {
    const [explore] = makeTools({ kind: 'resource', resource: run })
    const scope = await explore!.execute({ view: 'scope' }, context)
    expect(scope).toMatchObject({ success: true, data: {
      scope: { kind: 'resource', resource: run }, total: 1,
      resources: [{ target: runTarget, operationCount: 2 }],
    } })

    const operations = await explore!.execute({
      view: 'operations', target: runTarget, operationIds: [readId], includeInputSchema: true,
    }, context)
    expect(operations).toMatchObject({ success: true, data: {
      operations: [{ operationId: readId, inputSchema: { type: 'object' } }],
    } })
  })

  test('resolves collection membership live and honors exclusions', async () => {
    const [explore] = makeTools({
      kind: 'collection', collection: family, members: { mode: 'all', except: [otherRun] },
    })
    const result = await explore!.execute({ view: 'scope' }, context)
    const ids = ((result.data as { resources: Array<{ target: { ref: { id: string } } }> }).resources)
      .map(resource => resource.target.ref.id)
    expect(ids).toEqual(['run-01', 'family-01'])
  })

  test('calls reads and changes through one shape while enforcing Room Scope', async () => {
    const [, call] = makeTools({ kind: 'resource', resource: run })
    expect(await call!.execute({ calls: [{ key: 'state', operationId: readId, target: runTarget, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ key: 'state', operationId: readId, success: true, data: { state: 'running' } }] } })

    expect(await call!.execute({ calls: [{ key: 'other', operationId: readId, target: { kind: 'resource', ref: otherRun }, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('target_out_of_scope') }] } })
  })

  test('batches independent reads but rejects a batch containing a change', async () => {
    const requests: Request[] = []
    const [, call] = makeTools({ kind: 'resource', resource: run }, requests)
    expect(await call!.execute({ calls: [
      { key: 'one', operationId: readId, target: runTarget, input: {} },
      { key: 'two', operationId: readId, target: runTarget, input: {} },
    ] }, context)).toMatchObject({ success: true, data: { results: [{ key: 'one', success: true }, { key: 'two', success: true }] } })

    const before = requests.filter(request => request.url.includes('/invoke')).length
    expect(await call!.execute({ calls: [
      { key: 'read', operationId: readId, target: runTarget, input: {} },
      { key: 'write', operationId: writeId, target: runTarget, input: {} },
    ] }, context)).toMatchObject({ success: false, error: expect.stringContaining('batch_requires_read_operations') })
    expect(requests.filter(request => request.url.includes('/invoke'))).toHaveLength(before)
  })

  test('requires a Room with an explicit Scope', async () => {
    const [, call] = makeTools({ kind: 'workspace' })
    expect(await call!.execute({ calls: [{ key: 'state', operationId: readId, target: runTarget, input: {} }] }, {
      callerId: 'agent', callerName: 'Analyst', roomId: 'missing',
    })).toMatchObject({ success: false, error: expect.stringContaining('room_scope_unavailable') })
  })
})
