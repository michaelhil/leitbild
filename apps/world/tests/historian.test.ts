import { describe, expect, test } from 'bun:test'
import { createRunHistorian } from '../src/features/historian/store.ts'
import type { IsoTimestamp } from '../src/core/model/index.ts'

const at = (value: string): IsoTimestamp => value as IsoTimestamp

describe('Run Historian', () => {
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

      expect(historian.status()).toEqual({
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
      expect(historian.query({ subjectId: 'plant:test', signalId: 'core.tripped' })).toEqual([expect.objectContaining({
        seriesId: 'series:trip',
        value: false,
        elapsedMs: 1_000,
      })])
      expect(historian.query({ from: '2026-01-01T00:00:02.000Z' })).toEqual([])
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
