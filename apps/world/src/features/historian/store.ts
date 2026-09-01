import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import {
  packRuntimeRecordingBatchSchema,
  type PackRuntimeRecordingBatch,
  type RecordedSample,
  type RecordingSeriesDescriptor,
  type RecordingSeriesQuery,
} from '../../core/model/index.ts'

interface SeriesRow {
  readonly runtime_id: string
  readonly series_id: string
  readonly subject_id: string
  readonly signal_id: string
  readonly title: string
  readonly value_type: RecordingSeriesDescriptor['valueType']
  readonly quantity: string | null
  readonly unit: string | null
}

interface SampleRow {
  readonly runtime_id: string
  readonly series_id: string
  readonly observed_at: string
  readonly simulation_time: string | null
  readonly elapsed_ms: number | null
  readonly value_type: 'number' | 'boolean' | 'string'
  readonly value_number: number | null
  readonly value_text: string | null
  readonly value_boolean: number | null
  readonly quality: RecordedSample['quality']
}

export interface RunHistorianStatus {
  readonly seriesCount: number
  readonly sampleCount: number
  readonly firstObservedAt: string | null
  readonly lastObservedAt: string | null
}

export interface RunHistorian {
  readonly record: (runtimeId: string, batch: PackRuntimeRecordingBatch) => void
  readonly listSeries: () => ReadonlyArray<RecordingSeriesDescriptor & { readonly runtimeId: string }>
  readonly query: (query: RecordingSeriesQuery) => ReadonlyArray<RecordedSample>
  readonly status: () => RunHistorianStatus
  readonly close: () => void
}

const currentSchema = 1

const valueColumns = (value: RecordedSample['value']): {
  readonly type: 'number' | 'boolean' | 'string'
  readonly number: number | null
  readonly text: string | null
  readonly boolean: number | null
} => typeof value === 'number'
  ? { type: 'number', number: value, text: null, boolean: null }
  : typeof value === 'boolean'
    ? { type: 'boolean', number: null, text: null, boolean: value ? 1 : 0 }
    : { type: 'string', number: null, text: value, boolean: null }

const valueFromRow = (row: SampleRow): RecordedSample['value'] => {
  if (row.value_type === 'number' && row.value_number !== null) return row.value_number
  if (row.value_type === 'boolean' && row.value_boolean !== null) return row.value_boolean === 1
  if (row.value_type === 'string' && row.value_text !== null) return row.value_text
  throw new Error(`historian sample ${row.runtime_id}/${row.series_id} has invalid ${row.value_type} storage`)
}

const descriptorFromRow = (row: SeriesRow): RecordingSeriesDescriptor & { readonly runtimeId: string } => ({
  runtimeId: row.runtime_id,
  id: row.series_id,
  subjectId: row.subject_id,
  signalId: row.signal_id,
  title: row.title,
  valueType: row.value_type,
  ...(row.quantity === null ? {} : { quantity: row.quantity }),
  ...(row.unit === null ? {} : { unit: row.unit }),
})

