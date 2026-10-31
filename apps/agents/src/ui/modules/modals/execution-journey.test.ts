import { describe, expect, test } from 'bun:test'
import { buildExecutionJourney, continuationMetadata, recordedExecutionCosts, type ExecutionInspection, type GenerationQueryInspection } from './execution-journey.ts'
import type { ExecutionModelCallSummary } from '../../../core/executions/model-evidence.ts'

const inspection: GenerationQueryInspection = {
  messageId: 'message', traceId: 'turn', generation: { modelCalls: 99 },
  query: { model: 'final', messages: [
    { role: 'assistant', content: '', toolCalls: [{ id: 'requested-only', function: { name: 'trip', arguments: { unit: 3 } } }] },
    { role: 'tool', content: '{"accepted":true}', toolCallId: 'requested-only' },
  ] },
}
const execution = (patch: Partial<ExecutionInspection> = {}): ExecutionInspection => ({
  turn: { id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 100, status: 'completed', finishedAt: 300 },
  modelCapture: 'recorded', models: [], calls: [], stages: [], ...patch,
})

const model = (id: string, patch: Partial<ExecutionModelCallSummary>): ExecutionModelCallSummary => ({
  id, ordinal: 1, phase: 'initial', status: 'completed', startedAt: 100, requestedModel: 'model',
  requestBytes: 100, messageCount: 1, toolCount: 1, ...patch,
})

test('reported costs include actual failed-call charges while unreported attempts remain unknown', () => {
  const models = [
    model('completed', { metrics: { costUsd: 0.1, generationId: 'generation-completed', upstreamProvider: 'OpenAI' } }),
    model('failed-with-charge', { status: 'failed', metrics: { costUsd: 0.2 } }),
    model('failed-without-charge', { status: 'failed', metrics: { promptTokens: 100 } }),
    model('running', { status: 'running' }),
  ]
  const before = JSON.stringify(models)
  const result = recordedExecutionCosts(models)
  expect(result).toMatchObject({ attempts: 4, costReportedCalls: 2, unknownCalls: 2 })
  expect(result.reportedCostUsd).toBeCloseTo(0.3, 14)
  expect(JSON.stringify(models)).toBe(before)
})

test('a reported zero is known and no recorded charges never becomes a zero-cost turn', () => {
  expect(recordedExecutionCosts([model('known-zero', { metrics: { costUsd: 0 } }), model('missing', {})]))
    .toEqual({ attempts: 2, costReportedCalls: 1, unknownCalls: 1, reportedCostUsd: 0 })
  expect(recordedExecutionCosts([model('missing', {})])).toEqual({ attempts: 1, costReportedCalls: 0, unknownCalls: 1 })
  expect(recordedExecutionCosts([])).toEqual({ attempts: 0, costReportedCalls: 0, unknownCalls: 0 })
})

