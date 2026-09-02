import { describe, expect, test } from 'bun:test'
import { createRunHistorian } from '../src/features/historian/store.ts'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const at = (value: string): IsoTimestamp => value as IsoTimestamp

describe('Run Historian', () => {
  test('an existing oversized history remains queryable and untouched, including retention', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'historian-budget-'))
    const path = join(dir, 'history.sqlite')
    try {
      const descriptor = { id: 'series:text', subjectId: 'asset', signalId: 'text', title: 'Text', valueType: 'string' as const }
      const original = createRunHistorian(path, { limits: { minFreeBytes: 0 } })
      original.record('test', { descriptors: [descriptor], samples: Array.from({ length: 200 }, () => ({ seriesId: descriptor.id, observedAt: at('2026-01-01T00:00:00.000Z'), value: 'x'.repeat(1000), quality: 'good' as const })) })
      original.close()
      expect((await stat(path)).size).toBeGreaterThan(64 * 1024)
      const before = await readFile(path)
      const limited = createRunHistorian(path, { limits: { maxBytes: 64 * 1024, maxSamples: 1, minFreeBytes: 0 } })
      try {
        limited.record('test', { descriptors: [], samples: [{ seriesId: descriptor.id, observedAt: at(new Date().toISOString()), value: 'new', quality: 'good' }] })
        expect(limited.status()).toMatchObject({ sampleCount: 200, captureState: 'limited', discardedSinceOpen: 1 })
        expect(limited.query({ limit: 1 }).samples).toHaveLength(1)
      } finally { limited.close() }
      expect(await readFile(path)).toEqual(before)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  test('rejects changed units and mismatched value types atomically', () => {
    const historian = createRunHistorian(':memory:')
    const descriptor = { id: 'series:power', subjectId: 'plant', signalId: 'power', title: 'Power', valueType: 'number' as const, unit: 'MW' }
    historian.record('plant.local', { descriptors: [descriptor], samples: [] })
    expect(() => historian.record('plant.local', { descriptors: [{ ...descriptor, unit: 'kW' }], samples: [] })).toThrow('semantics changed')
    expect(() => historian.record('plant.local', { descriptors: [], samples: [{ seriesId: descriptor.id, value: 'oops', observedAt: at(new Date().toISOString()), quality: 'good' }] })).toThrow('does not match')
    expect(historian.status().sampleCount).toBe(0)
    historian.close()
  })

  test('retains a bounded recent window and paginates equal times by sequence on either time axis', () => {
    let now = Date.parse('2026-01-01T00:00:10.000Z')
    const historian = createRunHistorian(':memory:', { limits: { maxSamples: 3, maxAgeMs: 20_000 }, now: () => now })
    const observedAt = at('2026-01-01T00:00:10.000Z')
    const simulationTime = at('2026-01-01T10:00:10.000Z')
    historian.record('test.local', { descriptors: [{ id: 'series:value', subjectId: 'asset', signalId: 'value', title: 'Value', valueType: 'number' }], samples: [1, 2, 3, 4, 5].map(value => ({ seriesId: 'series:value', observedAt, simulationTime, value, quality: 'good' })) })
    expect(historian.status()).toMatchObject({ sampleCount: 3, discardedSinceOpen: 2 })
    const page = historian.query({ limit: 2, timeAxis: 'simulation', from: '2026-01-01T12:00:00+02:00' })
    expect(page.samples.map(sample => sample.value)).toEqual([5, 4])
    expect(page.hasMore).toBe(true)
    expect(historian.query({ beforeSequence: page.nextBeforeSequence! }).samples.map(sample => sample.value)).toEqual([3])
    expect(historian.query({ beforeSequence: 2 }).retentionGap).toBe(true)
    now += 30_000
    historian.record('test.local', { descriptors: [], samples: [{ seriesId: 'series:value', observedAt: at(new Date(now).toISOString()), value: 6, quality: 'good' }] })
    expect(historian.status()).toMatchObject({ sampleCount: 1, discardedSinceOpen: 5 })
    historian.close()
  })
  test('persists typed samples, exposes descriptors, and applies bounded filters', () => {
    const historian = createRunHistorian(':memory:')
    try {
      historian.record('process-plant.local', {
        descriptors: [{
          id: 'series:power',
          subjectId: 'plant:test',
          signalId: 'core.totalThermalPowerMw',
          title: 'Test Plant · Thermal power',
          valueType: 'number',
          quantity: 'power',
          unit: 'MW',
        }, {
          id: 'series:trip',
          subjectId: 'plant:test',
          signalId: 'core.tripped',
          title: 'Test Plant · Reactor trip',
          valueType: 'boolean',
          quantity: 'boolean',
          unit: 'boolean',
        }],
        samples: [{
          seriesId: 'series:power',
          observedAt: at('2026-01-01T00:00:01.000Z'),
          simulationTime: at('2026-01-01T10:00:01.000Z'),
          elapsedMs: 1_000,
          value: 2_980,
          quality: 'good',
        }, {
          seriesId: 'series:trip',
          observedAt: at('2026-01-01T00:00:01.000Z'),
          simulationTime: at('2026-01-01T10:00:01.000Z'),
          elapsedMs: 1_000,
          value: false,
          quality: 'good',
        }],
      })

      expect(historian.status()).toMatchObject({
        seriesCount: 2,
        sampleCount: 2,
        firstObservedAt: '2026-01-01T00:00:01.000Z',
        lastObservedAt: '2026-01-01T00:00:01.000Z',
      })
      expect(historian.listSeries()).toContainEqual(expect.objectContaining({
        runtimeId: 'process-plant.local',
        id: 'series:power',
        subjectId: 'plant:test',
        unit: 'MW',
      }))
      expect(historian.query({ subjectId: 'plant:test', signalId: 'core.tripped' }).samples).toEqual([expect.objectContaining({
        seriesId: 'series:trip',
        value: false,
        elapsedMs: 1_000,
      })])
      expect(historian.query({ from: '2026-01-01T00:00:02.000Z' }).samples).toEqual([])
    } finally {
      historian.close()
    }
  })

  test('rejects samples whose series has not been described', () => {
    const historian = createRunHistorian(':memory:')
    try {
      expect(() => historian.record('process-plant.local', {
        descriptors: [],
        samples: [{
          seriesId: 'series:missing',
          observedAt: at('2026-01-01T00:00:01.000Z'),
          value: 1,
          quality: 'good',
        }],
      })).toThrow()
    } finally {
      historian.close()
    }
  })
})
