import { createHash } from 'node:crypto'
import { nowIso, procedureCatalogSchema, procedureDocumentSchema, type IsoTimestamp, type ProcedureCatalog, type ProcedureCatalogItem, type ProcedureDocument, type ProcedureId, type ProcedureSource, type ProcedureSourceId } from '../model/index.ts'
import { parseProcedureMarkdown } from './procmd.ts'

interface GitHubContentItem {
  readonly name?: unknown
  readonly path?: unknown
  readonly type?: unknown
  readonly download_url?: unknown
  readonly html_url?: unknown
  readonly sha?: unknown
}

export interface ProcedureSourceConfig {
  readonly sourceId: ProcedureSourceId
  readonly label: string
  readonly repository: string
  readonly ref: string
  readonly path: string
}

interface ProcedureSourceCacheEntry {
  readonly loadedAtMs: number
  readonly catalog: ProcedureCatalog
  readonly documents: ReadonlyMap<ProcedureId, ProcedureDocument>
}

interface ProcedureSourceItem {
  readonly name: string
  readonly path: string
  readonly downloadUrl: string
  readonly htmlUrl: string
  readonly sha: string
}

export interface ProcedureSourceService {
  readonly listSources: () => ReadonlyArray<ProcedureSourceConfig>
  readonly readCatalog: (config?: { readonly sourceId?: ProcedureSourceId; readonly refresh?: boolean }) => Promise<ProcedureCatalog>
  readonly readDocument: (config: { readonly sourceId?: ProcedureSourceId; readonly procedureId: ProcedureId; readonly refresh?: boolean }) => Promise<ProcedureDocument>
}

const defaultCacheTtlMs = 5 * 60 * 1000

export const defaultProcedureSources: ReadonlyArray<ProcedureSourceConfig> = [{
  sourceId: 'pwr-ops',
  label: 'PWR operations procedures',
  repository: 'samsinn-wikis/pwr-ops',
  ref: 'main',
  path: 'wiki/procedures',
}]

const githubApiHeaders = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'leitbild-procedure-source-loader',
}

const isGitHubItem = (value: unknown): value is GitHubContentItem =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertString = (value: unknown, message: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message)
  return value
}

const sourceUrlFor = (source: ProcedureSourceConfig): string =>
  `https://github.com/${source.repository}/tree/${encodeURIComponent(source.ref)}/${source.path}`

const corpusRevisionFor = (items: ReadonlyArray<ProcedureSourceItem>): string =>
  createHash('sha256')
    .update(items.map(item => `${item.path}:${item.sha}`).join('\n'))
    .digest('hex')

const apiUrlFor = (source: ProcedureSourceConfig): string =>
  `https://api.github.com/repos/${source.repository}/contents/${source.path}?ref=${encodeURIComponent(source.ref)}`

const sourceFrom = (source: ProcedureSourceConfig, fetchedAt: IsoTimestamp, commitSha?: string): ProcedureSource => ({
  sourceId: source.sourceId,
  label: source.label,
  repository: source.repository,
  ref: source.ref,
  path: source.path,
  fetchedAt,
  sourceUrl: sourceUrlFor(source),
  ...(commitSha === undefined ? {} : { commitSha }),
})

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, { headers: githubApiHeaders, cache: 'no-store' })
  if (!response.ok) throw new Error(`procedure source fetch failed for ${url}: ${response.status}`)
  return await response.json() as unknown
}

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url, { headers: { 'User-Agent': githubApiHeaders['User-Agent'] }, cache: 'no-store' })
  if (!response.ok) throw new Error(`procedure markdown fetch failed for ${url}: ${response.status}`)
  return await response.text()
}

