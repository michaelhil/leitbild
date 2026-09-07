import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createKnowledge, type Knowledge, type KnowledgeSnapshot } from '@leitbild/knowledge'
import { sourceRevisionSchema } from '@leitbild/contracts'
import { nowIso, procedureCatalogSchema, procedureSourceIdSchema, type ProcedureCatalog, type ProcedureDocument } from '../../core/model/index.ts'
import { parseProcedureMarkdown } from './procmd.ts'
import { rejectCapabilityInput, rejectCapabilityTarget } from '../../simulation/capability-rejection.ts'

export interface ProcedureSourceConfig {
  readonly sourceId: string
  readonly label: string
  readonly repository: string
  readonly ref: string
  readonly procedurePath: string
}
export interface ProcedureDocumentRequest {
  readonly sourceId?: string
  readonly procedureId: string
  readonly sourceRevision?: string
  readonly sourcePath?: string
}
export interface ProcedureSourceService {
  readonly listSources: () => ReadonlyArray<ProcedureSourceConfig>
  readonly readCatalog: (config?: { readonly sourceId?: string; readonly refresh?: boolean }) => Promise<ProcedureCatalog>
  readonly readDocument: (config: ProcedureDocumentRequest) => Promise<ProcedureDocument>
}

const citation = (path: string, revision: string): string =>
  `/wiki?${new URLSearchParams({ path, revision })}`

