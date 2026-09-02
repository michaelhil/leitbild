import type { ProcedureCatalog, ProcedureDocument, ProcedureRunState, SimulationRunId } from '../../core/model/index.ts'
import { readProcedureCatalog, readProcedureDocument, readProcedureRuns } from './procedure-client.ts'
import { procedureRunDocumentKey } from './procedure-run-selectors.ts'

export interface ProcedureDocumentRequest {
  readonly sourceId: string
  readonly sourceRevision: string
  readonly procedureId: string
  readonly sourcePath?: string
}

interface SessionSnapshot {
  readonly runs: ReadonlyArray<ProcedureRunState>
  readonly documents: ReadonlyMap<string, ProcedureDocument>
}

export type ProcedureSession = ReturnType<typeof createProcedureSession>

// One route owns this session. Immutable documents are shared across its windows;
// scroll, selection and drafts remain local to each window.
export const createProcedureSession = (config: {
  readonly simulationRunId: SimulationRunId
  readonly onError: (error: unknown) => void
  readonly readCatalog?: typeof readProcedureCatalog
  readonly readDocument?: typeof readProcedureDocument
  readonly readRuns?: typeof readProcedureRuns
}) => {
  const fetchCatalog = config.readCatalog ?? readProcedureCatalog
  const fetchDocument = config.readDocument ?? readProcedureDocument
  const fetchRuns = config.readRuns ?? readProcedureRuns
  const abort = new AbortController()
  const documents = new Map<string, ProcedureDocument>()
  const documentLoads = new Map<string, Promise<ProcedureDocument>>()
  const listeners = new Set<(state: SessionSnapshot) => void>()
  let runs: ReadonlyArray<ProcedureRunState> = []
  let catalog: ProcedureCatalog | null = null
  let catalogLoad: Promise<ProcedureCatalog> | null = null
  let runsLoad: Promise<void> | null = null
  let refreshQueued = false
  let prefetchConsumers = 0
  let prefetchGeneration = 0
  let prefetchRevision = ''
  let disposed = false
  const assertOpen = (): void => { if (disposed) throw new Error('procedure session is closed') }
  const snapshot = (): SessionSnapshot => ({ runs, documents: new Map(documents) })
  const notify = (): void => { if (!disposed) for (const listener of listeners) listener(snapshot()) }
  const report = (error: unknown): void => { if (!disposed) config.onError(error) }
  const cachedDocument = (request: ProcedureDocumentRequest): ProcedureDocument | undefined =>
    [...documents.values()].find(document => document.source.sourceId === request.sourceId
      && document.source.revision === request.sourceRevision && document.procedureId === request.procedureId)
  const checkPath = (document: ProcedureDocument, request: ProcedureDocumentRequest): ProcedureDocument => {
    if (request.sourcePath !== undefined && document.sourcePath !== request.sourcePath) throw new Error('procedure document path does not match requested revision')
    return document
  }
  const readDocument = async (request: ProcedureDocumentRequest): Promise<ProcedureDocument> => {
    assertOpen()
    const cached = cachedDocument(request)
    if (cached) return checkPath(cached, request)
    const key = JSON.stringify([request.sourceId, request.sourceRevision, request.procedureId])
    let loading = documentLoads.get(key)
    if (!loading) {
      loading = (async () => {
        const document = await fetchDocument(config.simulationRunId, request.procedureId, { ...request, signal: abort.signal })
        assertOpen()
        if (document.source.sourceId !== request.sourceId || document.source.revision !== request.sourceRevision || document.procedureId !== request.procedureId) {
          throw new Error('procedure document identity does not match request')
        }
        documents.set(procedureRunDocumentKey({
          sourceId: document.source.sourceId, sourceRevision: document.source.revision,
          sourcePath: document.sourcePath, procedureId: document.procedureId,
        }), document)
        // Prefetch alone does not rerender every open window. Only summaries of
        // actual Runs need reactive document enrichment.
        if (runs.some(run => procedureRunDocumentKey(run) === procedureRunDocumentKey({
          sourceId: document.source.sourceId, sourceRevision: document.source.revision,
          sourcePath: document.sourcePath, procedureId: document.procedureId,
        }))) notify()
        return document
      })()
      documentLoads.set(key, loading)
    }
    try { return checkPath(await loading, request) }
    finally { if (documentLoads.get(key) === loading) documentLoads.delete(key) }
  }
  const readCatalog = async (refresh = false): Promise<ProcedureCatalog> => {
    assertOpen()
    if (catalogLoad) return await catalogLoad
    if (catalog && !refresh) return catalog
    const loading = fetchCatalog(config.simulationRunId, { refresh, signal: abort.signal })
    catalogLoad = loading
    try { const loaded = await loading; assertOpen(); catalog = loaded; return loaded }
    finally { if (catalogLoad === loading) catalogLoad = null }
  }
  const refreshRuns = async (): Promise<void> => {
    assertOpen()
    if (runsLoad) { refreshQueued = true; return await runsLoad }
    const loading = (async () => {
      do {
        refreshQueued = false
        const response = await fetchRuns(config.simulationRunId, abort.signal)
        assertOpen()
        runs = response.runs
        notify()
        const unique = new Map(runs.filter(run => run.status !== 'abandoned').map(run => [procedureRunDocumentKey(run), run]))
        // New checkmarks are already visible; missing summary text cannot block them.
        void Promise.all([...unique.values()].map(readDocument)).catch(report)
      } while (refreshQueued && !disposed)
    })()
    runsLoad = loading
    try { await loading }
    finally { if (runsLoad === loading) runsLoad = null }
  }
  const warm = (nextCatalog: ProcedureCatalog): void => {
    const revision = `${nextCatalog.source.sourceId}:${nextCatalog.source.revision}`
    if (prefetchRevision === revision) return
    prefetchRevision = revision
    const generation = ++prefetchGeneration
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (!disposed && prefetchConsumers > 0 && generation === prefetchGeneration) {
        const item = nextCatalog.procedures[cursor++]
        if (!item) return
        try { await readDocument({ ...item, sourceRevision: nextCatalog.source.revision }) }
        catch (error) { report(error) } // A foreground selection can retry a failed prefetch.
      }
    }
    // Four requests keep the source busy without flooding the shared HTTP service.
    void Promise.all(Array.from({ length: Math.min(4, nextCatalog.procedures.length) }, worker))
  }
  return {
    snapshot, readCatalog, readDocument, refreshRuns,
    cachedDocument: (request: ProcedureDocumentRequest) => {
      const document = cachedDocument(request)
      return document ? checkPath(document, request) : undefined
    },
    subscribe: (listener: (state: SessionSnapshot) => void): (() => void) => {
      assertOpen(); listeners.add(listener); listener(snapshot())
      return () => { listeners.delete(listener) }
    },
    retainPrefetch: (nextCatalog: ProcedureCatalog): (() => void) => {
      assertOpen(); prefetchConsumers++; warm(nextCatalog)
      let released = false
      return () => {
        if (released) return
        released = true
        if (--prefetchConsumers === 0) { prefetchGeneration++; prefetchRevision = '' }
      }
    },
    dispose: (): void => {
      disposed = true; prefetchGeneration++; abort.abort(); listeners.clear(); documents.clear()
    },
  }
}
