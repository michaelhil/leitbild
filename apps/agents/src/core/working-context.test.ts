import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionStore, type ExecutionStore } from './executions/store.ts'
import { createWorkingContextArchive, prepareWorkingContextCheckpoint, projectWorkingContextMessages, type WorkingContextGroup, type WorkingMessage } from './working-context.ts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const fixture = () => {
  const path = mkdtempSync(join(tmpdir(), 'working-context-'))
  const store = createExecutionStore(join(path, 'execution.sqlite'))
  cleanup.push(() => rmSync(path, { recursive: true, force: true }), () => store.close())
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 })
  store.beginModelCapture('turn', 'room')
  const archive = createWorkingContextArchive(store, { roomId: 'room', turnId: 'turn', agentId: 'agent',
    commit: async manifest => store.recordStage('turn', { kind: 'context_checkpoint', manifest }) })
  return { store, archive }
}
const group = (store: ExecutionStore, id: string, kind: 'read' | 'change' | 'unknown' = 'read', failed = false): WorkingContextGroup => {
  const call = { callId: id, providerCallId: `provider_${id}`, tool: 'test', arguments: { id } }
  const result = { success: !failed, data: { exact: id }, effects: [{ kind, outcome: failed ? 'unknown' as const : 'returned' as const }] }
  store.recordAttempt('turn', { id, tool: call.tool, providerCallId: call.providerCallId, arguments: call.arguments, startedAt: 2 })
  store.recordOutcome('turn', id, result, 3)
  return { groupId: `group_${id}`, calls: [{ call, result }], messages: [
    { role: 'assistant', content: '', toolCalls: [{ id: call.providerCallId, function: { name: call.tool, arguments: call.arguments } }] },
    { role: 'tool', name: call.tool, toolCallId: call.providerCallId, content: JSON.stringify(result) },
  ] }
}

test('real durable calls admit exact groups; roles, archived bytes and cumulative change receipts survive checkpoints', async () => {
  const { store, archive } = fixture()
  const old = group(store, 'old', 'change'), current = group(store, 'current'), bad = group(store, 'bad', 'unknown', true)
  const all: WorkingMessage[] = [{ role: 'system', content: 'Policy' }, { role: 'user', content: 'Keep Human steering verbatim' }, ...old.messages, ...current.messages, ...bad.messages]
  const original = JSON.stringify(store.getCall('room', 'turn', 'old'))
  const first = prepareWorkingContextCheckpoint({ input: { reason: 'source-owned review recorded', retain: [{ toolCallId: 'current', reason: 'current canonical record' }] },
    groups: [old, current, bad], archive, checkpointCallId: 'checkpoint', precedingModelId: 'model_3', ordinal: 1 })
  expect(first.manifest.archivedGroups.map(g => g.callIds)).toEqual([['old']])
  expect(first.manifest.retainedGroups.map(g => g.callIds)).toEqual([['current'], ['bad'], ['checkpoint']])
  expect(first.manifest.actionLedger[0]!.arguments).toEqual({ turnId: 'turn', toolCallId: 'old', part: 'arguments' })
  expect(first.manifest.actionLedger[0]!.effects[0]!.outcome).toBe('returned')
  const projected = projectWorkingContextMessages(all, [old, current, bad], first.retainedGroupIds)
  expect(projected.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool'])
  expect(projected[1]!.content).toBe('Keep Human steering verbatim')
  await archive.commit(first.manifest)
  const next = group(store, 'next')
  const second = prepareWorkingContextCheckpoint({ input: { reason: 'next review', retain: [{ toolCallId: 'next', reason: 'fresh state' }] },
    groups: [old, current, bad, next], archive, checkpointCallId: 'checkpoint2', precedingModelId: 'model_5', ordinal: 2,
    previous: { manifest: first.manifest, callId: 'checkpoint' }, previouslyArchived: first.archivedGroupIds })
  expect(second.manifest.archivedGroups.map(g => g.callIds)).toEqual([['current']])
  expect(second.manifest.actionLedger).toEqual(first.manifest.actionLedger)
  expect(second.manifest.previousCheckpoint!.read.toolCallId).toBe('checkpoint')
  expect(JSON.stringify(store.getCall('room', 'turn', 'old'))).toBe(original)
  expect(store.modelEvidence('room', 'turn').stages[0]!.event.kind).toBe('context_checkpoint')
})

test('refuse unseen, incomplete, forged protocol groups and foreign or finished archive identities', () => {
  const { store, archive } = fixture(); const a = group(store, 'a')
  const prepare = (groups: WorkingContextGroup[], id = 'a') => prepareWorkingContextCheckpoint({ input: { reason: 'review', retain: [{ toolCallId: id, reason: 'needed' }] },
    groups, archive, checkpointCallId: 'checkpoint', precedingModelId: 'model_1', ordinal: 1 })
  expect(() => prepare([a], 'future')).toThrow('unseen or foreign-turn')
  expect(() => prepare([a, a])).toThrow('duplicate protocol group')
  expect(() => prepare([{ ...a, messages: [a.messages[0]!] }])).toThrow('incomplete native protocol')
  expect(() => prepare([{ ...a, messages: [{ role: 'user', content: 'must not drop' }, a.messages[1]!] }])).toThrow('incomplete native protocol')
  expect(() => projectWorkingContextMessages([...a.messages.map(m => ({ ...m }))], [a], new Set())).toThrow('protocol group references')
  const foreign = createWorkingContextArchive(store, { roomId: 'another', turnId: 'turn', agentId: 'agent', commit: async () => {} })
  expect(() => foreign.readCall('a')).toThrow('unavailable')
  store.finishTurn('turn', 'completed')
  expect(() => prepare([a])).toThrow('no longer running')
})
