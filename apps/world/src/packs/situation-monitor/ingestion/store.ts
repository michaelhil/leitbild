import { Database } from 'bun:sqlite'
import { mkdirSync, statSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { z } from 'zod'
import { externalRecordSchema, geometryBounds, longitudeIntervals, recordSearchSchema, type ExternalRecord, type SituationConfig } from '../model.ts'

export interface CollectionMetadata { etag?: string | undefined; modifiedSince?: string | undefined; bodyHash?: string | undefined; lastSuccessAt?: string | undefined; nextAttemptAt?: string | undefined }
interface RecordRow { payload: string }
export const openRecordStore = (path: string, limits = { maxBytes: 128 * 1024 ** 2, maxRecords: 50000, minFreeBytes: 1024 ** 3 }) => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true, strict: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA auto_vacuum = INCREMENTAL')
  db.run('PRAGMA busy_timeout = 2000')
  db.run('PRAGMA wal_autocheckpoint = 256')
  db.run('CREATE TABLE IF NOT EXISTS collections (key TEXT PRIMARY KEY, metadata TEXT NOT NULL)')
  db.run('CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, expires INTEGER NOT NULL, time TEXT NOT NULL, search TEXT NOT NULL, west REAL, south REAL, east REAL, north REAL, PRIMARY KEY(collection,id))')
  db.run('CREATE INDEX IF NOT EXISTS records_expiry ON records(expires)')
  db.run('CREATE INDEX IF NOT EXISTS records_time ON records(collection,time DESC)')
  const size = (): number => path === ':memory:' ? 0 : ['', '-wal', '-shm'].reduce((total, suffix) => {
    try { return total + statSync(path + suffix).size } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return total; throw error }
  }, 0)
  const cleanup = (now = Date.now()) => {
    db.query('DELETE FROM records WHERE expires < ?').run(now)
    db.run('DELETE FROM collections WHERE key NOT IN (SELECT DISTINCT collection FROM records)')
    db.run('PRAGMA wal_checkpoint(PASSIVE)')
    db.run('PRAGMA incremental_vacuum(256)')
  }
  cleanup()
  return {
    metadata: (key: string): CollectionMetadata => {
      const row = db.query<{ metadata: string }, [string]>('SELECT metadata FROM collections WHERE key=?').get(key)
      return row ? JSON.parse(row.metadata) as CollectionMetadata : {}
    },
    setMetadata: (key: string, value: CollectionMetadata) => { db.query('INSERT INTO collections VALUES (?,?) ON CONFLICT(key) DO UPDATE SET metadata=excluded.metadata').run(key, JSON.stringify(value)) },
    replace: (key: string, records: ReadonlyArray<ExternalRecord>, hours: number, snapshot: boolean) => {
      cleanup()
      const bytes = records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0)
      if (path !== ':memory:') {
        const disk = statfsSync(dirname(path))
        if (size() + bytes * 3 > limits.maxBytes || disk.bavail * disk.bsize - bytes * 3 < limits.minFreeBytes) throw new Error('Situation Monitor storage budget reached; collection paused until space is available')
      }
      const count = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM records').get()!.count
      const existing = db.query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM records WHERE collection=?').get(key)!.count
      if (count - (snapshot ? existing : 0) + records.length > limits.maxRecords) throw new Error('Situation Monitor record budget reached; reduce retention or source volume')
      const save = db.query('INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload,expires=excluded.expires,time=excluded.time,search=excluded.search,west=excluded.west,south=excluded.south,east=excluded.east,north=excluded.north')
      db.transaction(() => {
        if (snapshot) db.query('DELETE FROM records WHERE collection=?').run(key)
        for (const record of records) {
          const bounds = record.geometry ? geometryBounds(record.geometry) : [null, null, null, null]
          save.run(key, record.id, JSON.stringify(record), Date.now() + hours * 3600000, new Date(record.validAt ?? record.publishedAt ?? record.retrievedAt).toISOString(), (record.title + ' ' + record.summary).toLocaleLowerCase(), bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!)
        }
      })()
    },
    search: (sources: ReadonlyArray<{ id: string; key: string }>, input: z.infer<typeof recordSearchSchema>, areas: SituationConfig['areas']) => {
      const selected = sources.filter(source => !input.sourceId || source.id === input.sourceId)
      if (!selected.length) return { records: [], total: 0, hasMore: false, retainedWindowOnly: true as const }
      const params: (string | number)[] = selected.flatMap(source => [source.key, source.id])
      const conditions = ['r.expires >= ?']; params.push(Date.now())
      if (input.text) { conditions.push('instr(r.search, ?) > 0'); params.push(input.text.toLocaleLowerCase()) }
      if (input.from) { conditions.push('r.time >= ?'); params.push(new Date(input.from).toISOString()) }
      if (input.to) { conditions.push('r.time <= ?'); params.push(new Date(input.to).toISOString()) }
      const areaSql = (bounds: readonly [number,number,number,number]) => {
        params.push(bounds[3], bounds[1])
        const longitudes = longitudeIntervals(bounds[0], bounds[2]).map(interval => { params.push(interval[1], interval[0]); return '(r.west <= ? AND r.east >= ?)' })
        return '(r.south <= ? AND r.north >= ? AND (' + longitudes.join(' OR ') + '))'
      }
      if (input.bounds) conditions.push(areaSql(input.bounds))
      if (areas.length) conditions.push('(r.west IS NULL OR ' + areas.map(area => areaSql(area.bounds)).join(' OR ') + ')')
      const from = 'WITH selected(collection,sourceId) AS (VALUES ' + selected.map(() => '(?,?)').join(',') + ') '
      const where = ' FROM records r JOIN selected s ON s.collection=r.collection WHERE ' + conditions.join(' AND ')
      const total = (db.query(from + 'SELECT COUNT(*) AS count' + where).get(...params) as { count: number }).count
      const rows = db.query(from + 'SELECT r.payload, s.sourceId' + where + ' ORDER BY r.time DESC,s.sourceId,r.id LIMIT ? OFFSET ?').all(...params, input.limit, input.offset) as { payload: string; sourceId: string }[]
      return { records: rows.map(row => ({ ...externalRecordSchema.parse(JSON.parse(row.payload)), sourceId: row.sourceId })), total, hasMore: input.offset + input.limit < total, retainedWindowOnly: true as const }
    },
    inspect: (key: string, id: string): ExternalRecord | null => {
      const row = db.query<RecordRow,[string,string,number]>('SELECT payload FROM records WHERE collection=? AND id=? AND expires>=?').get(key,id,Date.now())
      return row ? externalRecordSchema.parse(JSON.parse(row.payload)) : null
    },
    count: (key: string) => db.query<{ count: number }, [string, number]>('SELECT COUNT(*) AS count FROM records WHERE collection=? AND expires>=?').get(key, Date.now())!.count,
    touch: (key: string, hours: number) => { db.query('UPDATE records SET expires=? WHERE collection=?').run(Date.now() + hours * 3600000, key) },
    stats: () => ({ bytes: size(), maxBytes: limits.maxBytes, maxRecords: limits.maxRecords }),
    cleanup,
    close: () => { cleanup(); db.run('PRAGMA wal_checkpoint(TRUNCATE)'); db.close() },
  }
}
export type RecordStore = ReturnType<typeof openRecordStore>
