import { expect, test } from 'bun:test'
import { actorIdSchema, isoTimestampSchema, procedureControlStateSchema } from '../src/core/model/index.ts'
import { procedureRunsListInputSchema, procedureRunsListResultSchema, projectProcedureRuns } from '../src/features/procedures/run-list.ts'
import { procedureTestRun } from './procedure-fixtures.ts'

const at = isoTimestampSchema.parse('2026-10-29T08:00:00.000Z')
const actor = actorIdSchema.parse('actor:ai:list-test')
const state = procedureControlStateSchema.parse({ runs: [{ ...procedureTestRun('second'),
  driver: { kind: 'ai', actorId: actor, since: at },
  inputRequest: { requestId: 'command:request-input', stepId: 'second', issue: 'An actual field judgment is required.', requestedAt: at, requestedBy: actor },
  stepStates: [{ stepId: 'first', assessment: 'complete', comment: 'Operator-visible note.', favorite: true, updatedAt: at, updatedBy: actor,
    decision: { branchIndex: 0, label: 'Verified', outcome: 'normal', targetKind: 'step', target: 'second', selectedBy: actor, selectedByLabel: 'Test assistant', simulationTime: at,
      basis: 'Actual current comparison supported.', evidence: [{ tagId: 'PT-455', reading: 'historical-cited-reading-canary' }],
      criterion: { branchIndex: 0, status: 'supported', simulationTime: at, readings: [{ source: 'basis.md#pressure', tagId: 'PT-455', value: 10, unit: 'MPa', status: 'supported' }], reasons: ['historical-criterion-proof-canary'] },
    } }],
  observations: [{ stepId: 'first', simulationTime: at, result: { status: 'satisfied', evidence: [{ retained: 'historical-observation-proof-canary' }] } }],
}] })

test('the default Run list preserves placekeeping, authority, source pins and decision actors without duplicating historical proof', () => {
  const before = structuredClone(state)
  const input = procedureRunsListInputSchema.parse({})
  const result = projectProcedureRuns(state, input.includeEvidence)
  expect(result.evidenceIncluded).toBe(false)
  expect(result.runs[0]).toMatchObject({ runId: state.runs[0]!.runId, sourceId: state.runs[0]!.sourceId,
    sourceRevision: state.runs[0]!.sourceRevision, sourcePath: state.runs[0]!.sourcePath,
    status: 'active', currentStepId: 'second', driver: { actorId: actor }, inputRequest: { stepId: 'second' },
    stepStates: [{ assessment: 'complete', comment: 'Operator-visible note.', favorite: true, decision: { branchIndex: 0, target: 'second', selectedBy: actor, selectedByLabel: 'Test assistant', simulationTime: at } }],
  })
  expect(result.runs[0]!.observations).toEqual([{ stepId: 'first', simulationTime: at, result: { status: 'satisfied' } }])
  expect(result.runs[0]!.stepStates[0]!.decision!.criterion).toBeUndefined()
  expect(result.runs[0]!.stepStates[0]!.decision!.evidence).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain('historical-')
  expect(state).toEqual(before)
})

test('explicit evidence selection returns complete retained facts without limits or alteration', () => {
  const result = projectProcedureRuns(state, procedureRunsListInputSchema.parse({ includeEvidence: true }).includeEvidence)
  expect(result.evidenceIncluded).toBe(true)
  expect(result.runs).toEqual(state.runs)
  expect(JSON.stringify(result)).toContain('historical-criterion-proof-canary')
  expect(JSON.stringify(result)).toContain('historical-cited-reading-canary')
  expect(JSON.stringify(result)).toContain('historical-observation-proof-canary')
  expect(procedureRunsListResultSchema.parse(result)).toEqual(result)
  expect(procedureRunsListInputSchema.safeParse({ includeEvidence: 'true' }).success).toBe(false)
  expect(procedureRunsListInputSchema.safeParse({ limit: 10 }).success).toBe(false)
})


test('compact lists preserve a latest challenged or unknown continuous watch and its actual reason/time', () => {
  for (const status of ['challenged', 'unknown'] as const) {
    const watched = procedureControlStateSchema.parse({ runs: [{ ...state.runs[0], observations: [{ stepId: 'first', simulationTime: at,
      result: { status, reason: 'Current acquisition or condition needs attention.', evidence: [{ retained: 'historical-large-raw-proof' }] } }] }] })
    expect(projectProcedureRuns(watched, false).runs[0]!.observations).toEqual([{ stepId: 'first', simulationTime: at,
      result: { status, reason: 'Current acquisition or condition needs attention.' } }])
    expect(projectProcedureRuns(watched, true).runs).toEqual(watched.runs)
  }
})
