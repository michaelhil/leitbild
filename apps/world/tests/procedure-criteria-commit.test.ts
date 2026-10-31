import { expect, test } from 'bun:test'
import type { ProcedureAssessmentCondition } from '@leitbild/procmd'
import { isoTimestampSchema, actorIdSchema, type CommandEnvelope, type EventId, type SimulationRunId } from '../src/core/model/index.ts'
import { assessProcedureBranches } from '../src/features/procedures/branch-assessment.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { prepareProcedureCommand, type ProcedureCommitContext } from '../src/features/procedures/run-state.ts'
import { parseProcedureTagValue, type ProcedureObservationPort, type ProcedureTagRead } from '../src/features/procedures/pack-observations.ts'
import { deferred, procedureTestRun, procedureTestSource } from './procedure-fixtures.ts'

const time = isoTimestampSchema.parse('2026-10-29T08:00:00.000Z')
const actorId = actorIdSchema.parse('actor:ai:criteria')
const plantId = 'plant:test'
const condition = { type: 'comparison', tagId: 'PT-455', operator: '<', value: 12.7, unit: 'MPa', bound: 'value', evidence: 'engineering-diagnostic', source: '../basis.md#pressure', maxAgeSeconds: 0 } as const
const document = (criterion: ProcedureAssessmentCondition = condition) => parseProcedureMarkdown({
  source: procedureTestSource, sourcePath: 'procedures/TEST.md', sourceUrl: '/wiki?path=procedures%2FTEST.md',
  rawMarkdown: `---\ntype: procedure\nprocedure-md: 0.7\nprocedure-id: TEST\ntitle: Criterion commit\n---\n## Step 1 [id: verify]\nCheck: Verify pressure «PT-455»\n- Required → END\n\`\`\`procedure-decisions\n${JSON.stringify([{ branchIndex: 0, condition: criterion }])}\n\`\`\`\n## Tags\n- id: PT-455\n  units: MPa`,
})
const observation = (value: number): ProcedureTagRead => ({ tagId: 'PT-455', binding: 'resolved', warnings: [], value: {
  tagId: 'PT-455', label: 'Pressure', value, formatted: `${value} MPa`, unit: 'MPa', scopeId: plantId, signalTagId: 'PT-455', writable: false, quality: 'good',
  evidence: { kind: 'engineering-diagnostic', sampledAt: time, provenance: 'runtime-model' },
} })
const run = () => ({ ...procedureTestRun('verify'), procedureId: 'TEST', sourcePath: 'procedures/TEST.md', driver: { kind: 'ai' as const, actorId, since: time } })
const command = (): CommandEnvelope => ({ id: 'command:guard' as CommandEnvelope['id'], simulationRunId: 'run:guard' as SimulationRunId, actorId, issuedAt: time,
  kind: 'world.procedure.run.transition', targetObjectIds: [], payload: { runId: run().runId, stepId: 'verify', branchIndex: 0, basis: 'Current pressure is below the explicit threshold.', evidenceTagIds: ['PT-455'] } })
const context = (port: ProcedureObservationPort): ProcedureCommitContext => ({ simulationRunId: 'run:guard' as SimulationRunId, at: time, simulationTime: time, actorKind: 'ai',
  procedures: { runs: [run()] }, objectIds: new Set([plantId]), factory: { eventId: () => 'event:guard' as EventId, nextSeq: () => 1 }, observations: () => port })

test('changed physical state during pinned-source preparation is re-read at commit; the stale assertion cannot advance the run', async () => {
  const entered = deferred<void>(), release = deferred<void>()
  let current = observation(10)
  let acquisitions = 0
  const port: ProcedureObservationPort = {
    validateTags: async () => new Map([['PT-455', { id: 'PT-455', status: 'resolved', warnings: [] }]]),
    readTags: async () => { acquisitions++; return new Map([['PT-455', current.value!]]) }, readTag: async () => current.value!,
    readObservation: async () => { throw new Error('No query in this test') }, evaluateCsfs: async () => new Map(),
  }
  const pending = prepareProcedureCommand({ command: command(), procedures: { runs: [run()] }, actorKind: 'ai',
    readDocument: async () => { entered.resolve(); await release.promise; return document() }, observations: () => port })
  await entered.promise
  current = observation(15)
  release.resolve()
  const commit = (await pending)!
  expect(acquisitions).toBe(0)
  await expect(commit(context(port))).rejects.toMatchObject({ code: 'procedure_branch_not_supported', details: {
    runId: run().runId, stepId: 'verify', sourceRevision: procedureTestSource.revision,
    assessment: { status: 'contradicted', readings: [{ tagId: 'PT-455', value: 15, unit: 'MPa', sampledAt: time }] },
  } })
  expect(acquisitions).toBe(1)
  current = observation(10)
  const events = await commit(context(port))
  expect(events.find(event => event.type === 'procedure.branch.selected')).toMatchObject({ criterion: { status: 'supported', readings: [{ value: 10 }] } })
})