describe('execution Journey evidence projection', () => {
  test('orders actual stages, repeated model calls and tool attempts using durable IDs', () => {
    const events = buildExecutionJourney(execution({
      models: [
        { id: 'model_2', ordinal: 2, phase: 'tool-response', status: 'completed', startedAt: 250, completedAt: 275, requestedModel: 'model', messageCount: 4, toolCount: 1, requestBytes: 100, requestedTools: [{ providerCallId: 'same', tool: 'read' }] },
        { id: 'model_1', ordinal: 1, phase: 'initial', status: 'completed', startedAt: 110, completedAt: 130, requestedModel: 'model', messageCount: 2, toolCount: 1, requestBytes: 100, requestedTools: [{ providerCallId: 'same', executionCallId: 'call_1', tool: 'read' }] },
      ],
      calls: [{ id: 'call_1', tool: 'read', providerCallId: 'same', startedAt: 140, completedAt: 160, argumentBytes: 20, resultBytes: 10 }],
      stages: [{ id: 'ready', at: 105, event: { kind: 'context_ready', model: 'model', messageCount: 2, toolCount: 1 } }, { id: 'correction', at: 240, event: { kind: 'correction', causes: ['view-fence'], issues: ['Invalid section'] } }],
    }), inspection)
    expect(events.map(event => event.id)).toEqual(['stage:ready', 'model:model_1', 'tool:call_1', 'stage:correction', 'model:model_2'])
    expect(events.filter(event => event.source.kind === 'tool')).toHaveLength(1)
    expect(events[2]!.description).toBe('Result recorded')
    expect(events[3]!.state).toBe('warning')
  })
  test('does not reconstruct missing model iterations or actual tool calls from final request evidence', () => {
    const events = buildExecutionJourney(execution({ modelCapture: 'unavailable', calls: [{ id: 'call_1', tool: 'trip', startedAt: 150, argumentBytes: 20 }] }), inspection)
    expect(events.map(event => event.id)).toEqual(['tool:call_1', 'snapshot:final'])
    expect(events[0]!.state).toBe('unknown')
    expect(events[0]!.description).toBe('Outcome unknown')
    expect(events.filter(event => event.source.kind === 'model')).toHaveLength(0)
    expect(events.filter(event => event.source.kind === 'tool')).toHaveLength(1)
    expect(events[1]!.at).toBeUndefined()
  })
  test('interrupted turn does not turn an unresolved model attempt into failure or success', () => {
    const events = buildExecutionJourney(execution({
      turn: { id: 'turn', roomId: 'room', agentId: 'agent', startedAt: 100, status: 'interrupted', finishedAt: 300 },
      models: [{ id: 'model_1', ordinal: 1, phase: 'initial', status: 'running', startedAt: 110, requestedModel: 'model', messageCount: 2, toolCount: 1, requestBytes: 100 }],
    }))
    expect(events[0]!.state).toBe('unknown')
  })
  test('preserves explicit failed and cancelled calls, nested snapshots and all comparison evidence', () => {
    const events = buildExecutionJourney(execution({ models: [{ id: 'model_1', ordinal: 1, phase: 'initial', status: 'cancelled', startedAt: 110, completedAt: 115, requestedModel: 'model', messageCount: 2, toolCount: 1, requestBytes: 100 }] }), { ...inspection, nestedQueries: [inspection.query], executionCalls: [{ tool: 'read', result: { success: false } }], startingInput: { task: 'Inspect unit 2' } })
    expect(events.map(event => event.source.kind)).toEqual(['model', 'starting', 'snapshot', 'comparison'])
    expect(events[0]!.state).toBe('cancelled')
    expect(events.slice(1).every(event => event.at === undefined)).toBe(true)
  })
  test('ordinary protocol metadata is available without returning secret content or mutating evidence', () => {
    const messages = [{ role: 'assistant', content: 'Visible', continuation: { provider: 'openrouter' as const, model: 'model', endpointHash: 'a'.repeat(64), reasoningDetails: [{ type: 'reasoning.encrypted', data: 'SECRET' }] } }]
    const before = JSON.stringify(messages)
    const metadata = continuationMetadata(messages)
    expect(metadata[0]!.detailTypes).toEqual(['reasoning.encrypted'])
    expect(JSON.stringify(metadata)).not.toContain('SECRET')
    expect(JSON.stringify(messages)).toBe(before)
  })
})

test('ordinary raw Starting input and comparison inspection withholds nested protocol at every depth', async () => {
  const { readableEvidence } = await import('./execution-journey.ts')
  const record = { domain: { continuation: { nextSection: 'B' } }, startingInput: { context: { messages: [{ role: 'assistant', content: 'visible', continuation: { provider: 'openrouter', model: 'model', endpointHash: 'hash', reasoning: 'SECRET' } }] } }, query: { messages: [{ role: 'assistant', continuation: { provider: 'openrouter', model: 'model', endpointHash: 'hash', reasoningDetails: [{ data: 'ENCRYPTED' }] } }] } }
  const before = JSON.stringify(record)
  const readable = readableEvidence(record)
  expect(readable.protocolPaths).toHaveLength(2)
  expect(JSON.stringify(readable.value)).not.toContain('SECRET')
  expect(JSON.stringify(readable.value)).not.toContain('ENCRYPTED')
  expect(JSON.stringify(readable.value)).toContain('visible')
  expect((readable.value as typeof record).domain.continuation).toEqual({ nextSection: 'B' })
  expect(JSON.stringify(record)).toBe(before)
})

test('uses recorded comparison timestamps without inventing times for nested request snapshots', () => {
  const events = buildExecutionJourney(undefined, { ...inspection, startingInput: { capturedAt: 100, context: {} }, executionCalls: [{ id: 'call', tool: 'read', startedAt: 120, completedAt: 130, result: { success: true } }], nestedQueries: [inspection.query] })
  expect(events.map(event => [event.id, event.at])).toEqual([['starting', 100], ['comparison:0', 120], ['snapshot:final', undefined], ['snapshot:nested:0', undefined]])
  expect(events[1]!.title).toBe('read')
  expect(events[1]!.state).toBe('recorded')
})
