import { expect, test } from 'bun:test'
import { progressActivityEvents, recordedOperations, recordedOperationView } from './progress-activity.ts'
import { buildExecutionJourney, type ExecutionInspection } from './execution-journey.ts'

const execution: ExecutionInspection = {
  turn: { id: 'turn', roomId: 'room', agentId: 'ai', startedAt: 1, status: 'completed' },
  modelCapture: 'recorded', stages: [],
  calls: ['discover', 'first', 'read', 'second', 'later'].map((id, index) => ({ id, tool: 'workspace_call', startedAt: index + 2, completedAt: index + 3, argumentBytes: 10 })),
  models: [{ id: 'round', ordinal: 3, phase: 'tool-response', status: 'completed', startedAt: 3, requestedModel: 'model', messageCount: 4, toolCount: 1, requestBytes: 20, requestedTools: [{ tool: 'workspace_call', executionCallId: 'read' }] }],
}
test('progress activity follows exact runtime membership, excluding unrelated and later work', () => {
  const events = progressActivityEvents(execution, buildExecutionJourney(execution), { content: 'step', evidence: { turnId: 'turn', callIds: ['read', 'second'], callId: 'second' } })!
  expect(events.map(event => event.id)).toEqual(['model:round', 'tool:read', 'tool:second'])
  expect(progressActivityEvents(execution, buildExecutionJourney(execution), { content: 'first', evidence: { turnId: 'turn', callIds: ['discover', 'first'], callId: 'first' } })!.map(event => event.id)).toEqual(['tool:discover', 'tool:first'])
})
test('same batch updates retain their own attempt; missing, duplicate and cross-turn identities fail closed', () => {
  const events = buildExecutionJourney(execution)
  expect(progressActivityEvents(execution, events, { content: 'same', evidence: { turnId: 'turn', callIds: ['second'], callId: 'second' } })!.map(event => event.id)).toEqual(['tool:second'])
  for (const evidence of [
    { turnId: 'other', callId: 'second', callIds: ['second'] }, { turnId: 'turn', callId: 'absent', callIds: ['absent'] },
    { turnId: 'turn', callId: 'second', callIds: ['second', 'absent'] }, { turnId: 'turn', callId: 'first', callIds: ['second'] },
    { turnId: 'turn', callId: 'second', callIds: ['second', 'second'] },
  ]) expect(progressActivityEvents(execution, events, { content: 'step', evidence })).toBeUndefined()
})
test('same-time parallel calls and nonchronological storage cannot change membership', () => {
  const parallel = { ...execution, calls: [...execution.calls].reverse().map(call => ({ ...call, startedAt: 2 })) }
  const selected = progressActivityEvents(parallel, buildExecutionJourney(parallel), { content: 'step', evidence: { turnId: 'turn', callId: 'second', callIds: ['read', 'second'] } })!
  expect(new Set(selected.filter(event => event.source.kind === 'tool').map(event => event.id))).toEqual(new Set(['tool:read', 'tool:second']))
})
test('operation evidence matches both exact key and operation; refusals and unknown results stay explicit', () => {
  const call = { ...execution.calls[0]!, arguments: { calls: [
    { key: 'step', operationId: 'world.procedure.run.transition', input: { branchIndex: 0 } },
    { key: 'read', operationId: 'world.procedure.step.read', input: {} },
    { key: 'unknown', operationId: 'read', input: {} },
  ] }, result: { success: true, data: { results: [
    { key: 'read', operationId: 'world.procedure.step.read', success: false, error: 'refused' },
    { key: 'step', operationId: 'world.procedure.run.transition', success: true, data: { commandId: 'cmd', decision: { status: 'supported', eventId: 'event:exact' } } },
    { key: 'unknown', operationId: 'wrong', success: true },
  ] } } }
  expect(recordedOperations(call).map(operation => operation.result?.success)).toEqual([true, false, undefined])
  expect(recordedOperations(call)[0]!.result?.data).toEqual({ commandId: 'cmd', decision: { status: 'supported', eventId: 'event:exact' } })
  expect(recordedOperations({ ...call, tool: 'workspace_explore' })).toEqual([])
})
test('only a successful validated same-Workspace publication can render inside activity inspection', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111'
  const embeddedView = { moduleId: 'world', subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run' }, viewType: 'procedure.decision', title: 'Recorded decision', height: 480, state: '{"eventId":"event:exact"}' }
  const operation = { key: 'step', operationId: 'world.procedure.run.transition', input: {}, result: { success: true, embeddedView } }
  expect(recordedOperationView(operation, workspaceId)).toEqual(embeddedView)
  expect(recordedOperationView(operation, '22222222-2222-4222-8222-222222222222')).toBeUndefined()
  expect(recordedOperationView({ ...operation, result: { ...operation.result, success: false } }, workspaceId)).toBeUndefined()
  expect(recordedOperationView({ ...operation, result: { success: true, embeddedView: { ...embeddedView, moduleId: 'agents' } } }, workspaceId)).toBeUndefined()
})