test('NaN and infinity are unavailable evidence even under negation and disjunction', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const invalid = observation(value)
    for (const criterion of [{ type: 'not', condition }, { type: 'any', conditions: [condition, { ...condition, operator: '>', value: 100 }] }] as const) {
      const assessment = assessProcedureBranches({ step: document(criterion).steps[0]!, reads: [invalid], plantId, simulationTime: time })[0]!
      expect(assessment.status).toBe('unknown')
      expect(assessment.readings.every(read => read.value === undefined)).toBe(true)
      expect(assessment.reasons.join(' ')).toContain('not a finite observation')
      expect(() => JSON.stringify(assessment)).not.toThrow()
    }
  }
})

test('human placekeeping records unknown manual qualification, while AI must hold', async () => {
  const manual = { type: 'manual', description: 'Reference Phase B isolation is not established', tagIds: [], source: '../basis.md#phase-b' } as const
  const commit = (await prepareProcedureCommand({ command: command(), procedures: { runs: [run()] }, readDocument: async () => document(manual) }))!
  const unbound: ProcedureObservationPort = { validateTags: async () => new Map(), readTags: async () => new Map(), readTag: async () => { throw new Error('Absent') }, readObservation: async () => { throw new Error('Absent') }, evaluateCsfs: async () => new Map() }
  await expect(commit(context(unbound))).rejects.toMatchObject({ code: 'procedure_branch_not_supported', details: { assessment: { status: 'unknown' } } })
  const events = await commit({ ...context(unbound), actorKind: 'person' })
  expect(events.find(event => event.type === 'procedure.branch.selected')).toMatchObject({ criterion: { status: 'unknown', readings: [{ description: manual.description }] } })
})


test('declared query proof must establish current scope, age, engineering provenance and both authored identities', () => {
  const applicability = { description: 'Exact test model and I&C', source: '../basis.md#scope', model: { ref: 'model:test', digest: 'a'.repeat(64) }, automation: { ref: 'automation:test', digest: 'b'.repeat(64) } }
  const observation = { capabilityId: 'world.example.condition.read', input: {}, source: '../basis.md#query', maxAgeSeconds: 2 }
  const step = { ...document().steps[0]!, decisions: [{ branchIndex: 0, observation, applicability }] }
  const healthy = { targetObjectId: plantId, status: 'satisfied', simulationTime: time, evidenceKind: 'engineering-diagnostic', provenance: 'runtime-model', modelRef: 'model:test', modelDigest: 'a'.repeat(64), automationRef: 'automation:test', automationDigest: 'b'.repeat(64), evidence: [{ source: observation.source, value: true }] }
  const assess = (result: Record<string, unknown>) => assessProcedureBranches({ step, reads: [], plantId, simulationTime: time, observations: new Map([[0, { result }]]) })[0]!
  expect(assess(healthy).status).toBe('supported')
  expect(assess(healthy).observation?.result).toEqual(healthy)
  for (const result of [
    { ...healthy, targetObjectId: 'plant:other' }, { ...healthy, simulationTime: '2026-10-29T07:59:57.000Z' },
    { ...healthy, simulationTime: '2026-10-29T08:00:01.000Z' }, { ...healthy, provenance: 'unspecified' },
    { ...healthy, modelDigest: 'c'.repeat(64) }, { ...healthy, automationDigest: 'c'.repeat(64) },
    { ...healthy, status: 'green' },
  ]) expect(assess(result).status).toBe('unknown')
})


test('a Pack cannot relabel a mismatched variable identity, native unit or writable demand as feedback', () => {
  const tag = { id: 'PT-455' }
  const row = { signal: { tagId: tag.id, path: 'pressure.value', unit: 'MPa', writable: false }, variable: { path: 'pressure.value', value: 10, unit: 'MPa', writable: false } }
  for (const altered of [
    { ...row, signal: { ...row.signal, tagId: 'OTHER' } },
    { ...row, variable: { ...row.variable, path: 'other.value' } },
    { ...row, variable: { ...row.variable, unit: 'bar' } },
    { ...row, variable: { ...row.variable, writable: true } },
  ]) expect(() => parseProcedureTagValue(tag, { signals: [altered] })).toThrow()
})
