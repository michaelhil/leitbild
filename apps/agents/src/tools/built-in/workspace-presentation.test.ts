import { expect, test } from 'bun:test'
import { newWorkspaceId, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createWorkspaceCapabilityTools } from './workspace-capability-tools.ts'
import type { ToolContext } from '../../core/types/tool.ts'

const workspaceId = newWorkspaceId()
const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run' })
const recipient = { subject: run, clientId: 'client', documentId: 'doc', leaseId: 'lease', expiresAt: new Date(Date.now() + 60_000).toISOString() }
const context: ToolContext = { callerId: 'actual-agent', callerName: 'Analyst', roomId: 'actual-room', executionCallId: 'call_0_0', executionTurnId: 'actual-turn', presentationRecipient: recipient }
const make = () => {
  const invocations: Array<{ input: Record<string, unknown>; actor: unknown }> = []
  const ids = ['request', 'result', 'cancel'].map(kind => `world.simulation-run.presentation.${kind}`)
  const fetchImpl: typeof fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/resources')) return Response.json({ workspaceId, modules: [], resources: [{ ref: run, title: 'Run', links: [], summary: [], capabilityIds: ids, observedAt: new Date().toISOString() }] })
    if (path.endsWith('/definitions')) return Response.json({ workspaceId, modules: [], definitions: [] })
    if (path.endsWith('/capabilities')) return Response.json({ workspaceId, modules: [], capabilities: ids.map((id, i) => ({
      id, moduleId: 'world', kind: i === 1 ? 'query' : 'command', scope: { kind: 'resource', resourceType: run.type }, title: 'Attention', description: 'Current browser attention', risk: i === 1 ? 'read' : 'write', idempotent: i === 1,
      acceptsPresentationRecipient: true, ...(i === 0 ? { publishes: ['presentation'] } : {}), inputSchema: { type: 'object', required: ['recipient', 'requestId', 'target'], properties: { recipient: { type: 'object' }, requestId: { type: 'string' }, executionId: { type: 'string' }, initiatingRoom: { type: 'object' }, target: { type: 'object' } } }, outputSchema: {},
    })) })
    const body = JSON.parse(String(init?.body)); invocations.push(body)
    return Response.json({ result: { requestId: body.input.requestId, status: 'pending' } })
  }) as typeof fetch
  const tools = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }), fetchImpl })
  return { explore: tools[0]!, call: tools[1]!, invocations, ids }
}

test('presentation dispatch replaces model identities with exact trusted turn/Room/recipient; result reads preserve request identity', async () => {
  const { call, invocations, ids } = make()
  await call.execute({ calls: [{ key: 'attention', operationId: ids[0], input: { target: { subject: run, type: 'world.object', id: 'unit' }, action: { kind: 'highlight' }, purpose: 'Review deviation',
    recipient: { ...recipient, documentId: 'somebody-else' }, requestId: 'forged', executionId: 'forged', initiatingRoom: { id: 'forged' } } }] }, context)
  expect(invocations[0]).toMatchObject({ actor: { kind: 'ai', id: 'actual-agent' }, input: {
    recipient, requestId: 'presentation:actual-turn:call_0_0:attention', executionId: 'actual-turn',
    initiatingRoom: { workspaceId, moduleId: 'agents', type: 'agents.room', id: 'actual-room' },
  } })
  await call.execute({ calls: [{ key: 'outcome', operationId: ids[1], input: { requestId: invocations[0]!.input.requestId, recipient: { ...recipient, clientId: 'forged' } } }] }, context)
  expect(invocations[1]!.input).toEqual({ requestId: invocations[0]!.input.requestId, recipient })
})

test('headless and wrong-Resource offers are refused before dispatch without global fallback', async () => {
  for (const offer of [undefined, { ...recipient, subject: workspaceResourceReferenceSchema.parse({ ...run, id: 'other' }) }]) {
    const { call, invocations, ids } = make()
    const result = await call.execute({ calls: [{ key: 'a', operationId: ids[0], input: {} }] }, { ...context, presentationRecipient: offer })
    expect(invocations).toEqual([])
    expect(result.effects?.[0]?.outcome).toBe('not-dispatched')
    expect(JSON.stringify(result)).toMatch(/no_recipient|presentation_recipient_mismatch/)
  }
})

test('model operation schemas describe only chosen action input, hiding runtime-owned recipient and admission identity', async () => {
  const { explore, ids } = make()
  const result = await explore.execute({ view: 'operations', operationIds: [ids[0]], includeInputSchema: true }, context)
  const schema = (result.data as { operations: Array<{ inputSchema: { properties: object; required: string[] } }> }).operations[0]!.inputSchema
  expect(Object.keys(schema.properties)).toEqual(['target'])
  expect(schema.required).toEqual(['target'])
})


test('a captured timestamp never falsely expires an exact lease renewed by its owner during a long turn', async () => {
  const { call, invocations, ids } = make()
  const captured = { ...recipient, expiresAt: '2000-01-01T00:00:00Z' }
  await call.execute({ calls: [{ key: 'late', operationId: ids[0], input: {} }] }, { ...context, presentationRecipient: captured })
  expect(invocations).toHaveLength(1)
  expect(invocations[0]!.input.recipient).toEqual(captured)
  // The bridge cannot replace it with the latest document, even if a model asks.
  expect((invocations[0]!.input.recipient as typeof recipient).documentId).toBe('doc')
})