const readProcedureItems = async (source: ProcedureSourceConfig): Promise<ReadonlyArray<ProcedureSourceItem>> => {
  const raw = await fetchJson(apiUrlFor(source))
  if (!Array.isArray(raw)) throw new Error(`procedure source path is not a directory: ${source.repository}/${source.path}`)
  return raw
    .filter(isGitHubItem)
    .filter(item => item.type === 'file' && typeof item.name === 'string' && item.name.endsWith('.md'))
    .map(item => ({
      name: assertString(item.name, 'procedure source item requires name'),
      path: assertString(item.path, 'procedure source item requires path'),
      downloadUrl: assertString(item.download_url, 'procedure source item requires download URL'),
      htmlUrl: assertString(item.html_url, 'procedure source item requires HTML URL'),
      sha: assertString(item.sha, 'procedure source item requires SHA'),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

const loadSource = async (source: ProcedureSourceConfig): Promise<ProcedureSourceCacheEntry> => {
  const fetchedAt = nowIso()
  const items = await readProcedureItems(source)
  const sourceMetadata = sourceFrom(source, fetchedAt, corpusRevisionFor(items))
  const documents = new Map<ProcedureId, ProcedureDocument>()
  for (const item of items) {
    const rawMarkdown = await fetchText(item.downloadUrl)
    const parsed = parseProcedureMarkdown({
      source: sourceMetadata,
      sourcePath: item.path,
      sourceUrl: item.htmlUrl,
      rawMarkdown,
    })
    if (documents.has(parsed.procedureId)) throw new Error(`duplicate procedure id in source ${source.sourceId}: ${parsed.procedureId}`)
    documents.set(parsed.procedureId, procedureDocumentSchema.parse(parsed) as ProcedureDocument)
  }
  const procedures: ProcedureCatalogItem[] = [...documents.values()]
    .map(document => ({
      sourceId: document.source.sourceId,
      procedureId: document.procedureId,
      title: document.title,
      ...(document.profile === undefined ? {} : { profile: document.profile }),
      ...(document.category === undefined ? {} : { category: document.category }),
      csfsMonitored: document.csfsMonitored,
      entryTriggers: document.entryTriggers,
      stepCount: document.steps.length,
      tagCount: document.tags.length,
      sourcePath: document.sourcePath,
      sourceUrl: document.sourceUrl,
    }))
    .sort((left, right) => left.procedureId.localeCompare(right.procedureId))
  return {
    loadedAtMs: Date.now(),
    catalog: procedureCatalogSchema.parse({
      source: sourceMetadata,
      procedures,
    }) as ProcedureCatalog,
    documents,
  }
}

export const createProcedureSourceService = (config: {
  readonly sources?: ReadonlyArray<ProcedureSourceConfig>
  readonly cacheTtlMs?: number
} = {}): ProcedureSourceService => {
  const sources = config.sources ?? defaultProcedureSources
  const cacheTtlMs = config.cacheTtlMs ?? defaultCacheTtlMs
  const cache = new Map<ProcedureSourceId, Promise<ProcedureSourceCacheEntry>>()

  const sourceFor = (sourceId?: ProcedureSourceId): ProcedureSourceConfig => {
    const id = sourceId ?? sources[0]?.sourceId
    const source = sources.find(candidate => candidate.sourceId === id)
    if (!source) throw new Error(`unknown procedure source: ${id ?? 'none configured'}`)
    return source
  }

  const readEntry = async (sourceId?: ProcedureSourceId, refresh = false): Promise<ProcedureSourceCacheEntry> => {
    const source = sourceFor(sourceId)
    const existing = cache.get(source.sourceId)
    if (existing && !refresh) {
      try {
        const resolved = await existing
        if (Date.now() - resolved.loadedAtMs < cacheTtlMs) return resolved
      } catch {
        cache.delete(source.sourceId)
      }
    }
    const loading = loadSource(source)
    cache.set(source.sourceId, loading)
    try {
      return await loading
    } catch (error) {
      if (cache.get(source.sourceId) === loading) cache.delete(source.sourceId)
      throw error
    }
  }

  return {
    listSources: () => [...sources],
    readCatalog: async (readConfig = {}) => (await readEntry(readConfig.sourceId, readConfig.refresh)).catalog,
    readDocument: async (readConfig) => {
      const entry = await readEntry(readConfig.sourceId, readConfig.refresh)
      const document = entry.documents.get(readConfig.procedureId)
      if (!document) throw new Error(`procedure ${readConfig.procedureId} not found in source ${readConfig.sourceId ?? sourceFor().sourceId}`)
      return document
    },
  }
}
