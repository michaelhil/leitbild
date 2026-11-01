import { expect, test } from 'bun:test'
import { reviewQualificationExecution, type QualificationTurnEvidence } from './agent-model-qualification-review.ts'
import type { ExecutionModelCallSummary } from '../apps/agents/src/core/executions/model-evidence.ts'
import type { ExecutionCall } from '../apps/agents/src/core/executions/store.ts'
import type { ContextCheckpointManifest } from '../apps/agents/src/core/working-context.ts'

const expectedModel = 'deepseek/deepseek-v4.1-flash-1017'
const model = (overrides: Partial<ExecutionModelCallSummary> = {}): ExecutionModelCallSummary => ({
  id: 'model_1', ordinal: 1, phase: 'initial', startedAt: 1, completedAt: 2, status: 'completed', requestedModel: expectedModel,
  model: expectedModel, provider: 'openrouter', requestBytes: 100, messageCount: 2, toolCount: 1, metrics: { costUsd: 0.0005, upstreamProvider: 'DeepSeek' }, ...overrides,
})
const call = (overrides: Partial<ExecutionCall> = {}): ExecutionCall => ({
  id: 'call_0_0', tool: 'workspace_call', startedAt: 2, completedAt: 3, argumentBytes: 2, arguments: {},
  result: { success: true, data: { value: 7.123456789, unit: 'MPa' }, effects: [{ kind: 'read', outcome: 'returned' }] }, ...overrides,
})
const turn = (overrides: Partial<QualificationTurnEvidence> = {}): QualificationTurnEvidence => ({
  id: 'turn', status: 'completed', models: [model()], calls: [call()], stages: [], ...overrides,
})
const review = (...turns: QualificationTurnEvidence[]) => reviewQualificationExecution({ expectedModel, turns })

test('reported exact charge, including zero, is independent of answer tokens and public list prices', () => {
  const result = review(turn({ models: [model(), model({ id: 'model_2', ordinal: 2, metrics: { costUsd: 0, promptTokens: 1_000_000 } })] }))
  expect(result.structurallyComplete).toBe(true)
  expect(result.billing).toEqual({ knownCostUsd: 0.0005, knownCalls: 2, unknownCalls: 0, uniqueModelEvidence: true, complete: true, costUsd: 0.0005 })
  expect(result.readOnlyEstablished).toBe(true)
  expect(result.upstreamProviders).toEqual(['DeepSeek'])
})

test('absent billing for completed, failed and cancelled calls is unknown rather than zero', () => {
  const result = review(turn({ models: [model(), model({ id: 'model_2', ordinal: 2, metrics: {} }),
    model({ id: 'model_3', ordinal: 3, status: 'failed', metrics: {} }), model({ id: 'model_4', ordinal: 4, status: 'cancelled', metrics: {} })] }))
  expect(result.structurallyComplete).toBe(false)
  expect(result.billing).toEqual({ knownCostUsd: 0.0005, knownCalls: 1, unknownCalls: 3, uniqueModelEvidence: true, complete: false, costUsd: null })
})

test('partial charges on failed calls still count as known, while invalid prices never do', () => {
  const result = review(turn({ models: [model({ status: 'failed', metrics: { costUsd: 0.07 } }),
    model({ id: 'model_2', ordinal: 2, metrics: { costUsd: Number.NaN } }), model({ id: 'model_3', ordinal: 3, metrics: { costUsd: -1 } })] }))
  expect(result.billing.knownCostUsd).toBe(0.07)
  expect(result.billing.unknownCalls).toBe(2)
  expect(result.warnings).toHaveLength(2)
})

test('empty, interrupted and duplicate capture identities never establish complete execution', () => {
  expect(review().structurallyComplete).toBe(false)
  expect(review().billing.costUsd).toBeNull()
  expect(review(turn({ status: 'interrupted' })).structurallyComplete).toBe(false)
  const duplicate = review(turn({ models: [model(), model()], calls: [call(), call()] }), turn())
  expect(duplicate.errors).toEqual(['Duplicate model turn/model_1', 'Duplicate tool turn/call_0_0', 'Duplicate turn turn'])
  expect(duplicate.structurallyComplete).toBe(false)
  expect(duplicate.billing.costUsd).toBeNull()
})

