import { expect, test } from 'bun:test'
import { procedureStepDecisionSchema, simulationRunEventSchema, type SimulationRunEvent } from '../src/core/model/index.ts'
import { projectProcedureStepDecision } from '../src/features/procedures/step-decision-view.ts'
import { retainedProcedureDecision } from '../src/features/procedures/transition-receipt.ts'
import { procedureTestRun } from './procedure-fixtures.ts'

const at = '2026-10-31T04:10:00.000Z'
const run = procedureTestRun('first')
const base = { simulationRunId: 'run-decision-projection', at, provenance: { source: 'ai', causedByCommandId: 'command:projection' } }
const started = simulationRunEventSchema.parse({ ...base, id: 'event:start', seq: 1, type: 'procedure.run.started', run }) as SimulationRunEvent
const selected = (value: number, id = 'event:chosen', seq = 2) => simulationRunEventSchema.parse({ ...base, id, seq,
  type: 'procedure.branch.selected', runId: run.runId, stepId: 'first', branchIndex: 0, label: 'Observed response', outcome: 'normal',
  targetKind: 'retry', target: 'first', basis: 'Actual retained physical feedback.', selectedBy: 'actor:ai:reader', simulationTime: at,
  evidence: [{ tagId: 'PRESSURE', reading: `${value} MPa` }],
  criterion: { branchIndex: 0, status: 'supported', simulationTime: at, readings: [], reasons: [],
    observation: { capabilityId: 'world.test.observe', input: { exact: 'authored-query' }, source: 'test-owner.md#pressure', maxAgeSeconds: 2,
      result: { retainedHistoricalFacts: { value, unit: 'MPa', quality: 'good' } } } },
}) as Extract<SimulationRunEvent, { type: 'procedure.branch.selected' }>
const decision = (event: SimulationRunEvent) => procedureStepDecisionSchema.parse(event)

test('an operational decision references its exact immutable source event without duplicating or changing its full proof', () => {
  const event = selected(7.4), events = [started, event], canonical = decision(event), before = structuredClone(events)
  const view = projectProcedureStepDecision({ run, stepId: 'first', decision: canonical, events })
  expect(view).toMatchObject({ branchIndex: 0, basis: canonical.basis, criterionStatus: 'supported', simulationTime: at,
    proof: { kind: 'event', capabilityId: 'world.procedure.decision.read', input: { runId: run.runId, sourceRevision: run.sourceRevision,
      eventId: event.id, sequence: event.seq, commandId: base.provenance.causedByCommandId } } })
  expect(view).not.toHaveProperty('criterion'); expect(view).not.toHaveProperty('evidence')
  expect(JSON.stringify(view)).not.toContain('retainedHistoricalFacts')
  expect(view.proof.kind).toBe('event')
  if (view.proof.kind !== 'event') throw new Error('Expected exact event selector')
  expect(retainedProcedureDecision(events, view.proof.input)?.event).toEqual(event)
  expect(events).toEqual(before); expect(canonical.criterion?.observation?.result).toEqual({ retainedHistoricalFacts: { value: 7.4, unit: 'MPa', quality: 'good' } })
})

test('a copied snapshot explicitly offers current retained state rather than inventing an immutable event', () => {
  const canonical = decision(selected(7.4)), before = structuredClone(canonical)
  const view = projectProcedureStepDecision({ run, stepId: 'first', decision: canonical, events: [] })
  expect(view.proof).toMatchObject({ kind: 'run-state', capabilityId: 'world.procedure.runs.list', input: { includeEvidence: true }, runId: run.runId, stepId: 'first' })
  expect(view.proof.kind === 'run-state' && view.proof.reason).toContain('later selection can replace it')
  expect(view).toMatchObject({ selectedBy: canonical.selectedBy, basis: canonical.basis, simulationTime: canonical.simulationTime })
  expect(canonical).toEqual(before)
})

test('same paused timestamp, actor and branch cannot substitute a different recorded physical proof', () => {
  const earlier = selected(7.4), later = selected(7.5, 'event:later', 3)
  const result = projectProcedureStepDecision({ run, stepId: 'first', decision: decision(earlier), events: [started, earlier, later] })
  expect(result.proof.kind).toBe('run-state')
  const current = projectProcedureStepDecision({ run, stepId: 'first', decision: decision(later), events: [started, earlier, later] })
  expect(current.proof).toMatchObject({ kind: 'event', input: { eventId: later.id, sequence: 3 } })
})

test('a missing source start or differently pinned source never receives a false exact selector', () => {
  const event = selected(7.4), canonical = decision(event)
  expect(projectProcedureStepDecision({ run, stepId: 'first', decision: canonical, events: [event] }).proof.kind).toBe('run-state')
  expect(projectProcedureStepDecision({ run: { ...run, sourceRevision: 'b'.repeat(40) }, stepId: 'first', decision: canonical, events: [started, event] }).proof.kind).toBe('run-state')
})
