import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionStore, type ExecutionStore } from './executions/store.ts'
import { contextCheckpointReceiptForModel, createWorkingContextArchive, prepareWorkingContextCheckpoint, projectWorkingContextMessages, type ContextCheckpointManifest, type WorkingContextGroup, type WorkingMessage } from './working-context.ts'

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

test('delayed archival preserves original invocation order and exact ledger recall without dropping absent prior identities', () => {
  const { store, archive } = fixture()
  // IDs deliberately sort opposite to invocation order; fixture timestamps are
  // equal. The original protocol groups are the ordering authority.
  const earlier = group(store, 'z-earlier', 'change'), later = group(store, 'a-later', 'change'), current = group(store, 'current')
  const first = prepareWorkingContextCheckpoint({ input: { reason: 'keep earlier evidence active', retain: [{ toolCallId: 'z-earlier', reason: 'still needed' }] },
    groups: [earlier, later, current], archive, checkpointCallId: 'checkpoint1', precedingModelId: 'model_1', ordinal: 1 })
  expect(first.manifest.actionLedger.map(entry => entry.toolCallId)).toEqual(['a-later'])
  const previous = { manifest: first.manifest, callId: 'checkpoint1' }
  const second = prepareWorkingContextCheckpoint({ input: { reason: 'earlier evidence is now archived', retain: [{ toolCallId: 'current', reason: 'current record' }] },
    groups: [earlier, later, current], archive, checkpointCallId: 'checkpoint2', precedingModelId: 'model_2', ordinal: 2,
    previous, previouslyArchived: first.archivedGroupIds })
  expect(second.manifest.actionLedger.map(entry => entry.toolCallId)).toEqual(['z-earlier', 'a-later'])
  expect(second.manifest.actionLedger[1]).toEqual(first.manifest.actionLedger[0])
  expect(second.manifest.actionLedger[0]).toEqual({ toolCallId: 'z-earlier', tool: earlier.calls[0]!.call.tool,
    effects: [...earlier.calls[0]!.result.effects!], arguments: { turnId: 'turn', toolCallId: 'z-earlier', part: 'arguments' },
    read: { turnId: 'turn', toolCallId: 'z-earlier', part: 'result' } })
  const receipt = contextCheckpointReceiptForModel(second.manifest)
  const reconstructed = receipt.returnedChangeGroups.flatMap(descriptor => descriptor.calls.map(call => ({ index: call.index, entry: {
    toolCallId: call.toolCallId, tool: descriptor.tool, effects: descriptor.effects,
    arguments: { turnId: receipt.turnId, toolCallId: call.toolCallId, part: 'arguments' },
    read: { turnId: receipt.turnId, toolCallId: call.toolCallId, part: 'result' },
  } }))).sort((a, b) => a.index - b.index).map(call => call.entry)
  expect(reconstructed).toEqual(second.manifest.actionLedger)
  expect(() => prepareWorkingContextCheckpoint({ input: { reason: 'invalid missing original group', retain: [{ toolCallId: 'current', reason: 'current record' }] },
    groups: [earlier, current], archive, checkpointCallId: 'checkpoint3', precedingModelId: 'model_3', ordinal: 3, previous,
  })).toThrow('accumulated invocation a-later is absent from the original turn groups')
})

test('model receipt factors only exact cumulative ledger descriptors and reconstructs every invocation in original order', () => {
  const { store, archive } = fixture(); const a = group(store, 'a')
  const base = prepareWorkingContextCheckpoint({ input: { reason: 'literal semantic boundary', retain: [{ toolCallId: 'a', reason: 'literal model reason' }] },
    groups: [a], archive, checkpointCallId: 'checkpoint', precedingModelId: 'model_2', ordinal: 2 }).manifest
  const effects = [{ kind: 'change' as const, outcome: 'returned' as const, operationId: 'operation', target: { unit: '2', nested: { exact: 1.23456789012345 } } },
    { kind: 'read' as const, outcome: 'returned' as const }]
  const entry = (toolCallId: string, actualEffects: ContextCheckpointManifest['actionLedger'][number]['effects'] = effects, tool = 'workspace_call') => ({ toolCallId, tool, effects: actualEffects,
    arguments: { turnId: base.turnId, toolCallId, part: 'arguments' as const }, read: { turnId: base.turnId, toolCallId, part: 'result' as const } })
  const manifest: ContextCheckpointManifest = { ...base,
    previousCheckpoint: { checkpointId: 'context_1', read: { turnId: base.turnId, toolCallId: 'prior', part: 'result' } },
    actionLedger: [entry('first'), entry('other', [{ ...effects[0]!, target: { unit: '3' } }]), entry('repeat'),
      entry('reordered', [...effects].reverse()), entry('different-tool', effects, 'another_tool')],
  }
  const before = JSON.stringify(manifest), projected = contextCheckpointReceiptForModel(manifest)
  expect(projected.returnedChangeGroups).toHaveLength(4)
  expect(projected.returnedChangeGroups[0]!.calls).toEqual([{ index: 0, toolCallId: 'first' }, { index: 2, toolCallId: 'repeat' }])
  const expanded = projected.returnedChangeGroups.flatMap(descriptor => descriptor.calls.map(call => ({ index: call.index, entry: {
    toolCallId: call.toolCallId, tool: descriptor.tool, effects: descriptor.effects,
    arguments: { turnId: projected.turnId, toolCallId: call.toolCallId, part: 'arguments' },
    read: { turnId: projected.turnId, toolCallId: call.toolCallId, part: 'result' },
  } }))).sort((a, b) => a.index - b.index).map(call => call.entry)
  const { kind: _kind, returnedChangeGroups: _groups, ...unchanged } = projected
  expect({ ...unchanged, actionLedger: expanded }).toEqual(manifest)
  expect(JSON.stringify(manifest)).toBe(before)
  expect(contextCheckpointReceiptForModel({ ...base, actionLedger: [] }).returnedChangeGroups).toEqual([])
  expect(() => contextCheckpointReceiptForModel({ ...manifest, actionLedger: [{ ...manifest.actionLedger[0]!, read: { turnId: 'foreign', toolCallId: 'first', part: 'result' } }] })).toThrow('recall selectors')
})