test('requested transport prefix is consumed but effective model aliases never qualify', () => {
  const wrong = review(turn({ models: [model({ requestedModel: 'openai/gpt-6-sol' })] }))
  expect(wrong.structurallyComplete).toBe(false)
  expect(wrong.errors[0]).toContain('Unexpected requested model')
  const routed = review(turn({ models: [model({ requestedModel: `openrouter:${expectedModel}` })] }))
  expect(routed.structurallyComplete).toBe(true)
  expect(routed.reportedModels).toEqual([expectedModel])
  expect(review(turn({ models: [model({ model: 'provider-reported-alias' })] })).structurallyComplete).toBe(false)
})

test('actual model and OpenRouter route must be established without fallback', () => {
  for (const candidate of [model({ model: undefined }), model({ provider: undefined }), model({ provider: 'openai' }),
    model({ metrics: { model: 'other/model' } }), model({ metrics: { provider: 'other-adapter' } })]) {
    expect(review(turn({ models: [candidate] })).structurallyComplete).toBe(false)
  }
  const metricsOnly = model({ model: undefined, provider: undefined, metrics: { model: expectedModel, provider: 'openrouter', costUsd: 0 } })
  expect(review(turn({ models: [metricsOnly] })).structurallyComplete).toBe(true)
  const fallback = review(turn({ stages: [{ at: 1, event: { kind: 'model_fallback', preferred: 'old', effective: expectedModel, reason: 'test' } }] }))
  expect(fallback.structurallyComplete).toBe(false)
  expect(fallback.errors).toContain('Model fallback occurred in turn')
})

test('read-only proof rejects uncertain dispatch/effects and even a refused write attempt', () => {
  for (const effect of [undefined, [{ kind: 'unknown', outcome: 'unknown' }], [{ kind: 'change', outcome: 'returned' }],
    [{ kind: 'change', outcome: 'not-dispatched' }]] as const) {
    const result = review(turn({ calls: [call({ result: { success: false, error: 'refused', ...(effect ? { effects: effect } : {}) } })] }))
    expect(result.readOnlyEstablished).toBe(false)
  }
  const missing = review(turn({ calls: [call({ completedAt: undefined, result: undefined })] }))
  expect(missing.structurallyComplete).toBe(false)
  expect(missing.incompleteCalls).toEqual([{ turnId: 'turn', toolCallId: 'call_0_0' }])
  const returnedWrite = review(turn({ calls: [call({ result: { success: false, effects: [{ kind: 'change', outcome: 'returned', operationId: 'world.plant.write' }] } })] }))
  expect(returnedWrite.changes).toHaveLength(1) // A refused receipt is not proof of no effect.
})

test('successful workspace batches still report nested failures and missing or duplicate keyed outcomes', () => {
  const batch = call({ arguments: { calls: [
    { key: 'good', operationId: 'read.good' }, { key: 'bad', operationId: 'read.bad' },
    { key: 'missing', operationId: 'read.missing' }, { key: 'duplicate', operationId: 'read.duplicate' },
  ] }, result: { success: true, effects: [{ kind: 'read', outcome: 'returned' }], data: { results: [
    { key: 'good', success: true }, { key: 'bad', success: false, error: 'Unknown tag' },
    { key: 'duplicate', success: true }, { key: 'duplicate', success: false },
  ] } } })
  const result = review(turn({ calls: [batch] }))
  expect(result.failures).toHaveLength(0)
  expect(result.operationFailures).toEqual([{ turnId: 'turn', toolCallId: 'call_0_0', key: 'bad', operationId: 'read.bad', status: 'failed', error: 'Unknown tag' }])
  expect(result.unknownOperationOutcomes.map(outcome => [outcome.key, outcome.reason])).toEqual([
    ['missing', 'No exact operation outcome captured'], ['duplicate', 'Ambiguous duplicate operation results'],
  ])
  const noOuterOutcome = review(turn({ calls: [{ ...batch, result: undefined }] }))
  expect(noOuterOutcome.unknownOperationOutcomes).toHaveLength(4)
})

