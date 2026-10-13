import { describe, expect, test } from 'bun:test'
import { newWorkspaceId, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { renderWorkingSet, traceOperations } from './working-set.ts'
import { PROPOSE_OPERATION_ID } from './operation-claims.ts'
import type { ToolTraceEntry } from '../core/types/messaging.ts'

const workspaceId = newWorkspaceId()
const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' })
const target = { kind: 'resource' as const, ref: run }
const START = 'world.procedure.run.start'
const TRANSITION = 'world.procedure.run.transition'

const entry = (operationOutcomes: ToolTraceEntry['operationOutcomes']): ToolTraceEntry => ({
  tool: 'workspace_call', argumentKeys: ['calls'], argumentBytes: 1, success: true, resultPreview: '', ...(operationOutcomes ? { operationOutcomes } : {}),
})

describe('traceOperations', () => {
  test('records what a later turn reuses: input keys, exact target, identifiers and an accepted command', () => {
    const operations = traceOperations('workspace_call', { calls: [
      { key: 'start', operationId: START, input: { procedureId: 'E-0', scope: { plantId: 'plant:halden-2', label: 'Halden Unit 2' } } },
      { key: 'read', operationId: 'world.process-plant.signals.read', input: { plantId: 'plant:halden-2', signals: [{ tagId: 'NIS-PR-AVG' }] } },
    ] }, { success: true, data: { results: [
      // World resolved the omitted target; the start names its run one level down.
      { key: 'start', operationId: START, target, success: true, data: { ok: true, commandId: 'command:s1', pinned: { runId: 'procedure-run:1' }, next: { run: { runId: 'procedure-run:1', driver: { actorId: 'actor:ai:x' } } } } },
      { key: 'read', operationId: 'world.process-plant.signals.read', target, success: true, data: { plantId: 'plant:halden-2', signals: [{ tagId: 'NIS-PR-AVG' }] } },
    ] } })
    expect(operations).toEqual([
      { key: 'start', operationId: START, success: true, inputKeys: ['procedureId', 'scope'], target,
        ids: { procedureId: 'E-0', plantId: 'plant:halden-2', runId: 'procedure-run:1' }, commandId: 'command:s1' },
      // Lists name what a call looked at; they are left out.
      { key: 'read', operationId: 'world.process-plant.signals.read', success: true, inputKeys: ['plantId', 'signals'], target, ids: { plantId: 'plant:halden-2' } },
    ])
  })

  test('keeps only the outcome of a refused operation, and nothing of other tools', () => {
    expect(traceOperations('workspace_call', { calls: [{ key: 'bad', operationId: TRANSITION, input: { runId: 'procedure-run:gone' } }] },
      { success: true, data: { results: [{ key: 'bad', operationId: TRANSITION, success: false, error: 'procedure_run_not_found' }] } }))
      .toEqual([{ key: 'bad', operationId: TRANSITION, success: false }])
    expect(traceOperations('product_search', { query: 'x' }, { success: true, data: { plantId: 'plant:1' } })).toBeUndefined()
    expect(traceOperations('workspace_call', { calls: [] }, { success: false, error: 'Workspace Host is unreachable' })).toBeUndefined()
  })

  test('an identifier is a short one-line string under a camelCase key ending in Id', () => {
    const operations = traceOperations('workspace_call', { calls: [{ key: 'k', operationId: TRANSITION, input: {
      runId: 'procedure-run:1', stepId: 'verify-reactor-trip', basis: 'Criterion: breakers open', branchIndex: 0,
      reasonId: 'has a space', noteId: 'x'.repeat(129), Id: 'bare', evidenceTagIds: ['TRIP-BKR-A'],
    } }] }, { success: true, data: { results: [{ key: 'k', operationId: TRANSITION, success: true, data: { ok: true, commandId: 'command:t1' } }] } })
    expect(operations?.[0]?.ids).toEqual({ runId: 'procedure-run:1', stepId: 'verify-reactor-trip' })
  })
})

describe('renderWorkingSet', () => {
  test('lists each operation once with its latest input, the targets, the latest ids and the proposals', () => {
    const text = renderWorkingSet([
      entry([{ key: 'p', operationId: 'world.process-plant.plants.list', success: true, inputKeys: [], target, ids: {} }]),
      entry([{ key: 'propose', operationId: PROPOSE_OPERATION_ID, success: true, inputKeys: ['plantId', 'tagId', 'value', 'reason'], target,
        ids: { plantId: 'plant:halden-2', tagId: 'RX-TRIP-MAN' }, commandId: 'command:p1' }]),
      entry([{ key: 't', operationId: TRANSITION, success: true, inputKeys: ['runId', 'stepId'], target, ids: { runId: 'procedure-run:1', stepId: 'step-1' }, commandId: 'command:t1' }]),
      entry([{ key: 't', operationId: TRANSITION, success: true, inputKeys: ['runId', 'stepId', 'branchIndex'], target, ids: { runId: 'procedure-run:1', stepId: 'step-2' }, commandId: 'command:t2' }]),
      entry([{ key: 'bad', operationId: 'world.procedure.run.close', success: false }]),
      { tool: 'product_search', argumentKeys: ['query'], argumentBytes: 1, success: true, resultPreview: '' },
    ])
    expect(text.split('\n')).toEqual([
      expect.stringContaining('the owning Module refuses an id or target that is no longer valid'),
      `- operations: world.process-plant.plants.list {}; ${PROPOSE_OPERATION_ID} {plantId, tagId, value, reason}; ${TRANSITION} {runId, stepId, branchIndex}`,
      `- target: ${JSON.stringify(target)}`,
      '- ids: plantId plant:halden-2; tagId RX-TRIP-MAN; runId procedure-run:1; stepId step-1, step-2',
      '- proposals (their status: world.process-plant.control.proposals): command:p1',
    ])
  })

  test('is empty when the turn called no workspace operation successfully', () => {
    expect(renderWorkingSet([entry([{ key: 'bad', operationId: TRANSITION, success: false }])])).toBe('')
    expect(renderWorkingSet([{ tool: 'conversation_read', argumentKeys: [], argumentBytes: 2, success: true, resultPreview: '' }])).toBe('')
  })
})
