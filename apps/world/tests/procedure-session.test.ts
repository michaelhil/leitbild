import { describe, expect, test } from 'bun:test'
import type { ProcedureDocument } from '../src/core/model/index.ts'
import { createProcedureSession } from '../src/ui/procedures/procedure-session.ts'
import { procedureCategories, procedureViewKey } from '../src/ui/procedures/procedure-view.ts'
import { deferred, settle, procedureTestCatalog, procedureTestDocument, procedureTestRun, procedureTestRunId } from './procedure-fixtures.ts'

const request = (id = 'E-0') => {
  const document = procedureTestDocument(id)
  return { sourceId: document.source.sourceId, sourceRevision: document.source.revision, procedureId: id }
}

describe('route-owned procedure session', () => {
  test('coalesces foreground and background reads, caches exact revisions, validates cached paths', async () => {
    const response = deferred<ProcedureDocument>()
    let calls = 0
    const session = createProcedureSession({ simulationRunId: procedureTestRunId, onError: () => {},
      readDocument: async () => { calls++; return await response.promise } })
    try {
      const first = session.readDocument(request())
      const second = session.readDocument(request())
      expect(calls).toBe(1)
      response.resolve(procedureTestDocument())
      expect(await first).toBe(await second)
      expect(await session.readDocument(request())).toBe(await first)
      expect(calls).toBe(1)
      await expect(session.readDocument({ ...request(), sourcePath: 'wiki/wrong.md' })).rejects.toThrow('path')
      expect(session.cachedDocument({ ...request(), sourceRevision: 'b'.repeat(40) })).toBeUndefined()
    } finally { session.dispose() }
  })

  test('rejects wrong identity and retries a failed foreground request', async () => {
    let calls = 0
    const session = createProcedureSession({ simulationRunId: procedureTestRunId, onError: () => {},
      readDocument: async () => ++calls === 1 ? procedureTestDocument('WRONG') : procedureTestDocument() })
    try {
      await expect(session.readDocument(request())).rejects.toThrow('identity')
      expect(session.cachedDocument(request())).toBeUndefined()
      expect((await session.readDocument(request())).procedureId).toBe('E-0')
    } finally { session.dispose() }
  })

  test('serializes refreshes, catches up a queued change, publishes checkmarks before document enrichment', async () => {
    const first = deferred<{ runs: ReturnType<typeof procedureTestRun>[] }>()
    const second = deferred<{ runs: ReturnType<typeof procedureTestRun>[] }>()
    const document = deferred<ProcedureDocument>()
    const errors: unknown[] = []
    const seen: string[] = []
    let calls = 0
    const session = createProcedureSession({ simulationRunId: procedureTestRunId, onError: error => errors.push(error),
      readRuns: async () => await (++calls === 1 ? first.promise : second.promise),
      readDocument: async () => await document.promise })
    session.subscribe(state => { const step = state.runs[0]?.currentStepId; if (step) seen.push(step) })
    try {
      const a = session.refreshRuns()
      const b = session.refreshRuns()
      const c = session.refreshRuns()
      expect(calls).toBe(1)
      first.resolve({ runs: [procedureTestRun('first')] })
      await settle()
      expect(seen).toEqual(['first'])
      expect(calls).toBe(2)
      const changed = { ...procedureTestRun('second'), stepStates: [{ stepId: 'second', assessment: 'complete' as const,
        favorite: false, updatedAt: procedureTestRun().startedAt, updatedBy: procedureTestRun().startedBy }] }
      second.resolve({ runs: [changed] })
      await Promise.all([a, b, c])
      expect(seen).toEqual(['first', 'second'])
      expect(session.snapshot().runs[0]?.stepStates[0]?.assessment).toBe('complete')
      document.reject(new Error('source unavailable'))
      await settle()
      expect(errors.length).toBeGreaterThan(0)
      expect(session.snapshot().runs[0]?.currentStepId).toBe('second')
    } finally { session.dispose() }
  })

  test('shares four prefetch workers, stops scheduling when the last window closes, foreground still works', async () => {
    const catalog = procedureTestCatalog(Array.from({ length: 10 }, (_, i) => `PROC-${i}`))
    const pending = new Map<string, ReturnType<typeof deferred<ProcedureDocument>>>()
    let calls = 0
    const session = createProcedureSession({ simulationRunId: procedureTestRunId, onError: () => {},
      readDocument: async (_run, id) => { calls++; const result = deferred<ProcedureDocument>(); pending.set(id, result); return await result.promise } })
    try {
      const releaseA = session.retainPrefetch(catalog)
      const releaseB = session.retainPrefetch(catalog)
      expect(calls).toBe(4)
      releaseA()
      pending.get('PROC-0')!.resolve(procedureTestDocument('PROC-0'))
      await settle()
      expect(calls).toBe(5)
      releaseB(); releaseB()
      for (const [id, result] of pending) result.resolve(procedureTestDocument(id))
      await settle()
      expect(calls).toBe(5)
      const foreground = session.readDocument(request('PROC-9'))
      expect(calls).toBe(6)
      pending.get('PROC-9')!.resolve(procedureTestDocument('PROC-9'))
      await foreground
    } finally { session.dispose() }
  })

  test('aborts on route teardown and suppresses late notifications/errors', async () => {
    const pending = deferred<ProcedureDocument>()
    let signal: AbortSignal | undefined
    let notifications = 0
    let errors = 0
    const session = createProcedureSession({ simulationRunId: procedureTestRunId, onError: () => { errors++ },
      readDocument: async (_run, _id, config) => { signal = config?.signal; return await pending.promise } })
    session.subscribe(() => { notifications++ })
    const read = session.readDocument(request())
    session.dispose()
    expect(signal?.aborted).toBe(true)
    pending.resolve(procedureTestDocument())
    await expect(read).rejects.toThrow('closed')
    expect(notifications).toBe(1)
    expect(errors).toBe(0)
    expect(session.snapshot().documents.size).toBe(0)
  })

  test('coalesces catalog loads and explicitly refreshes metadata', async () => {
    let calls = 0
    const response = deferred<ReturnType<typeof procedureTestCatalog>>()
    const session = createProcedureSession({ simulationRunId: procedureTestRunId, onError: () => {},
      readCatalog: async () => { calls++; return await response.promise } })
    try {
      const a = session.readCatalog(); const b = session.readCatalog()
      response.resolve(procedureTestCatalog())
      expect(await a).toBe(await b)
      await session.readCatalog()
      expect(calls).toBe(1)
      await session.readCatalog(true)
      expect(calls).toBe(2)
    } finally { session.dispose() }
  })
})

test('view state is isolated by unit, document and revision; categories come from metadata, not ID prefixes', () => {
  const document = procedureTestDocument()
  const scope = { plantId: 'plant:a' }
  const keys = [procedureViewKey(document, scope), procedureViewKey(document, { plantId: 'plant:b' }),
    procedureViewKey(procedureTestDocument('OTHER'), scope), procedureViewKey(procedureTestDocument('E-0', 'b'.repeat(40)), scope)]
  expect(new Set(keys).size).toBe(4)
  const groups = procedureCategories(procedureTestCatalog(['E-0', 'UNRELATED']).procedures)
  expect(groups).toHaveLength(1)
  expect(groups[0]?.label).toBe('custom category')
  expect(groups[0]?.procedures.map(item => item.procedureId)).toEqual(['E-0', 'UNRELATED'])
})