const syncDirectory = async (path: string): Promise<void> => {
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

// This is selected Run source evidence, not a second editable knowledge catalog.
// Publish without overwrite, and finish durable file/directory writes before a
// command can accept a Run pinned to this revision. Concurrent equal writes dedupe.
const retain = async (directory: string, path: string, contents: string): Promise<void> => {
  let existing: string | undefined
  try { existing = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing !== undefined) {
    if (existing !== contents) throw new Error('Retained procedure publication conflicts with the same source revision')
    await syncDirectory(directory)
    return
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporaryPath, 'wx', 0o600)
    try { await file.writeFile(contents, 'utf8'); await file.sync() } finally { await file.close() }
    try {
      await link(temporaryPath, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await readFile(path, 'utf8') !== contents) throw new Error('Retained procedure publication conflicts with the same source revision')
    }
    await syncDirectory(directory)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

const bundleFor = (source: ProcedureSourceConfig, knowledge: Knowledge, retained = false) => {
  const prefix = `${source.procedurePath.replace(/\/$/, '')}/`
  const snapshot: KnowledgeSnapshot = {
    revision: knowledge.revision,
    // A retained bundle is already the exact selected source, independent of
    // where the current publication organizes its documents.
    documents: knowledge.index().filter(entry => retained || (entry.path.startsWith(prefix) && !entry.hub))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      .map(entry => ({ path: entry.path, content: knowledge.read(entry.path).content })),
  }
  if (!snapshot.documents.length) throw new Error(`No procedure documents in local publication path ${source.procedurePath}`)
  const metadata = {
    sourceId: source.sourceId, label: source.label, repository: source.repository, ref: source.ref,
    path: retained ? dirname(snapshot.documents[0]!.path) : source.procedurePath, revision: knowledge.revision, fetchedAt: nowIso(),
    sourceUrl: `/wiki?${new URLSearchParams({ revision: knowledge.revision })}`,
  }
  const documents = snapshot.documents.map(document => parseProcedureMarkdown({
    source: metadata, sourcePath: document.path,
    sourceUrl: citation(document.path, knowledge.revision), rawMarkdown: document.content,
  }))
  const ids = new Set<string>()
  for (const document of documents) {
    if (ids.has(document.procedureId)) throw new Error(`Duplicate procedure id ${document.procedureId} in local publication`)
    ids.add(document.procedureId)
  }
  const catalog = procedureCatalogSchema.parse({
    source: metadata,
    procedures: documents.map(document => ({
      sourceId: source.sourceId, procedureId: document.procedureId, title: document.title,
      ...(document.profile === undefined ? {} : { profile: document.profile }),
      ...(document.category === undefined ? {} : { category: document.category }),
      csfsMonitored: document.csfsMonitored, entryTriggers: document.entryTriggers,
      stepCount: document.steps.length, tagCount: document.tags.length,
      sourcePath: document.sourcePath, sourceUrl: document.sourceUrl,
    })).sort((left, right) => left.procedureId.localeCompare(right.procedureId)),
  })
  return { snapshot, documents, catalog }
}

export const createProcedureSourceService = (config: {
  readonly sources?: ReadonlyArray<ProcedureSourceConfig>
  readonly retentionDirectory?: string
  readonly loadKnowledge?: () => Promise<Knowledge>
} = {}): ProcedureSourceService => {
  const sources = config.sources ?? []
  if (sources.length && !config.retentionDirectory) throw new Error('Local procedures require a World source retention directory')
  const directory = config.retentionDirectory ? resolve(config.retentionDirectory) : undefined
  if (sources.length && !config.loadKnowledge) throw new Error('Local procedures require an application-owned knowledge loader')
  const load = config.loadKnowledge ?? (async (): Promise<Knowledge> => { throw new Error('No procedure knowledge source is configured') })
  const sourceFor = (sourceId?: string): ProcedureSourceConfig => {
    const id = sourceId ?? sources[0]?.sourceId
    const source = sources.find(candidate => candidate.sourceId === id)
    if (!source) return rejectCapabilityTarget(`Unknown procedure source: ${id ?? 'none configured'}. Discover the current procedure catalog without sourceId.`)
    return source
  }
  const publicationPath = (source: ProcedureSourceConfig, revision: string) =>
    join(directory!, `${procedureSourceIdSchema.parse(source.sourceId)}-${sourceRevisionSchema.parse(revision)}.json`)

  // The configured directory is directly beneath the existing World dataDir.
  // Every first-use writer awaits directory + parent persistence, even if mkdir
  // was won by another writer or a previous attempt failed during fsync.
  let directoryReady: Promise<void> | undefined
  const prepareDirectory = async (): Promise<void> => {
    const pending = directoryReady ??= (async () => {
      try { await mkdir(directory!) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      await syncDirectory(directory!)
      await syncDirectory(dirname(directory!))
    })()
    try { await pending } catch (error) {
      if (directoryReady === pending) directoryReady = undefined
      throw error
    }
  }

  return {
    listSources: () => [...sources],
    readCatalog: async (request = {}) => bundleFor(sourceFor(request.sourceId), await load()).catalog,
    readDocument: async (request): Promise<ProcedureDocument> => {
      const source = sourceFor(request.sourceId)
      if (request.sourcePath !== undefined && request.sourceRevision === undefined) return rejectCapabilityInput('Procedure sourcePath requires sourceRevision')
      let bundle: ReturnType<typeof bundleFor> | undefined
      if (request.sourceRevision !== undefined) {
        const path = publicationPath(source, request.sourceRevision)
        let raw: string | undefined
        try { raw = await readFile(path, 'utf8') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (raw !== undefined) {
          const retained = createKnowledge(JSON.parse(raw) as unknown)
          if (retained.revision !== request.sourceRevision) throw new Error('Retained procedure publication revision does not match its pin')
          bundle = bundleFor(source, retained, true)
        }
      }
      if (!bundle) {
        const current = await load()
        if (request.sourceRevision !== undefined && current.revision !== request.sourceRevision) {
          return rejectCapabilityTarget(`Procedure source ${source.sourceId} revision ${request.sourceRevision} is unavailable; it is not retained or currently published`)
        }
        bundle = bundleFor(source, current)
      }
      const document = bundle.documents.find(candidate => candidate.procedureId === request.procedureId)
      if (!document) return rejectCapabilityTarget(`Procedure ${request.procedureId} not found in source ${source.sourceId} at ${bundle.snapshot.revision}`)
      if (request.sourcePath !== undefined && request.sourcePath !== document.sourcePath) {
        return rejectCapabilityInput(`Procedure ${request.procedureId} source path does not match its pinned publication`)
      }
      // Retain every procedure at the selected revision: a future transition may
      // need a different document after deployment has replaced the latest wiki.
      await prepareDirectory()
      await retain(directory!, publicationPath(source, bundle.snapshot.revision), `${JSON.stringify(bundle.snapshot)}\n`)
      return document
    },
  }
}