const checkpoint = (): ContextCheckpointManifest => ({
  checkpointId: 'context_1', turnId: 'turn', precedingModelId: 'model_2', reason: 'completed review', retainedGroups: [],
  archivedGroups: [{ groupId: 'group', callIds: ['call_0_0'], read: [{ turnId: 'turn', toolCallId: 'call_0_0', part: 'result' }], reasons: [{ kind: 'model', text: 'historical reading' }] }],
  actionLedger: [], counts: { retainedGroups: 0, archivedGroups: 1, retainedCalls: 0, archivedCalls: 1 },
})
const checkpointTurn = (): QualificationTurnEvidence => {
  const source = call(), manifest = checkpoint()
  return turn({ models: [model(), model({ id: 'model_2', ordinal: 2 }), model({ id: 'model_3', ordinal: 3, contextCheckpointId: 'context_1' })],
    stages: [{ at: 5, event: { kind: 'context_checkpoint', manifest } }],
    calls: [source, call({ id: 'call_2_0', tool: 'conversation_read', startedAt: 7,
      arguments: { turnId: 'turn', toolCallId: source.id, part: 'result' },
      result: { success: true, data: { evidenceKind: 'execution', turnId: 'turn', toolCallId: source.id, result: structuredClone(source.result) }, effects: [{ kind: 'read', outcome: 'returned' }] } })] })
}

test('checkpoint admission, application and exact archived recall are three separately established facts', () => {
  const result = review(checkpointTurn())
  expect(result.structurallyComplete).toBe(true)
  expect(result.checkpoints).toEqual([{ turnId: 'turn', checkpointId: 'context_1', archivedCalls: 1, applied: true }])
  expect(result.archivedRecalls).toEqual([{ turnId: 'turn', toolCallId: 'call_2_0', sourceTurnId: 'turn', sourceToolCallId: 'call_0_0', exact: true }])
  expect(review(turn({ calls: [call({ tool: 'context_checkpoint' })] })).checkpoints).toEqual([])
  const unApplied = checkpointTurn()
  expect(review({ ...unApplied, models: unApplied.models.slice(0, 2) }).checkpoints[0]!.applied).toBe(false)
})

test('checkpoint references cannot cross turns or claim absent predecessors', () => {
  const t = checkpointTurn(), manifest = checkpoint()
  const result = review({ ...t, stages: [{ at: 5, event: { kind: 'context_checkpoint', manifest: { ...manifest, turnId: 'foreign', precedingModelId: 'absent' } } }] })
  expect(result.structurallyComplete).toBe(false)
  expect(result.errors).toEqual(['Foreign checkpoint turn/context_1', 'Checkpoint predecessor not captured turn/context_1'])
  expect(result.checkpoints[0]!.applied).toBe(false)
  expect(review({ ...t, stages: [{ at: 5, event: { kind: 'context_checkpoint', manifest: {} } }] }).errors).toEqual(['Malformed checkpoint in turn'])
})

test('changed, omitted or foreign archival recall data is rejected', () => {
  const t = checkpointTurn(), recall = t.calls[1]!
  for (const data of [{ evidenceKind: 'execution', turnId: 'turn', toolCallId: 'call_0_0', result: { success: true, data: { value: 7.12 } } },
    { evidenceKind: 'execution', turnId: 'foreign', toolCallId: 'call_0_0', result: t.calls[0]!.result }]) {
    const result = review({ ...t, calls: [t.calls[0]!, { ...recall, result: { success: true, data } }] })
    expect(result.structurallyComplete).toBe(false)
    expect(result.archivedRecalls[0]!.exact).toBe(false)
  }
  const beforeCheckpoint = review({ ...t, calls: [t.calls[0]!, { ...recall, startedAt: 4 }] })
  expect(beforeCheckpoint.archivedRecalls).toHaveLength(0)
})
