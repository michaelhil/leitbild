import { expect, test } from 'bun:test'
import { actorIdSchema, isoTimestampSchema, type CommandEnvelope, type EventId, type ProcedureStep, type SimulationRunEvent, type SimulationRunId } from '../src/core/model/index.ts'
import { canInspectProcedureBranchCheck, readProcedureChecks } from '../src/features/procedures/checks-view.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { composeProcedureStepView, projectProcedureStepGuidance } from '../src/features/procedures/step-view.ts'
import { prepareProcedureCommand, type ProcedureCommitContext } from '../src/features/procedures/run-state.ts'
import type { ProcedureObservationPort, ProcedureTagValue } from '../src/features/procedures/pack-observations.ts'
import { procedureTestRun, procedureTestSource } from './procedure-fixtures.ts'

const time = isoTimestampSchema.parse('2026-11-08T08:00:10.000Z')
const old = isoTimestampSchema.parse('2026-11-08T08:00:05.000Z')
const plantId = 'plant:test'
const ai = actorIdSchema.parse('actor:ai:limits')
const person = actorIdSchema.parse('actor:limits')
const markdown = (front: string) => `---
type: procedure
procedure-md: 0.7
procedure-id: TEST
title: Line limits
${front}
---

# Line limits

### Foldout: applies from Step 2

- Keep «LEVEL» in band.

## Step 1 [id: trip] Verify trip

Basis: [Why](basis.md#trip).
Pair: [id: shutdown, criterion: 0]
Check: Breakers A and B — OPEN. «BKR-A == false» «BKR-B == false»
Check: Power range — BELOW 5%. «POWER < 5»
RNO: Trip the reactor.

- Tripped [outcome: normal] → #feed
- Not tripped [outcome: rno] → ↻

## Step 2 [id: feed] Check feed

Basis: [Why](basis.md#feed).
Pair: [id: a, criterion: 0]
Check: Level — 40% TO 70%. «LEVEL > 40» «LEVEL < 70»
RNO: Adjust feed.

Pair: [id: b, criterion: 0]
Check: Flow AT LEAST 27.8 kg/s, OR power ABOVE 90%. «any» «FLOW >= 27.8» «POWER > 90»
RNO: Start a pump.

Pair: [id: c, criterion: 0]
When: Power — BELOW 2%. «POWER < 2»

- Go on [outcome: normal] → #fork

## Step 3 [id: fork] Is SI actuated

Basis: [Why](basis.md#fork).
Pair: [id: question]
Check: Is SI actuated, or is pressure below 12.7 MPa? «SI» «PRESSURE»
RNO: Actuate SI.

- Actuated «SI == true» [outcome: normal] → #judge
- Not required «SI == false» «PRESSURE >= 12.7» [outcome: normal] → END

## Step 4 [id: judge] Check for a fault

Pair: [id: fault]
Check: Is any SG uncontrolled? «PRESSURE»

- None [outcome: normal] → END

## Tags

- id: BKR-A
  description: breaker A
  units: boolean
  states: CLOSED/OPEN
- id: BKR-B
  description: breaker B
  units: boolean
  states: CLOSED/OPEN
- id: POWER
  description: power range
  units: percent
- id: LEVEL
  description: level
  units: percent
- id: FLOW
  description: flow
  units: kg/s
- id: SI
  description: SI actuated
  units: boolean
  states: ACTUATED/NOT ACTUATED
- id: PRESSURE
  description: pressure
  units: MPa
`
const document = (front = 'ai-workable: true') => parseProcedureMarkdown({ source: procedureTestSource, sourcePath: 'procedures/TEST.md', sourceUrl: '/wiki?path=procedures%2FTEST.md', rawMarkdown: markdown(front) })
const healthy: Readonly<Record<string, number | boolean>> = { 'BKR-A': false, 'BKR-B': false, POWER: 1, LEVEL: 50, FLOW: 40, SI: false, PRESSURE: 14 }
const value = (tagId: string, reading: number | boolean, unit: string | undefined, over: Partial<ProcedureTagValue>): ProcedureTagValue => ({ tagId, label: tagId, value: reading, formatted: String(reading), ...(unit === undefined ? {} : { unit }),
  quality: 'good', writable: false, scopeId: plantId, signalTagId: tagId, evidence: { kind: 'engineering-diagnostic', sampledAt: time, provenance: 'runtime-model' }, ...over })
