import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  asIso8601,
  type FetchCache,
  type FetchCacheEntry,
  type RawBytes,
  type SourceId,
} from './types.ts'

// On-disk fetch cache. One JSON metadata file plus the raw body file per source.
// Conditional GET helpers live alongside; remote sources use them to decide
// whether to skip the fetch.

const metadataPath = (rootDir: string, sourceId: SourceId): string => join(rootDir, String(sourceId), 'metadata.json')
const bodyPath = (rootDir: string, sourceId: SourceId, sha256: string): string => join(rootDir, String(sourceId), `${sha256}.bin`)

const sha256Hex = (bytes: RawBytes): string => createHash('sha256').update(bytes).digest('hex')

const atomicWriteFile = async (path: string, data: string | RawBytes): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

const safeReadJson = async <T>(path: string): Promise<T | null> => {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export const createFetchCache = (rootDir: string): FetchCache => ({
  read: async (sourceId) => safeReadJson<FetchCacheEntry>(metadataPath(rootDir, sourceId)),
  write: async (entry, body) => {
    const body256 = sha256Hex(body)
    if (body256 !== entry.sha256) {
      throw new Error(`fetch-cache: sha256 mismatch for source ${entry.sourceId} — expected ${entry.sha256}, got ${body256}`)
    }
    const finalBodyPath = bodyPath(rootDir, entry.sourceId, body256)
    const entryWithPath: FetchCacheEntry = { ...entry, path: finalBodyPath }
    await atomicWriteFile(finalBodyPath, body)
    await atomicWriteFile(metadataPath(rootDir, entry.sourceId), JSON.stringify(entryWithPath, null, 2))
  },
})

export const buildCacheEntry = (config: {
  readonly sourceId: SourceId
  readonly body: RawBytes
  readonly etag: string | null
  readonly lastModified: string | null
  readonly fetchedAt?: Date
}): FetchCacheEntry => ({
  sourceId: config.sourceId,
  etag: config.etag,
  lastModified: config.lastModified,
  sha256: sha256Hex(config.body),
  fetchedAt: asIso8601((config.fetchedAt ?? new Date()).toISOString()),
  path: '',
})

export const conditionalGetHeaders = (entry: FetchCacheEntry | null): Record<string, string> => {
  if (!entry) return {}
  const headers: Record<string, string> = {}
  if (entry.etag) headers['If-None-Match'] = entry.etag
  if (entry.lastModified) headers['If-Modified-Since'] = entry.lastModified
  return headers
}
