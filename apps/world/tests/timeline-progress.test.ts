import { expect, test } from 'bun:test'
import { projectTimelineProgress } from '../src/core/model/timeline-progress.ts'
import { scenarioTimelineProgressStateSchema } from '../src/core/model/scenario.ts'
import { dueScenarioTimelineCues } from '../src/core/simulation-runs/timeline-runner.ts'

test('journal interrupted after dispatch preserves uncertainty and never readmits the cue', () => {
  const admission = projectTimelineProgress(undefined, { type: 'scenario.cue.started', cueId: 'once', actionCount: 3, at: '2026-01-01T00:00:00Z' })
  const dispatched = projectTimelineProgress(admission, { type: 'scenario.cue.action', cueId: 'once', actionIndex: 0, outcome: 'unknown' })
  const retained = scenarioTimelineProgressStateSchema.parse(JSON.parse(JSON.stringify(dispatched)))
  expect(retained.executions?.[0]).toEqual({ cueId: 'once', status: 'admitted', actions: ['unknown', 'not_attempted', 'not_attempted'] })
  expect(() => projectTimelineProgress(retained, { type: 'scenario.cue.finished', cueId: 'once', outcome: 'complete' })).toThrow('every action accepted')
  expect(dueScenarioTimelineCues({ timeline: { cues: [{ id: 'once', at: { kind: 'after_scenario_start', seconds: 0 }, actions: [] }] }, state: { scenarioId: 'example', agentRestrictions: { revision: 0, objects: [], operationIds: [] }, highlightedObjectIds: [], timeline: retained }, nowMs: Date.parse('2026-01-01T01:00:00Z') })).toEqual([])
  // Current timeline-only retained artifacts retain their original shape; no invented success ledger.
  expect(scenarioTimelineProgressStateSchema.parse({ startedAt: '2026-01-01T00:00:00Z', firedCueIds: ['old'] }).executions).toBeUndefined()
})
