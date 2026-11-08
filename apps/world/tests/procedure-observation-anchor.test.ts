import { expect, test } from 'bun:test'
import type { ProcedureRunState, SimulationRunEvent, ProcedureStep } from '../src/core/model/index.ts'
import { simulationRunEventSchema } from '../src/core/model/index.ts'
import { readProcedureBranchObservation } from '../src/features/procedures/branch-assessment.ts'
import type { ProcedureObservationPort } from '../src/features/procedures/pack-observations.ts'
import { procedureTestRun } from './procedure-fixtures.ts'

const at = '2026-11-07T12:00:00.000Z'
const run = { ...procedureTestRun('observe'), status: 'active', currentStepId: 'observe' } as ProcedureRunState
const binding = { capabilityId: 'world.example.response.read', source: '../basis.md#response', input: { windowSeconds: 5 }, maxAgeSeconds: 2, afterStep: 'prepare' }
const step = { id: 'observe' } as ProcedureStep
const frame = { targetObjectId: run.scope.plantId, status: 'satisfied', simulationTime: at, simTimeMs: 1000,
  evidenceKind: 'engineering-diagnostic', provenance: 'runtime-model', readings: [{ value: 42 }] }
const base = { id: 'event:entry', simulationRunId: 'run-anchor', seq: 1, at, provenance: { source: 'operator', causedByCommandId: 'command:entry' } }
const event = (input: unknown): SimulationRunEvent => simulationRunEventSchema.parse(input) as SimulationRunEvent
const selected = (patch: Record<string, unknown> = {}) => event({ ...base,
  type: 'procedure.branch.selected', runId: run.runId, stepId: 'prepare', branchIndex: 0, outcome: 'normal', target: 'observe', targetKind: 'step', simulationTime: at,
  selectedBy: 'actor:ai:test', criterion: { branchIndex: 0, status: 'supported', simulationTime: at, readings: [], reasons: [],
    observation: { capabilityId: 'world.example.condition.read', input: {}, source: binding.source, maxAgeSeconds: 2, result: frame } }, ...patch })
const update = (command = 'command:entry') => event({ ...base, id: 'event:position', seq: 2,
  provenance: { source: 'operator', causedByCommandId: command }, type: 'procedure.step.updated', runId: run.runId,
  stepId: 'prepare', currentStepId: 'observe', update: { assessment: 'complete' }, updatedAt: at, updatedBy: 'actor:ai:test' })

const read = async (events: ReadonlyArray<SimulationRunEvent>, current = run) => {
  const queries: unknown[] = []
  const port: ProcedureObservationPort = { readObservation: async (query: unknown) => { queries.push(query); return { status: 'satisfied' } },
    validateTags: async () => new Map(), readTags: async () => new Map(), evaluateCsfs: async () => new Map(),
    readTag: async () => { throw new Error('No tag acquisition in this anchor test') } }
  return { result: await readProcedureBranchObservation(() => port, binding, { run: current, step, events }), queries }
}

test('the exact accepted entry frame reaches the native query; comments and driver changes do not replace it', async () => {
  const events = [selected(), update()]
  const comment = event({ ...base, id: 'event:comment', seq: 3, type: 'procedure.step.updated', runId: run.runId,
    stepId: 'observe', update: { comment: 'Readings retained.' }, updatedAt: at, updatedBy: 'actor:ai:test' })
  const acquired = await read([...events, comment])
  expect(acquired.result.error).toBeUndefined()
  expect(acquired.queries).toEqual([{ ...binding, input: { windowSeconds: 5, startingObservation: frame } }])
})

test('an old successful frame cannot survive manual positioning, another visit, unavailable proof or another Run', async () => {
  for (const events of [[], [selected(), update('command:manual-jump')], [selected({ runId: 'procedure-run:other' }), update()],
    [selected({ target: 'elsewhere' }), update()], [selected({ criterion: { branchIndex: 0, status: 'unknown', simulationTime: at, readings: [], reasons: [] } }), update()],
    [selected(), update(), selected({ stepId: 'other' })]]) {
    const acquired = await read(events)
    expect(acquired.result.error).toBeString()
    expect(acquired.queries).toEqual([])
  }
  expect((await read([selected(), update()], { ...run, currentStepId: 'elsewhere' })).queries).toEqual([])
  expect((await read([selected({ criterion: { branchIndex: 0, status: 'supported', simulationTime: at, readings: [], reasons: [],
    observation: { ...binding, result: { ...frame, targetObjectId: 'plant:other' } } } }), update()])).queries).toEqual([])
})

test('a supported repeat starts at its checked endpoint, retaining any delay before the next observation', async () => {
  const endpoint = { ...frame, simulationTime: '2026-11-07T12:00:05.000Z', simTimeMs: 6000 }
  const repeat = selected({ stepId: 'observe', simulationTime: endpoint.simulationTime,
    criterion: { branchIndex: 1, status: 'supported', simulationTime: endpoint.simulationTime, readings: [], reasons: [],
      observation: { ...binding, result: { ...endpoint, current: endpoint } } } })
  const acquired = await read([repeat])
  expect(acquired.result.error).toBeUndefined()
  expect(acquired.queries).toEqual([{ ...binding, input: { windowSeconds: 5, startingObservation: endpoint } }])
  const failed = selected({ ...repeat, outcome: 'rno' })
  expect((await read([failed])).queries).toEqual([])
})
