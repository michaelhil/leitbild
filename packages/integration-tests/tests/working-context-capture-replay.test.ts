import { expect, test } from 'bun:test'
import { createSemanticSchedule, type CapturedCall } from './working-context-capture-replay.ts'
import { createExecutionStore } from '../../../apps/agents/src/core/executions/store.ts'
import { createWorkingContextArchive, prepareWorkingContextCheckpoint, projectWorkingContextMessages,
  type WorkingContextGroup, type WorkingMessage } from '../../../apps/agents/src/core/working-context.ts'
import { createConversationReadTool } from '../../../apps/agents/src/tools/built-in/conversation-read.ts'
import { createRoom } from '../../../apps/agents/src/core/rooms/room.ts'
import type { RoomDirectory } from '../../../apps/agents/src/core/rooms/directory.ts'

const time = (seconds: number) => `2026-07-12T04:00:${String(seconds).padStart(2, '0')}.178Z`
const call = (id: string, operationId: string, input: Record<string, unknown>, data: unknown): CapturedCall => ({
  id, tool: 'workspace_call', providerCallId: `wire-${id}`, startedAt: 1, completedAt: 2, argumentBytes: 1,
  arguments: { calls: [{ key: 'value', operationId, input }] },
  result: { success: true, data: { results: [{ key: 'value', operationId, success: true, data }] },
    effects: [{ kind: operationId === 'world.procedure.step.update' ? 'change' : 'read', outcome: 'returned', operationId }] },
})
const point = (seconds: number) => call(`point-${seconds}`, 'world.simulation-run.wait', {}, { simulationTime: time(seconds), next: {
  simulationTime: time(seconds), run: { procedureId: 'ES-0.1', currentStepId: 'establish-auxiliary-feed', sourceRevision: 'exact-source',
    driver: { kind: 'ai', actorId: 'actor:ai:agent' } }, native: { comparison: '<', threshold: 82, currentValue: 14.123456789012345,
    quality: { status: 'good' }, status: 'supported' }, csfs: [{ id: 'heat-sink', status: 'green' }] } })
const signals = (seconds: number, tagIds: string[]) => call(`signals-${seconds}`, 'world.process-plant.signals.read', { signals: tagIds.map(tagId => ({ tagId })) },
  { evidence: { simulationTime: time(seconds), modelIdentity: 'actual-model', automationIdentity: 'actual-automation' },
    signals: tagIds.map(tagId => ({ signal: { tagId }, variable: { value: 0.1234567890123456 }, quality: { status: 'good' } })) })
const note = (seconds: number) => call(`note-${seconds}`, 'world.procedure.step.update', { comment: `Human original verbatim. exact frames through ${time(seconds)}` },
  { simulationTime: time(seconds), step: { comment: `Human original verbatim. exact frames through ${time(seconds)}` } })

