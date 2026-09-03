import { Database } from 'bun:sqlite'
import { mkdirSync, statSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { z } from 'zod'
import { externalRecordSchema, geometryBounds, longitudeIntervals, recordSearchSchema, type ExternalRecord, type SituationConfig } from '../model.ts'

export interface CollectionMetadata {
  etag?: string | undefined; modifiedSince?: string | undefined; bodyHash?: string | undefined
  lastSuccessAt?: string | undefined; lastAttemptAt?: string | undefined; nextAttemptAt?: string | undefined
  error?: string | undefined; failures?: number | undefined
}

/** A bounded cache of complete provider snapshots, not an archive. Empty snapshots are also cache hits. */
export const openRecordStore = (path: string, limits = { maxBytes: 128 * 1024 ** 2, maxRecords: 50000, minFreeBytes: 1024 ** 3 }) => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true, strict: true })
  db.run('PRAGMA auto_vacuum = INCREMENTAL')
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA busy_timeout = 2000')
  db.run('PRAGMA wal_autocheckpoint = 256')
  db.run('CREATE TABLE IF NOT EXISTS collections (key TEXT PRIMARY KEY, metadata TEXT NOT NULL, expires INTEGER NOT NULL DEFAULT 0, keepUntil INTEGER NOT NULL)')
  db.run('CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, time INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, search TEXT NOT NULL, west REAL, south REAL, east REAL, north REAL, PRIMARY KEY(collection,id))')
  db.run('CREATE INDEX IF NOT EXISTS records_time ON records(collection,time DESC)')
  const size = (): number => path === ':memory:' ? 0 : ['', '-wal', '-shm'].reduce((total, suffix) => {
    try { return total + statSync(path + suffix).size } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return total; throw error }
  }, 0)
  let lastCleanup = 0
  const cleanup = (now = Date.now(), force = false) => {
    if (!force && now - lastCleanup < 60000) return
    lastCleanup = now
    db.query('DELETE FROM records WHERE collection IN (SELECT key FROM collections WHERE expires < ?)').run(now)
    db.query('DELETE FROM collections WHERE keepUntil < ? AND expires < ?').run(now, now)
    db.run('PRAGMA wal_checkpoint(PASSIVE)')
    db.run('PRAGMA incremental_vacuum(256)')
  }
  cleanup()
  const ensureCollection = (key: string) => {
    const count = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM collections').get()!.count
    if (count >= 2000 && !db.query('SELECT key FROM collections WHERE key=?').get(key)) throw new Error('Situation Monitor collection budget reached')
    db.query("INSERT OR IGNORE INTO collections(key,metadata,keepUntil) VALUES (?,'{}',?)").run(key, Date.now() + 86400000)
  }
  return {
    metadata: (key: string): CollectionMetadata => {
      const row = db.query<{ metadata: string }, [string]>('SELECT metadata FROM collections WHERE key=?').get(key)
      return row ? JSON.parse(row.metadata) as CollectionMetadata : {}
    },
    setMetadata: (key: string, value: CollectionMetadata) => {
      ensureCollection(key)
      db.query('UPDATE collections SET metadata=?, keepUntil=? WHERE key=?').run(JSON.stringify(value), Math.max(Date.now() + 86400000, Date.parse(value.nextAttemptAt ?? '') || 0), key)
    },
    hasSnapshot: (key: string): boolean => !!db.query('SELECT key FROM collections WHERE key=? AND expires>=?').get(key, Date.now()),
    replace: (key: string, records: ReadonlyArray<ExternalRecord>, hours: number) => {
      cleanup()
      const rows = records.map(record => ({ record, payload: JSON.stringify(record) }))
      const bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0)
      if (path !== ':memory:') {
        const disk = statfsSync(dirname(path))
        if (size() + bytes * 3 > limits.maxBytes || disk.bavail * disk.bsize - bytes * 3 < limits.minFreeBytes) throw new Error('Situation Monitor storage budget reached; collection paused until space is available')
      }
      const count = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM records').get()!.count
      const existing = db.query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM records WHERE collection=?').get(key)!.count
      if (count - existing + records.length > limits.maxRecords) throw new Error('Situation Monitor record budget reached; reduce source volume')
      const save = db.query('INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      db.transaction(() => {
        ensureCollection(key)
        db.query('DELETE FROM records WHERE collection=?').run(key)
        for (const { record, payload } of rows) {
          const bounds = record.geometry ? geometryBounds(record.geometry) : [null, null, null, null]
          save.run(key, record.id, payload, Date.parse(record.validAt ?? record.observedAt ?? record.publishedAt ?? record.retrievedAt), record.kind, record.subject?.id ?? '', (record.title + ' ' + record.summary).toLocaleLowerCase(), bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!)
        }
        db.query('UPDATE collections SET expires=? WHERE key=?').run(Date.now() + hours * 3600000, key)
      })()
    },
    search: (sources: ReadonlyArray<{ id: string; key: string }>, input: z.infer<typeof recordSearchSchema>, areas: SituationConfig['areas'], mapAt?: number) => {
      const selected = sources.filter(source => !input.sourceId || source.id === input.sourceId)
      if (!selected.length) return { records: [], total: 0, hasMore: false, retainedWindowOnly: true as const }
      const params: (string | number)[] = selected.flatMap(source => [source.key, source.id])
      const conditions = ['c.expires >= ?']; params.push(Date.now())
      if (input.subjectId) { conditions.push('r.subject=?'); params.push(input.subjectId) }
      if (input.text) { conditions.push('instr(r.search, ?) > 0'); params.push(input.text.toLocaleLowerCase()) }
      if (input.from) { conditions.push('r.time >= ?'); params.push(Date.parse(input.from)) }
      if (input.to) { conditions.push('r.time <= ?'); params.push(Date.parse(input.to)) }
      const areaSql = (bounds: readonly [number,number,number,number]) => {
        params.push(bounds[3], bounds[1])
        const longitudes = longitudeIntervals(bounds[0], bounds[2]).map(interval => { params.push(interval[1], interval[0]); return '(r.west <= ? AND r.east >= ?)' })
        return '(r.south <= ? AND r.north >= ? AND (' + longitudes.join(' OR ') + '))'
      }
      if (input.bounds) conditions.push(areaSql(input.bounds))
      if (areas.length) conditions.push('(r.west IS NULL OR ' + areas.map(area => areaSql(area.bounds)).join(' OR ') + ')')
      let cte = 'WITH selected(collection,sourceId) AS (VALUES ' + selected.map(() => '(?,?)').join(',') + '), filtered AS (SELECT r.*, s.sourceId FROM records r JOIN selected s ON s.collection=r.collection JOIN collections c ON c.key=r.collection WHERE ' + conditions.join(' AND ') + ')'
      let table = 'filtered', order = 'time DESC,sourceId,id'
      if (mapAt !== undefined) {
        // Reduce forecast samples before LIMIT; round-robin sources so one dense catalogue cannot hide others.
        cte += ", ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY sourceId,kind,CASE WHEN kind='forecast' THEN subject ELSE id END ORDER BY ABS(time-?),id) AS sample FROM filtered), visible AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY sourceId ORDER BY time DESC,id) AS slot FROM ranked WHERE sample=1)"
        params.push(mapAt); table = 'visible'; order = 'slot,sourceId,id'
      }
      const total = (db.query(cte + ' SELECT COUNT(*) AS count FROM ' + table).get(...params) as { count: number }).count
      const rows = db.query(cte + ' SELECT payload,sourceId FROM ' + table + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?').all(...params, input.limit, input.offset) as { payload: string; sourceId: string }[]
      return { records: rows.map(row => ({ ...externalRecordSchema.parse(JSON.parse(row.payload)), sourceId: row.sourceId })), total, hasMore: input.offset + input.limit < total, retainedWindowOnly: true as const }
    },
    inspect: (key: string, id: string): ExternalRecord | null => {
      const row = db.query<{ payload: string },[string,string,number]>('SELECT payload FROM records r JOIN collections c ON c.key=r.collection WHERE collection=? AND id=? AND c.expires>=?').get(key,id,Date.now())
      return row ? externalRecordSchema.parse(JSON.parse(row.payload)) : null
    },
    count: (key: string) => db.query<{ count: number }, [string, number]>('SELECT COUNT(*) AS count FROM records r JOIN collections c ON c.key=r.collection WHERE collection=? AND c.expires>=?').get(key, Date.now())!.count,
    touch: (key: string, hours: number) => { db.query('UPDATE collections SET expires=? WHERE key=?').run(Date.now() + hours * 3600000, key) },
    stats: () => ({ bytes: size(), maxBytes: limits.maxBytes, maxRecords: limits.maxRecords }),
    cleanup,
    close: () => { cleanup(Date.now(), true); db.run('PRAGMA wal_checkpoint(TRUNCATE)'); db.close() },
  }
}
export type RecordStore = ReturnType<typeof openRecordStore>
