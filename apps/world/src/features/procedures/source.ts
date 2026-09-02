import {
  sourceDocumentPathSchema,
  sourceRevisionSchema,
  wikiManifestSchema,
  type ProcedureManifestEntry,
  type WikiManifest,
} from '@leitbild/contracts'
import {
  nowIso,
  procedureCatalogSchema,
  procedureDocumentSchema,
  procedureIdSchema,
  type ProcedureCatalog,
  type ProcedureDocument,
  type ProcedureId,
  type ProcedureSource,
  type ProcedureSourceId,
} from '../../core/model/index.ts'
import { parseProcedureMarkdown } from './procmd.ts'

export interface ProcedureSourceConfig {
  readonly sourceId: ProcedureSourceId
  readonly label: string
  readonly repository: string
  readonly ref: string
  readonly manifestUrl: string
  readonly manifestPath: string
  readonly procedurePath: string
}

interface ProcedureCatalogCacheEntry {
  readonly loadedAtMs: number
  readonly manifest: WikiManifest
  readonly catalog: ProcedureCatalog
}

export interface ProcedureSourceService {
  readonly listSources: () => ReadonlyArray<ProcedureSourceConfig>
  readonly readCatalog: (config?: {
    readonly sourceId?: ProcedureSourceId
    readonly refresh?: boolean
  }) => Promise<ProcedureCatalog>
  readonly readDocument: (config: {
    readonly sourceId?: ProcedureSourceId
    readonly procedureId: ProcedureId
    readonly sourceRevision?: string
    readonly sourcePath?: string
  }) => Promise<ProcedureDocument>
}

const defaultCacheTtlMs = 60 * 60 * 1000
const defaultFetchTimeoutMs = 8_000
const supportedProcmdVersion = '0.7'