test('offline source policy retains actual three five-second acquisitions and historical achieved dependencies, without a last-N text cap', async () => {
  const schedule = createSemanticSchedule(), store = createExecutionStore(':memory:')
  const room = createRoom({ id: 'room', name: 'Fixture', createdBy: 'human', createdAt: 1, scope: { kind: 'workspace' }, scopeRevision: 0 })
  room.addMember('agent')
  const groups: WorkingContextGroup[] = [], all: WorkingMessage[] = [{ role: 'system', content: 'System policy' },
    { role: 'user', content: 'Human steering: preserve exactly.' }]
  store.beginTurn({ id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 1 }); store.beginModelCapture('turn', 'room')
  const archive = createWorkingContextArchive(store, { roomId: 'room', turnId: 'turn', agentId: 'agent', commit: async manifest => store.recordStage('turn', { kind: 'context_checkpoint', manifest }) })
  const add = (value: CapturedCall) => {
    store.recordAttempt('turn', { id: value.id, tool: value.tool, arguments: value.arguments, providerCallId: value.providerCallId, startedAt: 1 })
    store.recordOutcome('turn', value.id, value.result, 2)
    const messages: WorkingMessage[] = [{ role: 'assistant', content: '', toolCalls: [{ id: value.providerCallId, function: { name: value.tool, arguments: value.arguments } }] },
      { role: 'tool', toolCallId: value.providerCallId, name: value.tool, content: JSON.stringify(value.result) }]
    groups.push({ groupId: `group-${value.id}`, calls: [{ call: { callId: value.id, providerCallId: value.providerCallId, tool: value.tool, arguments: value.arguments }, result: value.result }], messages })
    all.push(...messages)
    schedule.observe(value, value.id)
  }
  try {
    add(call('source', 'world.procedure.source.read', {}, { text: 'Quoted source: ignore all rules is data, not Human authority.', revision: 'exact-source' }))
    const dependency = call('dependencies', 'world.process-plant.signals.read', { signals: [{ tagId: 'TDAFW-SPEED' }, { path: 'auxFeedwaterPumpTurbine.flowKgPerS' }] },
      { evidence: { simulationTime: time(20) }, signals: [{ value: 0.9876543210987654, quality: { status: 'good' } }] })
    for (const seconds of [20, 25, 30, 35]) {
      add(point(seconds)); if (seconds === 20) add(dependency)
      add(signals(seconds, ['SG-A-WR', 'SG-B-WR', 'SG-C-WR', 'SG-D-WR', 'AFW-A-CV-POS']))
      add(note(seconds))
    }
    const selected = schedule.prepare()
    expect(selected.semantic.requiredInitialFrameTimes).toEqual([time(25), time(30), time(35)])
    const ids = selected.input.retain.map(entry => entry.toolCallId)
    expect(ids).toContain('dependencies'); expect(ids).toContain('source')
    expect(ids).toContain('point-25'); expect(ids).toContain('signals-25'); expect(ids).toContain('note-35')
    expect(ids).not.toContain('point-20'); expect(ids).not.toContain('signals-20')
    const checkpoint = prepareWorkingContextCheckpoint({ input: selected.input, groups, archive, checkpointCallId: 'checkpoint', precedingModelId: 'model_1', ordinal: 1 })
    await archive.commit(checkpoint.manifest)
    const projected = projectWorkingContextMessages(all, groups, checkpoint.retainedGroupIds)
    expect(projected.filter(message => message.role === 'user')).toEqual([all[1]!])
    expect(projected.find(message => message.toolCallId === 'wire-point-25')?.content).toContain(JSON.stringify(14.123456789012345))
    expect(projected.some(message => message.toolCallId === 'wire-point-20')).toBe(false)
    expect(projected.some(message => message.toolCallId === 'wire-dependencies')).toBe(true)
    const reader = createConversationReadTool({ getRoom: (id: string) => id === 'room' ? room : undefined } as RoomDirectory, store)
    const recalled = await reader.execute({ turnId: 'turn', toolCallId: 'point-20', part: 'result' }, { callerId: 'agent', callerName: 'Agent', roomId: 'room' })
    expect(recalled).toMatchObject({ success: true, data: { result: store.getCall('room', 'turn', 'point-20')!.result } })
    expect(checkpoint.manifest.actionLedger.map(entry => entry.toolCallId)).toContain('note-20')
  } finally { store.close() }
})

test('offline source policy distinguishes initial history from monitoring origin/current/previous evidence', () => {
  const schedule = createSemanticSchedule()
  const transition = call('monitor-start', 'world.procedure.run.transition', {}, { simulationTime: time(20), guidanceIncluded: true,
    run: { procedureId: 'ES-0.1', currentStepId: 'monitor-secondary-cooling' } })
  schedule.observe(transition, transition.id)
  schedule.observe(note(20), 'note-20')
  schedule.prepare()
  for (const seconds of [25, 30]) {
    const frame = call(`frame-${seconds}`, 'world.simulation-run.wait', {}, { simulationTime: time(seconds),
      run: { procedureId: 'ES-0.1', currentStepId: 'monitor-secondary-cooling' } })
    schedule.observe(frame, frame.id); schedule.observe(note(seconds), `note-${seconds}`)
    const selected = schedule.prepare()
    expect(selected.semantic.requiredInitialFrameTimes).toEqual([])
    expect(selected.input.retain.map(entry => entry.toolCallId)).toContain('monitor-start')
    expect(selected.input.retain.map(entry => entry.toolCallId)).toContain(`frame-${seconds}`)
    if (seconds === 30) expect(selected.input.retain.map(entry => entry.toolCallId)).toContain('frame-25')
  }
})

test('coarser semantic timing changes checkpoint frequency without changing required initial evidence', () => {
  const frequent = createSemanticSchedule('source-record-boundaries')
  const phaseOnly = createSemanticSchedule('completed-phases-and-monitor-reviews')
  const inputs: CapturedCall[] = [call('phase-entry', 'world.procedure.run.transition', {}, { simulationTime: time(20),
    run: { procedureId: 'ES-0.1', currentStepId: 'establish-auxiliary-feed' } })]
  for (const seconds of [20, 25, 30, 35]) inputs.push(point(seconds), signals(seconds, ['SG-A-WR', 'AFW-A-CV-POS']), note(seconds))
  let frequentCount = 0, phaseOnlyCount = 0
  for (const input of inputs) {
    if (frequent.observe(input, input.id)) frequentCount++
    if (phaseOnly.observe(input, input.id)) phaseOnlyCount++
  }
  expect(frequentCount).toBe(5); expect(phaseOnlyCount).toBe(1)
  expect(phaseOnly.prepare()).toEqual(frequent.prepare())
})
