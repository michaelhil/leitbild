import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { createConversationReadTool } from '../tools/built-in/conversation-read.ts'
import type { ExecutionTurn } from '../core/executions/store.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import { discoveryMemo } from './discovery-memo.ts'
import { buildSystemSections } from './context-builder.ts'
import type { ToolResult } from '../core/types/tool.ts'
import type { AgentHistory } from '../core/types/messaging.ts'

const stores: ReturnType<typeof createExecutionStore>[] = []
const directories: string[] = []
const openStore = (path = ':memory:') => {
  const store = createExecutionStore(path)
  stores.push(store)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const introduction = 'Workspace operations you used earlier in this conversation, with the exact target and input schema they had then. '
  + 'Call them again with workspace_call without exploring them first; a target or schema that changed is refused with the current one.'
const expectedMemo = (...lines: string[]) => lines.length ? [introduction, ...lines].join('\n') : ''
const noSchema = 'input schema: read it with workspace_explore operationIds if you need it'

const ROOM = 'room-1'
const target = { kind: 'resource', ref: { workspaceId: 'ws', moduleId: 'world', type: 'world.simulation-run', id: 'run-1' } }
const plantsSchema = { type: 'object', properties: {} }
const composeSchema = { type: 'object', properties: { plantId: { type: 'string' }, panels: { type: 'array' } }, required: ['plantId', 'panels'] }

// The execution record as a turn leaves it: the explore that found the
// operations with their schemas, then the calls that used them.
const recordTurn = (
  store: ReturnType<typeof createExecutionStore>,
  turnId: string,
  agentId: string,
  startedAt: number,
  calls: ReadonlyArray<{ tool: string; result?: ToolResult; id?: string; at?: number; arguments?: unknown }>,
  status: ExecutionTurn['status'] = 'completed',
  roomId = ROOM,
) => {
  store.beginTurn({ id: turnId, roomId, agentId, startedAt })
  calls.forEach((call, index) => {
    const id = call.id ?? `${turnId}-call-${index}`
    store.recordAttempt(turnId, { id, tool: call.tool, arguments: call.arguments ?? {}, startedAt: call.at ?? startedAt + index })
    if (call.result !== undefined) store.recordOutcome(turnId, id, call.result, startedAt + index)
  })
  if (status !== 'running') store.finishTurn(turnId, status)
}
const explored = (operations: ReadonlyArray<{ operationId: string; inputSchema?: unknown }>): { tool: string; result: ToolResult } =>
  ({ tool: 'workspace_explore', result: { success: true, data: { operations } } })
const called = (results: ReadonlyArray<Record<string, unknown>>): { tool: string; result: ToolResult } =>
  ({ tool: 'workspace_call', result: { success: true, data: { results } } })

describe('discovery memo', () => {
  test('names the operations an Agent used in this Room, newest first, with the target and schema they had', () => {
    const store = openStore()
    recordTurn(store, 'turn-1', 'assistant', 1_000, [
      explored([{ operationId: 'world.process-plant.plants.list', inputSchema: plantsSchema }, { operationId: 'world.process-plant.display.compose', inputSchema: composeSchema }]),
      called([{ key: 'plants', operationId: 'world.process-plant.plants.list', target, success: true, data: {} }]),
      called([{ key: 'display', operationId: 'world.process-plant.display.compose', target, success: true, data: {} }]),
    ])
    expect(discoveryMemo(store, ROOM, 'assistant')).toBe([
      'Workspace operations you used earlier in this conversation, with the exact target and input schema they had then. '
        + 'Call them again with workspace_call without exploring them first; a target or schema that changed is refused with the current one.',
      `- world.process-plant.display.compose · target ${JSON.stringify(target)} · input schema ${JSON.stringify(composeSchema)}`,
      `- world.process-plant.plants.list · target ${JSON.stringify(target)} · input schema ${JSON.stringify(plantsSchema)}`,
    ].join('\n'))
  })

  test('remembers only what succeeded, takes a schema from a refusal, and leaves out other Agents and the running turn', () => {
    const store = openStore()
    recordTurn(store, 'turn-1', 'assistant', 1_000, [
      called([
        { key: 'refused', operationId: 'world.process-plant.signals.read', success: false, error: 'invalid_request', inputSchema: plantsSchema },
        { key: 'read', operationId: 'world.process-plant.signals.search', target, success: true, data: {} },
      ]),
    ])
    recordTurn(store, 'turn-2', 'other-agent', 2_000, [called([{ key: 'x', operationId: 'world.weather.map-features', target, success: true, data: {} }])])
    recordTurn(store, 'turn-3', 'assistant', 3_000, [called([{ key: 'y', operationId: 'world.process-plant.controls.list', target, success: true, data: {} }])], 'running')
    recordTurn(store, 'turn-4', 'assistant', 4_000, [called([{ key: 'z', operationId: 'world.process-plant.signals.read', target, success: true, data: {} }])])
    const memo = discoveryMemo(store, ROOM, 'assistant')
    expect(memo.split('\n').slice(1)).toEqual([
      `- world.process-plant.signals.read · target ${JSON.stringify(target)} · input schema ${JSON.stringify(plantsSchema)}`,
      `- world.process-plant.signals.search · target ${JSON.stringify(target)} · input schema: read it with workspace_explore operationIds if you need it`,
    ])
    expect(memo).not.toContain('map-features')
    expect(memo).not.toContain('controls.list')
  })

  test('is empty without Workspace operations, so the context gains no section', () => {
    const store = openStore()
    expect(discoveryMemo(store, ROOM, 'assistant')).toBe('')
    recordTurn(store, 'turn-1', 'assistant', 1_000, [{ tool: 'conversation_read', result: { success: true, data: {} } }])
    expect(discoveryMemo(store, ROOM, 'assistant')).toBe('')
  })

  test('reaches the system prompt as its own context section', () => {
    const history: AgentHistory = { rooms: new Map(), incoming: [], agentProfiles: new Map() } as unknown as AgentHistory
    const sections = buildSystemSections({
      agentId: 'assistant', persona: 'p', history, historyLimit: 10, resolveName: name => name,
      getDiscoveryMemo: roomId => roomId === ROOM ? 'Workspace operations you used earlier in this conversation …' : '',
    }, ROOM)
    expect(sections.find(section => section.key === 'ctx_discovery')).toMatchObject({ enabled: true, text: 'Workspace operations you used earlier in this conversation …' })
  })
})

test('the newest thirty Room turns are selected before Agent and running-status filters', () => {
  const store = openStore()
  recordTurn(store, 'old-own', 'assistant', 0, [called([{ operationId: 'world.boundary', success: true }])])
  for (let index = 1; index <= 28; index++) recordTurn(store, `other-${index}`, 'other-agent', index, [])
  recordTurn(store, 'running', 'assistant', 29, [called([{ operationId: 'world.running', success: true }])], 'running')
  expect(discoveryMemo(store, ROOM, 'assistant')).toBe(expectedMemo(`- world.boundary · ${noSchema}`))
  recordTurn(store, 'newer-other', 'other-agent', 30, [], 'failed')
  expect(discoveryMemo(store, ROOM, 'assistant')).toBe('')
})

test('tied turn IDs, call insertion and batch array order determine the exact newest target and refused schema', () => {
  const store = openStore()
  const updated = { type: 'object', required: ['newField'] }
  recordTurn(store, 'Z-turn', 'assistant', 1000, [
    { ...called([
      { operationId: 'world.shared', success: true, target: { selected: 2 } },
      { operationId: 'world.secondary', success: true, target: null },
      { operationId: 'world.shared', success: true, target: { selected: 3 } },
    ]), id: 'z-first', at: 2000 },
    { ...called([{ operationId: 'world.shared', success: false, inputSchema: updated }]), id: 'a-second', at: 2000 },
  ])
  recordTurn(store, 'A-turn', 'assistant', 1000, [
    explored([{ operationId: 'world.shared', inputSchema: plantsSchema }]),
    called([{ operationId: 'world.shared', success: true, target: { selected: 1 } }]),
  ])
  expect(discoveryMemo(store, ROOM, 'assistant')).toBe(expectedMemo(
    `- world.shared · target {"selected":3} · input schema ${JSON.stringify(updated)}`,
    `- world.secondary · target null · ${noSchema}`,
  ))
})

test('the eight-operation presentation limit preserves numeric batch order and complete stored outcomes', () => {
  const store = openStore()
  const results = Array.from({ length: 12 }, (_, index) => ({
    operationId: `world.operation-${index}`, success: true, target: { index }, data: { exact: 'retained '.repeat(1000) },
  }))
  recordTurn(store, 'batch', 'assistant', 1, [called(results)])
  const before = JSON.stringify(store.getCall(ROOM, 'batch', 'batch-call-0'))
  expect(discoveryMemo(store, ROOM, 'assistant')).toBe(expectedMemo(
    ...[11, 10, 9, 8, 7, 6, 5, 4].map(index => `- world.operation-${index} · target {"index":${index}} · ${noSchema}`),
  ))
  expect(JSON.stringify(store.getCall(ROOM, 'batch', 'batch-call-0'))).toBe(before)
})

test('the existing schema presentation budget counts serialized characters and skips an oversized schema without consuming it', () => {
  const store = openStore()
  const schema = { description: 'å'.repeat(8192 - JSON.stringify({ description: '' }).length) }
  const oversized = { description: schema.description + 'x' }
  expect(JSON.stringify(schema)).toHaveLength(8192)
  expect(Buffer.byteLength(JSON.stringify(schema))).toBeGreaterThan(8192)
  recordTurn(store, 'schemas', 'assistant', 1, [
    explored([
      { operationId: 'world.small', inputSchema: {} },
      { operationId: 'world.exact', inputSchema: schema },
      { operationId: 'world.oversized', inputSchema: oversized },
    ]),
    called(['world.small', 'world.exact', 'world.oversized'].map(operationId => ({ operationId, success: true }))),
  ])
  expect(discoveryMemo(store, ROOM, 'assistant')).toBe(expectedMemo(
    `- world.oversized · ${noSchema}`,
    `- world.exact · input schema ${JSON.stringify(schema)}`,
    `- world.small · ${noSchema}`,
  ))
})

test('malformed evidence is ignored while explicit null schemas and successful target removal keep their meaning', () => {
  const store = openStore()
  const malformed = [null, [], true, { success: 1, data: { results: [{ operationId: 'wrong-outer', success: true }] } },
    { success: true, data: null }, { success: true, data: { results: {} } },
    { success: true, data: { results: [null, [], 'bad', { operationId: 42, success: true }, { operationId: 'wrong-inner', success: 1 }] } }]
  recordTurn(store, 'malformed', 'assistant', 1, malformed.map(result => ({ tool: 'workspace_call', result: result as unknown as ToolResult })))
  recordTurn(store, 'valid', 'assistant', 2, [
    explored([{ operationId: 'world.read', inputSchema: plantsSchema }]),
    called([{ operationId: 'world.read', success: true, target: false }]),
    called([{ operationId: 'world.read', success: false, inputSchema: null, target: { refused: true } }]),
    called([{ operationId: 'world.read', success: true }]),
    { tool: 'workspace_explore', result: { success: false, data: { operations: [{ operationId: 'world.read', inputSchema: 'must not replace null' }] } } },
    { tool: 'workspace_call' },
  ])
  expect(discoveryMemo(store, ROOM, 'assistant')).toBe(expectedMemo('- world.read · input schema null'))
})

test('identical turn and call identities stay scoped to their Room, Agent and Workspace store', () => {
  const first = openStore(), second = openStore()
  recordTurn(first, 'same-turn', 'assistant', 1, [called([{ operationId: 'world.first-workspace', success: true }])])
  recordTurn(second, 'same-turn', 'assistant', 1, [called([{ operationId: 'world.second-workspace', success: true }])])
  recordTurn(first, 'other-agent', 'different-agent', 2, [called([{ operationId: 'world.other-agent', success: true }])])
  recordTurn(first, 'other-room', 'assistant', 3, [called([{ operationId: 'world.other-room', success: true }])], 'completed', 'room-2')
  expect(discoveryMemo(first, ROOM, 'assistant')).toBe(expectedMemo(`- world.first-workspace · ${noSchema}`))
  expect(discoveryMemo(second, ROOM, 'assistant')).toBe(expectedMemo(`- world.second-workspace · ${noSchema}`))
  expect(discoveryMemo(first, 'room-2', 'assistant')).toBe(expectedMemo(`- world.other-room · ${noSchema}`))
  expect(discoveryMemo(first, ROOM, 'different-agent')).toBe(expectedMemo(`- world.other-agent · ${noSchema}`))
})

test('terminal and late outcomes, exact recall, reopen and deletion remain authoritative after memo reads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'discovery-exact-recall-'))
  directories.push(directory)
  const file = join(directory, 'executions.sqlite')
  let store = openStore(file)
  const rooms = createRoomDirectory()
  const room = rooms.restoreRoom({ id: ROOM, name: 'Memo', createdBy: 'test', createdAt: 1, scope: { kind: 'workspace' }, scopeRevision: 0 })
  room.addMember('assistant')
  const context = { roomId: ROOM, callerId: 'assistant', callerName: 'Assistant' }
  const recall = (turnId: string, toolCallId: string, part: 'arguments' | 'result') =>
    createConversationReadTool(rooms, store).execute({ turnId, toolCallId, part }, context)
  const exact = { success: true, data: { results: [{ operationId: 'world.done', success: true, data: { full: 'evidence '.repeat(2000) } }] } }
  recordTurn(store, 'done', 'assistant', 3, [{ tool: 'workspace_call', result: exact, arguments: { exact: [12.123456789, 'opaque:selector'] } }])
  recordTurn(store, 'failed', 'assistant', 2, [called([{ operationId: 'world.failed', success: true }])], 'failed')
  recordTurn(store, 'cancelled', 'assistant', 1, [{ tool: 'workspace_call' }], 'interrupted')
  recordTurn(store, 'inflight', 'assistant', 4, [called([{ operationId: 'world.inflight', success: true }])], 'running')
  const before = JSON.stringify(store.getCall(ROOM, 'done', 'done-call-0'))
  const exactArguments = await recall('done', 'done-call-0', 'arguments')
  const exactOutcome = await recall('done', 'done-call-0', 'result')
  expect(await recall('cancelled', 'cancelled-call-0', 'result')).toMatchObject({ success: false, error: expect.stringContaining('conversation_outcome_unknown') })
  expect(discoveryMemo(store, ROOM, 'assistant')).toBe(expectedMemo(`- world.done · ${noSchema}`, `- world.failed · ${noSchema}`))
  store.recordOutcome('cancelled', 'cancelled-call-0', called([{ operationId: 'world.late-cancelled', success: true }]).result, 10)
  expect(discoveryMemo(store, ROOM, 'assistant')).toBe(expectedMemo(
    `- world.done · ${noSchema}`, `- world.failed · ${noSchema}`, `- world.late-cancelled · ${noSchema}`,
  ))
  expect(await recall('done', 'done-call-0', 'arguments')).toEqual(exactArguments)
  expect(await recall('done', 'done-call-0', 'result')).toEqual(exactOutcome)
  expect(JSON.stringify(store.getCall(ROOM, 'done', 'done-call-0'))).toBe(before)
  const listing = await createConversationReadTool(rooms, store).execute({ turnId: 'done' }, context)
  expect(listing).toMatchObject({ success: true, data: { calls: [{ read: { turnId: 'done', toolCallId: 'done-call-0' } }] } })

  store.close()
  store = openStore(file)
  expect(discoveryMemo(store, ROOM, 'assistant')).toBe(expectedMemo(
    `- world.inflight · ${noSchema}`, `- world.done · ${noSchema}`, `- world.failed · ${noSchema}`, `- world.late-cancelled · ${noSchema}`,
  ))
  expect(await recall('done', 'done-call-0', 'result')).toEqual(exactOutcome)
  store.linkMessage('done', 'posted-message')
  store.deleteMessage(ROOM, 'posted-message')
  expect(discoveryMemo(store, ROOM, 'assistant')).not.toContain('world.done')
  expect(await recall('done', 'done-call-0', 'result')).toMatchObject({ success: false, error: expect.stringContaining('conversation_execution_unavailable') })
  store.deleteRoom(ROOM)
  expect(discoveryMemo(store, ROOM, 'assistant')).toBe('')
  await expect(recall('inflight', 'inflight-call-0', 'result')).resolves.toMatchObject({ success: false })
})

