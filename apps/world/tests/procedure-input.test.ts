import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandId, ObjectId, ProcedureRunState, SimulationRunId } from '../src/core/model/index.ts'
import { procedureTestDocument, procedureTestRun, procedureTestRunId, deferred } from './procedure-fixtures.ts'
import { procedureRunDocumentKey } from '../src/ui/procedures/procedure-run-selectors.ts'
import { currentProcedureInput, procedureInputFocusFor, procedureInputViews, readProcedureInputTarget, resolveProcedureInputFocus } from '../src/ui/procedures/procedure-input.ts'

const ai = 'actor:ai:assistant' as ActorId
const run = (): ProcedureRunState => {
  const base = procedureTestRun()
  return { ...base, driver: { kind: 'ai', actorId: ai, since: base.startedAt }, inputRequest: { requestId: 'request-1' as CommandId, stepId: 'first', issue: 'Confirm the local indication.', requestedAt: base.startedAt, requestedBy: ai } }
}
const unit = { objectId: 'unit-2' as ObjectId, label: 'Unit 2', scope: run().scope }
const document = procedureTestDocument()

describe('procedure input attention', () => {
  test('only current driver-authored requests appear with exact Run, source, unit and step identity', () => {
    const current = run()
    const views = procedureInputViews(procedureTestRunId, [current], new Map([[procedureRunDocumentKey(current), document]]), [unit])
    expect(views).toHaveLength(1)
    expect(views[0]!.stepLabel).toBe('1')
    expect(views[0]!.unit).toBe('Unit 2')
    expect(views[0]!.issue).toBe('Confirm the local indication.')
    expect(views[0]!.key).toContain(procedureTestRunId)
    expect(views[0]!.focus.sourcePath).toBe(document.sourcePath)
    expect(procedureInputViews(procedureTestRunId, [current], new Map(), [])).toEqual([])
    expect(currentProcedureInput({ ...current, driver: { ...current.driver!, kind: 'person' } })).toBe(false)
    expect(currentProcedureInput({ ...current, driver: undefined })).toBe(false)
    expect(currentProcedureInput({ ...current, status: 'completed' })).toBe(false)
    expect(currentProcedureInput({ ...current, currentStepId: 'second' })).toBe(false)
    expect(currentProcedureInput({ ...current, inputRequest: { ...current.inputRequest!, requestedBy: 'actor:ai:other' as ActorId } })).toBe(false)
  })
  test('an old request never retargets another Run, revision, source, scope, step or driver', () => {
    const current = run(), focus = procedureInputFocusFor(procedureTestRunId, current)!
    expect(resolveProcedureInputFocus([current], focus, unit.scope, procedureTestRunId)).toBe(current)
    for (const patch of [
      { runId: 'procedure-run:other' }, { sourceRevision: 'b'.repeat(40) }, { sourceId: 'other-source' }, { sourcePath: 'different.md' }, { procedureId: 'TARGET' },
      { currentStepId: 'second' }, { inputRequest: undefined }, { status: 'transferred' },
      { inputRequest: { ...current.inputRequest!, requestId: 'request-2' as CommandId } },
    ] satisfies Partial<ProcedureRunState>[]) expect(resolveProcedureInputFocus([{ ...current, ...patch }], focus, unit.scope, procedureTestRunId)).toBeNull()
    expect(resolveProcedureInputFocus([current], focus, { plantId: 'other-unit' }, procedureTestRunId)).toBeNull()
    expect(resolveProcedureInputFocus([current], focus, unit.scope, 'other-run' as SimulationRunId)).toBeNull()
    expect(procedureInputViews('other-run' as SimulationRunId, [current], new Map(), [unit])[0]!.key).not.toBe(procedureInputViews(procedureTestRunId, [current], new Map(), [unit])[0]!.key)
  })
  test('rechecks the current request after async pinned document load before focusing', async () => {
    let runs = [run()]
    const focus = procedureInputFocusFor(procedureTestRunId, runs[0]!)!
    const loading = deferred<typeof document>()
    let reads = 0
    const session = { snapshot: () => ({ runs, documents: new Map() }), refreshRuns: async () => {}, readDocument: async () => { reads++; return await loading.promise } }
    const activation = readProcedureInputTarget(session, focus, unit.scope, procedureTestRunId)
    await Promise.resolve()
    runs = [{ ...runs[0]!, inputRequest: undefined, currentStepId: 'second' }]
    loading.resolve(document)
    expect(await activation).toBeNull()
    expect(reads).toBe(1)
    expect(await readProcedureInputTarget(session, focus, unit.scope, procedureTestRunId)).toBeNull()
    expect(reads).toBe(1)
  })
  test('opens only the exact retained document, refusing a same-name document from another revision', async () => {
    const current = run(), focus = procedureInputFocusFor(procedureTestRunId, current)!
    const session = { snapshot: () => ({ runs: [current], documents: new Map() }), refreshRuns: async () => {}, readDocument: async () => document }
    expect(await readProcedureInputTarget(session, focus, unit.scope, procedureTestRunId)).toBe(current)
    await expect(readProcedureInputTarget({ ...session, readDocument: async () => procedureTestDocument('E-0', 'b'.repeat(40)) }, focus, unit.scope, procedureTestRunId)).rejects.toThrow('Retained procedure document')
  })
})
