import { expect, test } from 'bun:test'
import type { ContextCheckpointManifest } from '../../../core/working-context.ts'
import type { ExecutionModelCallSummary } from '../../../core/executions/model-evidence.ts'
import { buildExecutionJourney, type ExecutionInspection } from './execution-journey.ts'
import { checkpointRequestLineage, recordedCheckpointEvent, recordedRecallEvent } from './checkpoint-inspection.ts'

const manifest: ContextCheckpointManifest = {
  checkpointId: 'context_1', turnId: 'turn', precedingModelId: 'model_1', reason: 'Completed review; unresolved duty continues.',
  retainedGroups: [{ groupId: 'current', callIds: ['current'], read: [{ turnId: 'turn', toolCallId: 'current', part: 'result' }], reasons: [{ kind: 'model', text: 'Current observations, not future conditions.' }] }],
  archivedGroups: [{ groupId: 'old', callIds: ['old'], read: [{ turnId: 'turn', toolCallId: 'old', part: 'result' }], reasons: [{ kind: 'model', text: 'Earlier acquisition; exact historical result remains available.' }] }],
  actionLedger: [], counts: { retainedGroups: 1, retainedCalls: 1, archivedGroups: 1, archivedCalls: 1 },
}
const model = (id: string, patch: Partial<ExecutionModelCallSummary> = {}): ExecutionModelCallSummary => ({
  id, ordinal: 1, phase: 'tool-response', status: 'completed', startedAt: 100,
  requestedModel: 'model', requestBytes: 20, messageCount: 2, toolCount: 1, ...patch,
})
const inspection = (): ExecutionInspection => ({
  turn: { id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 0, status: 'failed' },
  modelCapture: 'recorded', models: [model('model_1'), model('model_2', { contextCheckpointId: 'context_1', status: 'failed' }), model('unrelated', { startedAt: 200 })],
  calls: [{ id: 'old', providerCallId: 'provider-old', tool: 'read', startedAt: 10, completedAt: 20, argumentBytes: 10 }, { id: 'current', tool: 'read', startedAt: 30, argumentBytes: 10 }],
  stages: [{ id: 'checkpoint', at: 100, event: { kind: 'context_checkpoint', manifest } }],
})

test('a checkpoint adds one factual Context event without removing archive attempts or changing unknown/failed states', () => {
  const execution = inspection(), before = JSON.stringify(execution)
  const events = buildExecutionJourney(execution)
  const checkpoint = recordedCheckpointEvent(events, 'turn', 'context_1')
  expect(checkpoint).toMatchObject({ actor: 'context', state: 'recorded', title: 'Context checkpoint', description: '1 group kept · 1 group archived now' })
  expect(events.filter(event => event.source.kind === 'tool')).toHaveLength(2)
  expect(recordedRecallEvent(events, 'turn', manifest.archivedGroups[0]!.read[0]!)).toMatchObject({ id: 'tool:old', state: 'recorded' })
  expect(recordedRecallEvent(events, 'turn', manifest.retainedGroups[0]!.read[0]!)).toMatchObject({ id: 'tool:current', state: 'unknown' })
  expect(events.find(event => event.id === 'model:model_2')?.state).toBe('failed')
  expect(JSON.stringify(execution)).toBe(before)
})

test('recall uses the current turn and actual execution identity, never a provider ID or guessed record', () => {
  const events = buildExecutionJourney(inspection())
  expect(recordedRecallEvent(events, 'turn', { turnId: 'foreign', toolCallId: 'old', part: 'result' })).toBeUndefined()
  expect(recordedRecallEvent(events, 'turn', { turnId: 'turn', toolCallId: 'provider-old', part: 'result' })).toBeUndefined()
  expect(recordedRecallEvent(events, 'turn', { turnId: 'turn', toolCallId: 'missing', part: 'result' })).toBeUndefined()
  expect(recordedCheckpointEvent(events, 'foreign', 'context_1')).toBeUndefined()
  expect(recordedCheckpointEvent(events, 'turn', 'missing')).toBeUndefined()
})

test('request lineage follows only exact captured identities and never invents a later request or automatic success', () => {
  const execution = inspection(), lineage = checkpointRequestLineage(execution.models, manifest)
  expect(lineage.preceding?.id).toBe('model_1')
  expect(lineage.following.map(call => call.id)).toEqual(['model_2'])
  expect(lineage.following[0]?.status).toBe('failed')
  expect(checkpointRequestLineage(execution.models, { ...manifest, precedingModelId: 'absent', checkpointId: 'not-recorded' }))
    .toEqual({ preceding: undefined, following: [] })
})