const port = (readings: Readonly<Record<string, number | boolean | Error>> = {}, over: Readonly<Record<string, Partial<ProcedureTagValue>>> = {}): ProcedureObservationPort => ({
  validateTags: async tags => new Map(tags.map(tag => [tag.id, { id: tag.id, status: 'resolved' as const, warnings: [] }])),
  readTags: async tags => new Map(tags.map(tag => {
    const reading = tag.id in readings ? readings[tag.id]! : healthy[tag.id]!
    return [tag.id, reading instanceof Error ? reading : value(tag.id, reading, tag.units, over[tag.id] ?? {})]
  })),
  readTag: async () => { throw new Error('unused') },
  readObservation: async () => { throw new Error('unused') },
  evaluateCsfs: async () => new Map(),
})
const runAt = (stepId: string, by = ai) => ({ ...procedureTestRun(stepId), procedureId: 'TEST', sourcePath: 'procedures/TEST.md', driver: { kind: by === ai ? 'ai' as const : 'person' as const, actorId: by, since: time } })
const stepOf = (id: string, front?: string): ProcedureStep => document(front).steps.find(step => step.id === id)!
const checks = async (stepId: string, observations: ProcedureObservationPort, front?: string) => {
  const run = runAt(stepId)
  return await readProcedureChecks({
    input: { runId: run.runId, stepId, sourceId: run.sourceId, sourceRevision: run.sourceRevision, sourcePath: run.sourcePath },
    snapshot: () => ({ procedures: { runs: [run] }, clock: { currentTime: time, paused: true, updatedAt: time, speed: 1 }, seq: 1 } as never),
    canInspect: () => true, document: async () => document(front), observations: () => observations,
  })
}
const commit = async (stepId: string, branchIndex: number, observations: ProcedureObservationPort, by = ai, front?: string): Promise<ReadonlyArray<SimulationRunEvent>> => {
  const run = runAt(stepId, by)
  const procedures = { runs: [run] }
  const command: CommandEnvelope = { id: 'command:limits' as CommandEnvelope['id'], simulationRunId: 'run:limits' as SimulationRunId, actorId: by, issuedAt: time,
    kind: 'world.procedure.run.transition', targetObjectIds: [], payload: { runId: run.runId, stepId, branchIndex, basis: 'Stated basis.' } }
  const actorKind = by === ai ? 'ai' as const : 'person' as const
  const prepared = await prepareProcedureCommand({ command, procedures, readDocument: async () => document(front), observations: () => observations, actorKind })
  let seq = 1
  const context: ProcedureCommitContext = { simulationRunId: 'run:limits' as SimulationRunId, at: time, simulationTime: time, actorKind, procedures, objectIds: new Set([plantId]),
    factory: { eventId: () => `event:${seq}` as EventId, nextSeq: () => seq++ }, observations: () => observations }
  return await prepared!(context)
}
const selected = (events: ReadonlyArray<SimulationRunEvent>) => events.find((event): event is Extract<SimulationRunEvent, { type: 'procedure.branch.selected' }> => event.type === 'procedure.branch.selected')!

test('limits and the foldout survive the World schema; block text and step tags stay as renderers read them', () => {
  const parsed = document()
  const line = parsed.steps[0]!.blocks.find(block => block.kind === 'check')!
  expect(line.text).toBe('Breakers A and B — OPEN. «BKR-A» «BKR-B»')
  expect(line.limits).toMatchObject({ any: false, comparisons: [{ tagId: 'BKR-A', operator: '==', value: false, unit: 'boolean', source: 'basis.md#trip' }, { tagId: 'BKR-B' }] })
  expect(parsed.steps[2]!.branches[0]!.limits!.comparisons[0]).toMatchObject({ tagId: 'SI', value: true })
  expect(parsed.foldout).toMatchObject({ title: 'Foldout: applies from Step 2', text: '- Keep «LEVEL» in band.', tagIds: ['LEVEL'] })
  expect(parsed.annotations?.['ai-workable']).toBe('true')
  expect(parsed.diagnostics).toEqual([])
})

test('the checks read reports each limit, and every way a reading can fail is grey, never green', async () => {
  const statuses = async (observations: ProcedureObservationPort) => { const view = await checks('trip', observations); return [view.checks[0]!.status, view.checks[0]!.readings.map(row => row.status).join()] }
  expect(await statuses(port())).toEqual(['supported', 'supported,supported,supported'])
  expect(await statuses(port({ 'BKR-A': true }))).toEqual(['contradicted', 'contradicted,supported,supported'])
  for (const failure of [
    port({ POWER: new Error('no reading') }),
    port({}, { POWER: { quality: 'bad' } }),
    port({}, { POWER: { evidence: { kind: 'engineering-diagnostic', sampledAt: old, provenance: 'runtime-model' } } }),
    port({}, { POWER: { writable: true } }),
    port({}, { POWER: { unit: 'fraction' } }),
    port({ POWER: Number.NaN }),
  ]) expect(await statuses(failure)).toEqual(['unknown', 'supported,supported,unknown'])
  // Another unit's value is not shown at all, so its line has no reading to match.
  expect(await statuses(port({}, { POWER: { scopeId: 'plant:other' } }))).toEqual(['unknown', 'supported,supported'])
})

