import { describe, expect, test } from 'bun:test'
import type { AlertState } from '../src/core/model/alerts.ts'
import type { ObjectId } from '../src/core/model/ids.ts'
import { annunciationSchema, type Annunciation } from '../src/core/observation/annunciation.ts'
import { annunciatedRows, expectedAfterFirstOut } from '../src/features/displays/alerts/annunciated.ts'
import type { AlertRow } from '../src/features/displays/alerts/rows.ts'

// Alert rows as their Pack annunciates them (plan v5 W2.3), per sample from
// the alert slot's facets and the Pack's static annunciation: expected after a
// first-out inside its declared window, its tag, group label, category and
// own state. OLD's expectedAfter test (process-plant-composed-display.test.ts
// at 724ae2ac8) is re-expressed here over the alert slot.

const t0 = Date.parse('2026-07-12T04:00:00.000Z')
const iso = (seconds: number) => new Date(t0 + seconds * 1000).toISOString()
const row = (id: string, seconds: number, extra: Partial<AlertState> = {}, rowExtra: Partial<AlertRow> = {}): AlertRow => ({
  key: `unit|${id}`, objectId: 'unit' as ObjectId, objectLabel: 'Unit 1', packId: 'fixture', categoryId: 'unit', group: { objectId: 'unit' as ObjectId },
  alert: { id, kind: 'alarm', severity: 'critical', message: id, raisedAt: iso(seconds) as never, acknowledged: false, priority: 'alarm', clock: 'simulation', ...extra },
  priority: (extra.priority ?? 'alarm') as AlertRow['priority'], state: 'active-unack', raised: { at: iso(seconds) as never, clock: 'simulation' }, ...rowExtra,
})
const window = { group: 'reactor-trip', withinMs: 300_000 }

describe('expected after a first-out, inside its declared window (W2.3)', () => {
  test('what a reactor trip brings in is expected after it, while the initiator and what came in before it stand out', () => {
    // OLD (HMI review of run 23): after SG B's low-low level tripped the reactor, all four generators were red alike.
    const tripB = row('trip:sg-b-rx-trip', 93, { subject: { element: 'sgB' }, firstOut: { group: 'reactor-trip', rank: 1 } })
    const afwB = row('trip:sg-b-afw', 93, { subject: { element: 'sgB' }, firstOut: { group: 'auxiliary-feedwater', rank: 1 } })
    const afwA = row('trip:sg-a-afw', 140, { subject: { element: 'sgA' } })
    const levelLowA = row('alarm:sg-a-level-low', 120, { subject: { element: 'sgA' } })
    const rows = [tripB, afwB, afwA, levelLowA]
    const expected = (entry: AlertRow, now = 150) => expectedAfterFirstOut(entry, rows, window, t0 + now * 1000)
    expect([expected(tripB), expected(afwB), expected(afwA), expected(levelLowA)]).toEqual([false, false, true, true])
    // Before the trip, or coming in past the window after it, nothing is expected.
    expect(expected(row('alarm:sg-a-level-low', 60, { subject: { element: 'sgA' } }))).toBe(false)
    expect(expected(row('trip:sg-a-afw', 93 + 301, { subject: { element: 'sgA' } }), 93 + 302)).toBe(false)
    // Another generator reaching low-low with the one that tripped the reactor is expected after it, not as red as it.
    expect(expected(row('trip:sg-c-rx-trip', 93, { subject: { element: 'sgC' } }))).toBe(true)
    // The first-out's own condition, on its equipment, that came in with it is never expected after it.
    expect(expected(row('alarm:sg-b-level-low', 93, { subject: { element: 'sgB' } }))).toBe(false)
    // Expiry (HMI review of plan v5): still standing past the window from the first-out, it is news again.
    expect(expected(afwA, 93 + 300)).toBe(true)
    expect(expected(afwA, 93 + 301)).toBe(false)
  })

  test('a sample marks each row as its Pack annunciates it: tag, group label, category, expected and own state; rows without a declaration stay as they were', () => {
    const annunciation: Annunciation = annunciationSchema.parse({
      groups: [{ id: 'reactor-trip', label: 'RX TRIP', ends: ['core'] }, { id: 'auxiliary-feedwater', label: 'AFW START' }],
      categories: [{ id: 'rps', label: 'Reactor protection' }, { id: 'sg', label: 'Steam generators' }],
      alerts: [
        { id: 'trip:rx', tag: 'LO · RX TRIP', group: 'reactor-trip', category: 'rps' },
        { id: 'trip:afw-a', tag: 'LO-LO · AFW START', group: 'auxiliary-feedwater', category: 'sg', expectedAfter: window },
      ],
    })
    const rows = [row('trip:rx', 10, { firstOut: { group: 'reactor-trip', rank: 1 }, subject: { element: 'core' } }), row('trip:afw-a', 40, { subject: { element: 'sgA' } }), row('csf', 50, { observable: 'unit#csf.heatSink' }), row('other', 60)]
    const marked = annunciatedRows(rows, { annunciation: () => annunciation, objectRows: () => rows, ownStates: () => new Set(['unit#csf.heatSink']), nowMs: t0 + 120_000 })
    expect(marked.map(entry => [entry.tag, entry.action, entry.category, entry.expected, entry.ownState])).toEqual([
      ['LO · RX TRIP', { label: 'RX TRIP', ends: ['core'] }, { id: 'rps', label: 'Reactor protection', order: 0 }, undefined, undefined],
      ['LO-LO · AFW START', { label: 'AFW START' }, { id: 'sg', label: 'Steam generators', order: 1 }, { after: 'RX TRIP' }, undefined],
      [undefined, undefined, undefined, undefined, true],
      [undefined, undefined, undefined, undefined, undefined],
    ])
    // On a wall clock nothing is placed after a first-out; without a Pack declaration a row is as it came.
    expect(annunciatedRows(rows, { annunciation: () => annunciation, objectRows: () => rows, ownStates: () => new Set(), nowMs: null })[1]!.expected).toBeUndefined()
    expect(annunciatedRows(rows, { annunciation: () => undefined, objectRows: () => rows, ownStates: () => new Set(), nowMs: t0 })).toEqual(rows)
    // An annunciation naming a group or category it does not declare is refused.
    expect(() => annunciationSchema.parse({ groups: [], categories: [], alerts: [{ id: 'a', group: 'nowhere' }] })).toThrow()
  })
})
