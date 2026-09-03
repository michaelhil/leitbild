import { createHash } from 'node:crypto'
import { decodeSource } from '../adapters/decode.ts'
import { minimumIntervalFor, sourceRequestUrl } from '../adapters/catalog.ts'
import { type SituationSource, type SourceStatus } from '../model.ts'
import { publicHttp, type PublicHttp } from './public-http.ts'
import type { RecordStore } from './store.ts'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const credentialFor = (source: SituationSource): string | undefined => {
  if (!source.credentialRef) return undefined
  const value = process.env['LEITBILD_SOURCE_CREDENTIAL_' + source.credentialRef]
  if (!value) throw new Error('Source credential is not configured on the server: ' + source.credentialRef)
  return value
}
export const collectionKey = (source: SituationSource): string => {
  const { id: _id, name: _name, enabled: _enabled, intervalSeconds: _interval, attribution: _attribution, ...request } = source
  const credential = source.credentialRef ? process.env['LEITBILD_SOURCE_CREDENTIAL_' + source.credentialRef] : undefined
  return digest(JSON.stringify(request) + (credential ? digest(credential) : ''))
}
interface Entry {
  source: SituationSource; listeners: Map<symbol, () => void>; status: SourceStatus;
  intervals: Map<symbol, number>; failures: number;
  timer?: ReturnType<typeof setTimeout>; pending?: Promise<void>; abort?: AbortController
}
// One process-wide origin gate. Shared quotas apply even to different Workspaces.
const originNextRequest = new Map<string, number>()
let activeRequests = 0
export const createCollector = (store: RecordStore, http: PublicHttp = publicHttp, withGrowth: (bytes: number, work: () => Promise<void>) => Promise<void> = async (_bytes, work) => await work()) => {
  const entries = new Map<string, Entry>()
  const notify = (entry: Entry) => { for (const listener of entry.listeners.values()) listener() }
  const collect = async (key: string, entry: Entry): Promise<void> => {
    if (entry.pending || !entry.listeners.size) return
    const now = Date.now(), next = entry.status.nextAttemptAt ? Date.parse(entry.status.nextAttemptAt) : 0
    if (now < next) return
    const origin = new URL(sourceRequestUrl(entry.source)).origin
    for (const [key, until] of originNextRequest) if (until <= now) originNextRequest.delete(key)
    const earliest = Math.max(originNextRequest.get(origin) ?? 0, activeRequests >= 4 ? now + 1000 : now)
    if (earliest > now) { entry.status.nextAttemptAt = new Date(earliest).toISOString(); return }
    originNextRequest.set(origin, now + 1000) // At most one start/second/origin, four requests in flight.
    entry.abort = new AbortController()
    activeRequests++
    entry.status = { ...entry.status, state: 'loading', lastAttemptAt: new Date(now).toISOString(), error: null }
    notify(entry)
    entry.pending = (async () => {
      const metadata = store.metadata(key)
      let waitSeconds = Math.max(entry.source.intervalSeconds, minimumIntervalFor(entry.source))
      try {
        const cached = store.count(key) > 0
        const response = entry.source.adapter === 'media' ? { status: 200, text: '', headers: {} as Readonly<Record<string, string>> } : await http(sourceRequestUrl(entry.source), { signal: entry.abort!.signal, etag: cached ? metadata.etag : undefined, modifiedSince: cached ? metadata.modifiedSince : undefined, bearer: credentialFor(entry.source) })
        if (!entry.listeners.size) return // Last lease closed while the request was in flight.
        const retry = response.headers['retry-after']
        if (retry) {
          const delay = /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000
          if (Number.isFinite(delay)) waitSeconds = Math.max(waitSeconds, Math.min(86400, delay))
        }
        const maxAge = response.headers['cache-control']?.match(/(?:^|,)\s*max-age=(\d+)/)?.[1]
        const expires = response.headers.expires ? Date.parse(response.headers.expires) : NaN
        if (maxAge) waitSeconds = Math.max(waitSeconds, Math.min(86400, Number(maxAge)))
        if (Number.isFinite(expires)) waitSeconds = Math.max(waitSeconds, Math.min(86400, (expires - Date.now()) / 1000))
        if (response.headers['cache-control']?.includes('no-store')) throw new Error('Provider disallows caching; this source cannot be retained by Situation Monitor')
        if (response.status !== 200 && response.status !== 304) throw new Error('Provider HTTP ' + response.status)
        if (response.status === 304 && !cached) throw new Error('Provider returned unchanged content without an available cached body')
        const bodyHash = digest(response.text)
        if (response.status === 200 && (bodyHash !== metadata.bodyHash || store.count(key) === 0)) {
          const records = decodeSource(entry.source, response.text, new Date().toISOString())
          if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('Source contains duplicate record IDs')
          await withGrowth(Buffer.byteLength(JSON.stringify(records)) * 3 + 65536, async () => { if (entry.listeners.size) store.replace(key, records, entry.source.retentionHours, true) })
        }
        if (!entry.listeners.size) return
        store.touch(key, entry.source.retentionHours)
        const lastSuccessAt = new Date().toISOString()
        const nextAttemptAt = new Date(Date.now() + waitSeconds * 1000 + Math.random() * 3000).toISOString()
        store.setMetadata(key, { etag: response.headers.etag ?? metadata.etag, modifiedSince: response.headers['last-modified'] ?? metadata.modifiedSince, bodyHash: response.status === 200 ? bodyHash : metadata.bodyHash, lastSuccessAt, nextAttemptAt })
        entry.status = { ...entry.status, state: 'ready', lastSuccessAt, nextAttemptAt, recordCount: store.count(key), error: null }
        entry.failures = 0
      } catch (error) {
        if (!entry.listeners.size) return
        entry.failures++
        waitSeconds = Math.max(waitSeconds, Math.min(3600, 30 * 2 ** Math.min(entry.failures, 7)))
        entry.status = { ...entry.status, state: 'error', nextAttemptAt: new Date(Date.now() + waitSeconds * 1000).toISOString(), error: error instanceof Error ? error.message : String(error) }
      } finally { notify(entry) }
    })().finally(() => { activeRequests--; delete entry.pending; delete entry.abort })
    await entry.pending
  }
  const schedule = (key: string, entry: Entry): void => {
    if (!entry.listeners.size) return
    const wait = Math.max(1000, (entry.status.nextAttemptAt ? Date.parse(entry.status.nextAttemptAt) : 0) - Date.now())
    entry.timer = setTimeout(async () => { await collect(key, entry); schedule(key, entry) }, Math.min(wait, 86400000))
  }
  return {
    acquire: (source: SituationSource, onChange: () => void) => {
      const key = collectionKey(source), token = Symbol(source.id)
      let entry = entries.get(key)
      if (!entry) {
        const metadata = store.metadata(key)
        entry = { source, listeners: new Map(), intervals: new Map(), failures: 0, status: { sourceId: source.id, state: metadata.lastSuccessAt ? 'stale' : 'idle', lastAttemptAt: null, lastSuccessAt: metadata.lastSuccessAt ?? null, nextAttemptAt: metadata.nextAttemptAt ?? null, recordCount: store.count(key), error: null } }
        entries.set(key, entry)
      }
      entry.listeners.set(token, onChange)
      entry.intervals.set(token, source.intervalSeconds)
      entry.source = { ...entry.source, intervalSeconds: Math.min(...entry.intervals.values()) }
      if (entry.listeners.size === 1) { void collect(key, entry); schedule(key, entry) }
      const acquired = entry
      return {
        key,
        intervalSeconds: source.intervalSeconds,
        status: (): SourceStatus => ({ ...acquired.status, sourceId: source.id }),
        refresh: async () => { await collect(key, acquired) },
        release: async () => {
          acquired.listeners.delete(token)
          acquired.intervals.delete(token)
          if (acquired.listeners.size) { acquired.source = { ...acquired.source, intervalSeconds: Math.min(...acquired.intervals.values()) }; return }
          clearTimeout(acquired.timer); acquired.abort?.abort()
          await acquired.pending
          if (!acquired.listeners.size && entries.get(key) === acquired) entries.delete(key)
        },
      }
    },
    close: async () => {
      const pending: Promise<void>[] = []
      for (const entry of entries.values()) { entry.listeners.clear(); clearTimeout(entry.timer); entry.abort?.abort(); if (entry.pending) pending.push(entry.pending) }
      await Promise.all(pending); entries.clear(); store.close()
    },
  }
}