test('a band, an any line and two pairs test one branch; each row keeps its operator and expected value', async () => {
  const view = await checks('feed', port())
  expect(view.checks).toHaveLength(1)
  expect(view.checks[0]!.status).toBe('supported')
  expect(view.checks[0]!.readings.map(row => [row.tagId, row.operator, row.expected, row.status])).toEqual([
    ['LEVEL', '>', 40, 'supported'], ['LEVEL', '<', 70, 'supported'], ['FLOW', '>=', 27.8, 'supported'], ['POWER', '>', 90, 'contradicted'], ['POWER', '<', 2, 'supported'],
  ])
  expect((await checks('feed', port({ LEVEL: 90 }))).checks[0]!.status).toBe('contradicted')
  expect((await checks('feed', port({ FLOW: 1 }))).checks[0]!.status).toBe('contradicted')
  expect((await checks('feed', port({ FLOW: 1, POWER: 95 }))).checks[0]!.status).toBe('contradicted')
  expect((await checks('feed', port({ POWER: 5 }))).checks[0]!.status).toBe('contradicted')
})

test('a fork carries no check and no inspection; its readings come back with no verdict', async () => {
  const view = await checks('fork', port({ SI: true }))
  expect(view.checks).toEqual([])
  expect(view.indications).toEqual([
    { tagId: 'SI', binding: 'resolved', label: 'SI', formatted: 'true', value: true, unit: 'boolean', quality: 'good', sampledAt: time },
    { tagId: 'PRESSURE', binding: 'resolved', label: 'PRESSURE', formatted: '14', value: 14, unit: 'MPa', quality: 'good', sampledAt: time },
  ])
  const step = stepOf('fork')
  expect(step.branches.map((_branch, index) => canInspectProcedureBranchCheck(step, index))).toEqual([false, false])
  const missing = await checks('fork', port({ SI: new Error('no reading') }))
  expect(missing.indications![0]).toEqual({ tagId: 'SI', binding: 'resolved', unavailable: 'no reading' })
  expect((await checks('judge', port())).indications!.map(row => row.tagId)).toEqual(['PRESSURE'])
})

test('a document not marked ai-workable gets no indications', async () => {
  expect((await checks('trip', port(), 'category: x')).indications).toBeUndefined()
})

test('the commit tests compiled limits with today\'s refusal, for an AI only', async () => {
  expect(selected(await commit('trip', 0, port())).criterion?.status).toBe('supported')
  await expect(commit('trip', 0, port({ 'BKR-A': true }))).rejects.toThrow('is contradicted')
  await expect(commit('trip', 0, port({ POWER: new Error('no reading') }))).rejects.toThrow('Signal POWER is unavailable')
  await expect(commit('feed', 0, port({ POWER: 5 }))).rejects.toThrow('is contradicted')
  expect(selected(await commit('fork', 0, port({ SI: true }))).criterion?.status).toBe('supported')
  await expect(commit('fork', 0, port())).rejects.toThrow('is contradicted')
  expect(selected(await commit('fork', 1, port())).target).toBe('END')
  expect(selected(await commit('trip', 0, port({ 'BKR-A': true }), person)).criterion?.status).toBe('contradicted')
})

test('a person pressing a normal branch against a contradicted criterion leaves a failed mark, not a completed one', async () => {
  const assessed = (events: ReadonlyArray<SimulationRunEvent>) => events.flatMap(event => event.type === 'procedure.step.updated' ? [event.update.assessment] : [])
  expect(assessed(await commit('trip', 0, port({ 'BKR-A': true }), person))).toEqual(['failed'])
  expect(assessed(await commit('trip', 0, port(), person))).toEqual(['complete'])
  expect(assessed(await commit('trip', 0, port({ POWER: new Error('no reading') }), person))).toEqual(['complete'])
  expect(assessed(await commit('trip', 1, port({ 'BKR-A': true }), person))).toEqual(['failed'])
})

test('the AI step view carries the foldout as guidance', async () => {
  const run = runAt('fork')
  const view = await composeProcedureStepView({ run, document: document(), ports: { sequence: () => 1, clock: () => ({ currentTime: time, paused: true }), events: () => [], observations: () => port() } })
  expect(view.step!.foldout).toEqual({ title: 'Foldout: applies from Step 2', text: '- Keep «LEVEL» in band.' })
  expect(view.step!.branches.map(branch => branch.label)).toEqual(['Actuated', 'Not required'])
  expect(view.step!.branchAssessments.map(item => item.status)).toEqual(['contradicted', 'supported'])
  expect(projectProcedureStepGuidance(view, false).step).not.toHaveProperty('foldout')
})