const fetchText = async (
  fetchFn: typeof fetch,
  url: string,
  config: { readonly refresh?: boolean; readonly timeoutMs: number },
): Promise<string> => {
  const response = await fetchFn(url, {
    headers: {
      Accept: 'application/json, text/markdown;q=0.9, text/plain;q=0.8',
      'Cache-Control': config.refresh ? 'no-cache' : 'max-age=0',
      'User-Agent': 'leitbild-procedure-source',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  if (!response.ok) throw new Error(`procedure source fetch failed for ${url}: ${response.status}`)
  return await response.text()
}

const repositoryUrlFor = (source: ProcedureSourceConfig): string =>
  `https://github.com/${source.repository}`

const rawUrlFor = (
  source: ProcedureSourceConfig,
  revision: string,
  sourcePath: string,
): string =>
  `https://raw.githubusercontent.com/${source.repository}/${revision}/${sourcePath}`

const sourceUrlFor = (
  source: ProcedureSourceConfig,
  revision: string,
  sourcePath = source.procedurePath,
): string =>
  `${repositoryUrlFor(source)}/tree/${revision}/${sourcePath}`

const documentUrlFor = (
  source: ProcedureSourceConfig,
  revision: string,
  sourcePath: string,
): string =>
  `${repositoryUrlFor(source)}/blob/${revision}/${sourcePath}`

const procedureSourceFor = (
  source: ProcedureSourceConfig,
  revision: string,
): ProcedureSource => ({
  sourceId: source.sourceId,
  label: source.label,
  repository: source.repository,
  ref: source.ref,
  path: source.procedurePath,
  revision: sourceRevisionSchema.parse(revision),
  fetchedAt: nowIso(),
  sourceUrl: sourceUrlFor(source, revision),
})

const catalogItemFor = (
  source: ProcedureSourceConfig,
  revision: string,
  entry: ProcedureManifestEntry,
) => ({
  sourceId: source.sourceId,
  procedureId: procedureIdSchema.parse(entry.id),
  title: entry.title,
  ...(entry.profile === undefined ? {} : { profile: entry.profile }),
  ...(entry.category === undefined ? {} : { category: entry.category }),
  csfsMonitored: entry.csfsMonitored,
  entryTriggers: entry.entryTriggers,
  stepCount: entry.stepCount,
  tagCount: entry.tagDefinitionCount,
  sourcePath: entry.file,
  sourceUrl: documentUrlFor(source, revision, entry.file),
})

const assertManifestMatchesSource = (
  source: ProcedureSourceConfig,
  manifest: WikiManifest,
): void => {
  if (manifest.wiki !== source.sourceId) {
    throw new Error(`procedure manifest ${manifest.wiki} does not match configured source ${source.sourceId}`)
  }
  if (manifest.procmdVersion !== supportedProcmdVersion) {
    throw new Error(`unsupported procmd version ${manifest.procmdVersion}; expected ${supportedProcmdVersion}`)
  }
  const prefix = `${source.procedurePath.replace(/\/$/, '')}/`
  for (const procedure of manifest.procedures) {
    if (!procedure.file.startsWith(prefix)) {
      throw new Error(`procedure ${procedure.id} is outside configured path ${source.procedurePath}`)
    }
  }
}

const loadCatalog = async (config: {
  readonly source: ProcedureSourceConfig
  readonly fetchFn: typeof fetch
  readonly refresh: boolean
  readonly timeoutMs: number
}): Promise<ProcedureCatalogCacheEntry> => {
  const raw = await fetchText(config.fetchFn, config.source.manifestUrl, {
    refresh: config.refresh,
    timeoutMs: config.timeoutMs,
  })
  let decoded: unknown
  try {
    decoded = JSON.parse(raw) as unknown
  } catch {
    throw new Error(`procedure manifest is not valid JSON: ${config.source.manifestUrl}`)
  }
  const manifest = wikiManifestSchema.parse(decoded)
  assertManifestMatchesSource(config.source, manifest)
  const sourceMetadata = procedureSourceFor(config.source, manifest.revision)
  return {
    loadedAtMs: Date.now(),
    manifest,
    catalog: procedureCatalogSchema.parse({
      source: sourceMetadata,
      procedures: manifest.procedures
        .map(entry => catalogItemFor(config.source, manifest.revision, entry))
        .sort((left, right) => left.procedureId.localeCompare(right.procedureId)),
    }) as ProcedureCatalog,
  }
}

const assertDocumentMatchesManifest = (
  document: ProcedureDocument,
  entry: ProcedureManifestEntry | undefined,
): void => {
  if (!entry) return
  if (document.title !== entry.title) {
    throw new Error(`procedure ${document.procedureId} title does not match its manifest entry`)
  }
  if (document.steps.length !== entry.stepCount) {
    throw new Error(`procedure ${document.procedureId} step count does not match its manifest entry`)
  }
  if (document.tags.length !== entry.tagDefinitionCount) {
    throw new Error(`procedure ${document.procedureId} tag count does not match its manifest entry`)
  }
}

export const createProcedureSourceService = (config: {
  readonly sources?: ReadonlyArray<ProcedureSourceConfig>
  readonly cacheTtlMs?: number
  readonly fetchFn?: typeof fetch
  readonly fetchTimeoutMs?: number
} = {}): ProcedureSourceService => {
  const sources = config.sources ?? []
  const cacheTtlMs = config.cacheTtlMs ?? defaultCacheTtlMs
  const fetchFn = config.fetchFn ?? globalThis.fetch
  const fetchTimeoutMs = config.fetchTimeoutMs ?? defaultFetchTimeoutMs
  const catalogCache = new Map<ProcedureSourceId, ProcedureCatalogCacheEntry>()
  const catalogLoads = new Map<ProcedureSourceId, Promise<ProcedureCatalogCacheEntry>>()
  const revisionManifestCache = new Map<string, Promise<WikiManifest>>()
  const documentCache = new Map<string, Promise<ProcedureDocument>>()

  const sourceFor = (sourceId?: ProcedureSourceId): ProcedureSourceConfig => {
    const id = sourceId ?? sources[0]?.sourceId
    const source = sources.find(candidate => candidate.sourceId === id)
    if (!source) throw new Error(`unknown procedure source: ${id ?? 'none configured'}`)
    return source
  }

  const readCatalogEntry = async (
    sourceId?: ProcedureSourceId,
    refresh = false,
  ): Promise<ProcedureCatalogCacheEntry> => {
    const source = sourceFor(sourceId)
    const inFlight = catalogLoads.get(source.sourceId)
    if (inFlight) return await inFlight

    const cached = catalogCache.get(source.sourceId)
    if (!refresh && cached && Date.now() - cached.loadedAtMs < cacheTtlMs) return cached

    const loading = loadCatalog({ source, fetchFn, refresh, timeoutMs: fetchTimeoutMs })
    catalogLoads.set(source.sourceId, loading)
    try {
      const loaded = await loading
      catalogCache.set(source.sourceId, loaded)
      return loaded
    } finally {
      if (catalogLoads.get(source.sourceId) === loading) catalogLoads.delete(source.sourceId)
    }
  }

  const readDocument = async (readConfig: {
    readonly sourceId?: ProcedureSourceId
    readonly procedureId: ProcedureId
    readonly sourceRevision?: string
    readonly sourcePath?: string
  }): Promise<ProcedureDocument> => {
    const source = sourceFor(readConfig.sourceId)
    if (readConfig.sourcePath !== undefined && readConfig.sourceRevision === undefined) {
      throw new Error('procedure sourcePath requires sourceRevision')
    }
    const current = catalogCache.get(source.sourceId)
    const currentOrLoaded = readConfig.sourceRevision === undefined
      ? await readCatalogEntry(source.sourceId)
      : current
    const revision = sourceRevisionSchema.parse(readConfig.sourceRevision ?? currentOrLoaded?.manifest.revision)
    let manifest = currentOrLoaded?.manifest.revision === revision
      ? currentOrLoaded.manifest
      : undefined
    if (!manifest && readConfig.sourcePath === undefined) {
      const manifestKey = `${source.sourceId}:${revision}`
      let loadingManifest = revisionManifestCache.get(manifestKey)
      if (!loadingManifest) {
        loadingManifest = (async () => {
          const raw = await fetchText(fetchFn, rawUrlFor(source, revision, source.manifestPath), {
            timeoutMs: fetchTimeoutMs,
          })
          const parsed = wikiManifestSchema.parse(JSON.parse(raw) as unknown)
          assertManifestMatchesSource(source, parsed)
          return parsed
        })()
        revisionManifestCache.set(manifestKey, loadingManifest)
      }
      try {
        manifest = await loadingManifest
      } catch (error) {
        if (revisionManifestCache.get(manifestKey) === loadingManifest) revisionManifestCache.delete(manifestKey)
        throw error
      }
    }
    const manifestEntry = manifest?.procedures.find(entry => entry.id === readConfig.procedureId)
    if (manifestEntry === undefined && readConfig.sourcePath === undefined) {
      throw new Error(`procedure ${readConfig.procedureId} not found in source ${source.sourceId}`)
    }
    if (manifestEntry && readConfig.sourcePath && manifestEntry.file !== readConfig.sourcePath) {
      throw new Error(`procedure ${readConfig.procedureId} source path does not match its manifest entry`)
    }
    const sourcePath = sourceDocumentPathSchema.parse(readConfig.sourcePath ?? manifestEntry?.file)
    const cacheKey = `${source.sourceId}:${revision}:${sourcePath}`
    const cached = documentCache.get(cacheKey)
    if (cached) {
      const document = await cached
      if (document.procedureId !== readConfig.procedureId) {
        throw new Error(`procedure source ${sourcePath} contains ${document.procedureId}, expected ${readConfig.procedureId}`)
      }
      return document
    }

    const loading = (async (): Promise<ProcedureDocument> => {
      const rawMarkdown = await fetchText(fetchFn, rawUrlFor(source, revision, sourcePath), {
        timeoutMs: fetchTimeoutMs,
      })
      const parsed = procedureDocumentSchema.parse(parseProcedureMarkdown({
        source: procedureSourceFor(source, revision),
        sourcePath,
        sourceUrl: documentUrlFor(source, revision, sourcePath),
        rawMarkdown,
      })) as ProcedureDocument
      if (parsed.procedureId !== readConfig.procedureId) {
        throw new Error(`procedure source ${sourcePath} contains ${parsed.procedureId}, expected ${readConfig.procedureId}`)
      }
      assertDocumentMatchesManifest(parsed, manifestEntry)
      return parsed
    })()
    documentCache.set(cacheKey, loading)
    try {
      return await loading
    } catch (error) {
      if (documentCache.get(cacheKey) === loading) documentCache.delete(cacheKey)
      throw error
    }
  }

  return {
    listSources: () => [...sources],
    readCatalog: async (readConfig = {}) =>
      (await readCatalogEntry(readConfig.sourceId, readConfig.refresh)).catalog,
    readDocument,
  }
}
