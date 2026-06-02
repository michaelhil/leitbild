import { describe, expect, test } from 'bun:test'
import type { ActorId, IsoTimestamp, ProcedureDocument, ProcedureRunState } from '../src/core/model/index.ts'
import {
  furthestTouchedStep,
  procedureRunSummariesForScope,
  procedureRunSummaryText,
  procedureStepDisplayName,
} from '../src/ui/procedures/procedure-run-selectors.ts'

const at = '2026-01-01T00:00:00.000Z' as IsoTimestamp
const actor = 'actor:test' as ActorId
const source = {
  sourceId: 'pwr-ops',
  label: 'PWR operations procedures',
  repository: 'samsinn-wikis/pwr-ops',
  ref: 'main',
  path: 'wiki/procedures',
  commitSha: 'test-revision',
  fetchedAt: at,
  sourceUrl: 'https://github.com/samsinn-wikis/pwr-ops/tree/main/wiki/procedures',
}
const unitScope = {
  systemId: 'halden-unit-a',
  label: 'Halden Unit A',
} as const

const procedure = {
  source,
  procedureId: 'E-0',
  title: 'Reactor Trip or Safety Injection',
  csfsMonitored: [],
  entryTriggers: [],
  description: '',
  sourcePath: 'wiki/procedures/E-0.md',
  sourceUrl: 'https://github.com/samsinn-wikis/pwr-ops/blob/main/wiki/procedures/E-0.md',
  rawMarkdown: '',
  tags: [],
  steps: [
    {
      id: 'verify-reactor-trip',
      label: '1',
      title: 'Step 1',
      level: 2,
      blocks: [],
      branches: [],
      tagIds: [],
      sourceLine: 10,
    },
    {
      id: 'verify-phase-a-isolation',
      label: '6',
      title: 'Step 6',
      level: 2,
      blocks: [],
      branches: [],
      tagIds: [],
      sourceLine: 60,
    },
  ],
} satisfies ProcedureDocument

const activeRun = {
  runId: 'procedure-run:test-a',
  sourceId: 'pwr-ops',
  sourceRevision: 'test-revision',
  procedureId: 'E-0',
  scope: unitScope,
  title: 'Reactor Trip or Safety Injection',
  status: 'active',
  startedAt: at,
  startedBy: actor,
  stepStates: [{
    stepId: 'verify-phase-a-isolation',
    assessment: 'unknown',
    favorite: false,
    updatedAt: at,
    updatedBy: actor,
  }],
} satisfies ProcedureRunState

describe('procedure run selectors', () => {
  test('uses procmd step id when a heading only has a fallback step title', () => {
    expect(procedureStepDisplayName(procedure.steps[1]!)).toBe('verify-phase-a-isolation')
  })

  test('summarizes the furthest touched step by document order', () => {
    expect(furthestTouchedStep(activeRun, procedure)).toEqual({
      label: '6',
      name: 'verify-phase-a-isolation',
    })
  })

  test('separates active and completed runs by unit scope', () => {
    const otherUnitRun = {
      ...activeRun,
      runId: 'procedure-run:test-b',
      scope: {
        systemId: 'halden-unit-b',
        label: 'Halden Unit B',
      },
    } satisfies ProcedureRunState
    const summaries = procedureRunSummariesForScope(
      [activeRun, otherUnitRun],
      unitScope,
      new Map([['E-0', procedure]]),
    )
    expect(summaries.active.map(procedureRunSummaryText)).toEqual(['E-0:6'])
    expect(summaries.completed).toEqual([])
  })
})