export const createRunHistorian = (path: string): RunHistorian => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const database = new Database(path, { create: true, strict: true })
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA journal_mode = WAL')
  const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
  if (version === 0) {
    database.exec(`
      CREATE TABLE recording_series (
        runtime_id TEXT NOT NULL,
        series_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        title TEXT NOT NULL,
        value_type TEXT NOT NULL CHECK (value_type IN ('number', 'boolean', 'string')),
        quantity TEXT,
        unit TEXT,
        PRIMARY KEY (runtime_id, series_id)
      );
      CREATE TABLE recording_samples (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        runtime_id TEXT NOT NULL,
        series_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        simulation_time TEXT,
        elapsed_ms INTEGER,
        value_type TEXT NOT NULL CHECK (value_type IN ('number', 'boolean', 'string')),
        value_number REAL,
        value_text TEXT,
        value_boolean INTEGER CHECK (value_boolean IN (0, 1)),
        quality TEXT NOT NULL CHECK (quality IN ('good', 'uncertain', 'bad')),
        FOREIGN KEY (runtime_id, series_id) REFERENCES recording_series(runtime_id, series_id)
      );
      CREATE INDEX recording_samples_series_time
        ON recording_samples(runtime_id, series_id, observed_at, sequence);
      CREATE INDEX recording_samples_subject_time
        ON recording_samples(runtime_id, observed_at, sequence);
      PRAGMA user_version = 1;
    `)
  } else if (version !== currentSchema) {
    database.close()
    throw new Error(`unsupported historian schema: ${version}`)
  }

  const insertSeries = database.prepare(`
    INSERT INTO recording_series (
      runtime_id, series_id, subject_id, signal_id, title, value_type, quantity, unit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(runtime_id, series_id) DO NOTHING
  `)
  const insertSample = database.prepare(`
    INSERT INTO recording_samples (
      runtime_id, series_id, observed_at, simulation_time, elapsed_ms,
      value_type, value_number, value_text, value_boolean, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const writeBatch = database.transaction((runtimeId: string, batch: PackRuntimeRecordingBatch): void => {
    for (const descriptor of batch.descriptors) {
      insertSeries.run(
        runtimeId,
        descriptor.id,
        descriptor.subjectId,
        descriptor.signalId,
        descriptor.title,
        descriptor.valueType,
        descriptor.quantity ?? null,
        descriptor.unit ?? null,
      )
    }
    for (const sample of batch.samples) {
      const value = valueColumns(sample.value)
      insertSample.run(
        runtimeId,
        sample.seriesId,
        sample.observedAt,
        sample.simulationTime ?? null,
        sample.elapsedMs ?? null,
        value.type,
        value.number,
        value.text,
        value.boolean,
        sample.quality,
      )
    }
  })

  return {
    record: (runtimeId, input): void => {
      const batch = packRuntimeRecordingBatchSchema.parse(input) as PackRuntimeRecordingBatch
      if (batch.samples.length === 0 && batch.descriptors.length === 0) return
      writeBatch(runtimeId, batch)
    },
    listSeries: (): ReadonlyArray<RecordingSeriesDescriptor & { readonly runtimeId: string }> =>
      database.query<SeriesRow, []>(`
        SELECT runtime_id, series_id, subject_id, signal_id, title, value_type, quantity, unit
        FROM recording_series
        ORDER BY runtime_id, subject_id, signal_id
      `).all().map(descriptorFromRow),
    query: (query): ReadonlyArray<RecordedSample> => {
      const predicates: string[] = []
      const values: Array<string | number> = []
      for (const [column, value] of [
        ['runtime_id', query.runtimeId],
        ['series_id', query.seriesId],
      ] as const) {
        if (value === undefined) continue
        predicates.push(`${column} = ?`)
        values.push(value)
      }
      if (query.subjectId !== undefined || query.signalId !== undefined) {
        predicates.push(`EXISTS (
          SELECT 1 FROM recording_series series
          WHERE series.runtime_id = recording_samples.runtime_id
            AND series.series_id = recording_samples.series_id
            ${query.subjectId === undefined ? '' : 'AND series.subject_id = ?'}
            ${query.signalId === undefined ? '' : 'AND series.signal_id = ?'}
        )`)
        if (query.subjectId !== undefined) values.push(query.subjectId)
        if (query.signalId !== undefined) values.push(query.signalId)
      }
      if (query.from !== undefined) { predicates.push('observed_at >= ?'); values.push(query.from) }
      if (query.to !== undefined) { predicates.push('observed_at <= ?'); values.push(query.to) }
      const limit = Math.min(10_000, Math.max(1, query.limit ?? 2_000))
      values.push(limit)
      const rows = database.query<SampleRow, Array<string | number>>(`
        SELECT runtime_id, series_id, observed_at, simulation_time, elapsed_ms,
               value_type, value_number, value_text, value_boolean, quality
        FROM recording_samples
        ${predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`}
        ORDER BY observed_at, sequence
        LIMIT ?
      `).all(...values)
      return rows.map(row => ({
        runtimeId: row.runtime_id,
        seriesId: row.series_id,
        observedAt: row.observed_at as RecordedSample['observedAt'],
        ...(row.simulation_time === null ? {} : { simulationTime: row.simulation_time as RecordedSample['simulationTime'] }),
        ...(row.elapsed_ms === null ? {} : { elapsedMs: row.elapsed_ms }),
        value: valueFromRow(row),
        quality: row.quality,
      }))
    },
    status: (): RunHistorianStatus => {
      const row = database.query<{
        series_count: number
        sample_count: number
        first_observed_at: string | null
        last_observed_at: string | null
      }, []>(`
        SELECT
          (SELECT COUNT(*) FROM recording_series) AS series_count,
          COUNT(*) AS sample_count,
          MIN(observed_at) AS first_observed_at,
          MAX(observed_at) AS last_observed_at
        FROM recording_samples
      `).get()
      return {
        seriesCount: row?.series_count ?? 0,
        sampleCount: row?.sample_count ?? 0,
        firstObservedAt: row?.first_observed_at ?? null,
        lastObservedAt: row?.last_observed_at ?? null,
      }
    },
    close: (): void => database.close(),
  }
}