test('JSON target and schema values retain null, false, zero, string, array and object distinctions', () => {
  const store = openStore()
  const values = [null, false, 0, 'quoted "value"', [1, { nested: false }], { second: 2, first: 1 }]
  recordTurn(store, 'json-values', 'assistant', 1, [
    explored(values.map((inputSchema, index) => ({ operationId: `world.value-${index}`, inputSchema }))),
    called(values.map((value, index) => ({ operationId: `world.value-${index}`, success: true, target: value }))),
  ])
  expect(discoveryMemo(store, ROOM, 'assistant')).toBe(expectedMemo(
    ...[5, 4, 3, 2, 1, 0].map(index => `- world.value-${index} · target ${JSON.stringify(values[index])} · input schema ${JSON.stringify(values[index])}`),
  ))
})

test('late actual outcomes remain discoverable after every terminal status and consumer edits remain detached', () => {
  const store = openStore()
  for (const [index, status] of (['completed', 'interrupted', 'failed'] as const).entries()) {
    const turn = `late-${status}`
    recordTurn(store, turn, 'assistant', index, [{ tool: 'workspace_call' }], status)
    expect(discoveryMemo(store, ROOM, 'assistant')).not.toContain(`world.${status}`)
    const result = called([{ operationId: `world.${status}`, success: true }]).result
    store.recordOutcome(turn, `${turn}-call-0`, result)
    expect(discoveryMemo(store, ROOM, 'assistant')).toContain(`- world.${status} · ${noSchema}`)
    const returned = store.getCall(ROOM, turn, `${turn}-call-0`)!
    ;(returned.result!.data as { results: unknown[] }).results.length = 0
    expect(discoveryMemo(store, ROOM, 'assistant')).toContain(`- world.${status} · ${noSchema}`)
    expect(() => store.recordOutcome(turn, `${turn}-call-0`, { success: false, error: 'replacement' })).toThrow('already recorded')
  }
})

test('operation identifiers and nested JSON strings preserve lone surrogates and NUL characters exactly', () => {
  const store = openStore()
  const operationId = 'world.x\ud800y\0z'
  const exactTarget = { name: 'target\udfff\0value' }
  const inputSchema = { description: 'schema\ud800\0text', properties: { 'key\udfff': { const: 'value\ud800' } } }
  recordTurn(store, 'exact-strings', 'assistant', 1, [
    explored([{ operationId, inputSchema }]),
    called([{ operationId, success: true, target: exactTarget }]),
  ])
  expect(discoveryMemo(store, ROOM, 'assistant')).toBe(expectedMemo(
    '- ' + operationId + ' · target ' + JSON.stringify(exactTarget) + ' · input schema ' + JSON.stringify(inputSchema),
  ))
})
