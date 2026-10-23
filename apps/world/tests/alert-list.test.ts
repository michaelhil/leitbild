import { describe, expect, test } from 'bun:test'
import type { AlertState } from '../src/core/model/alerts.ts'
import type { ObjectId } from '../src/core/model/ids.ts'
import { ageText, categoryGroups, firstOutMark, fitLines, listLines, listOrder, listPart, passes, tripLine, type ListLine } from '../src/features/displays/alerts/list.ts'
import type { AlertRow } from '../src/features/displays/alerts/rows.ts'

// The alerts organisation (plan v5 W2.4–W2.6) over the alert rows a sample
// carries, generic for every Pack: the list's order and aggregates and what
// fits its room; the trip line; the full view's filters and categories. OLD's
// banner test (composed-display-panel-presenters.test.ts at 724ae2ac8) is
// re-expressed here over the alert slot.

const t0 = Date.parse('2026-07-12T04:00:00.000Z')
const iso = (seconds: number) => new Date(t0 + seconds * 1000).toISOString()
const row = (id: string, seconds: number, extra: Partial<AlertState> = {}, rowExtra: Partial<AlertRow> = {}): AlertRow => ({
  key: `unit|${id}`, objectId: 'unit' as ObjectId, objectLabel: 'Unit 1', packId: 'fixture', categoryId: 'unit', group: { objectId: 'unit' as ObjectId },
  alert: { id, kind: 'alarm', severity: 'critical', message: id, raisedAt: iso(seconds) as never, acknowledged: false, priority: 'alarm', clock: 'simulation', ...extra },
  priority: (extra.priority ?? 'alarm') as AlertRow['priority'], state: 'active-unack', raised: { at: iso(seconds) as never, clock: 'simulation' }, ...rowExtra,
})

describe('the list (W2.5)', () => {
  const first = (id: string, seconds: number, label: string) => row(id, seconds, { firstOut: { group: label, rank: 1 } }, { action: { label } })
  const rows: ReadonlyArray<AlertRow> = [
    row('sg-a-low', 20, { priority: 'warning', severity: 'warning' }, { expected: { after: 'RX TRIP' } }),
    first('rx-trip', 2, 'RX TRIP'),
    row('loop', 1),
    row('rcp-a', 3, { priority: 'warning', severity: 'warning' }),
    row('bus-a', 3, { returned: true }, { state: 'returned-unack' }),
    first('turb-trip', 1, 'TURB TRIP'),
    row('csf-heat-sink', 30, { priority: 'warning', severity: 'warning' }, { ownState: true }),
    row('sg-b-low', 21, { priority: 'warning', severity: 'warning' }, { expected: { after: 'RX TRIP' } }),
    row('cst-low', 5, { priority: 'caution', severity: 'warning', standing: true, acknowledged: true }, { state: 'active-ack' }),
    row('pzr-low', 4, {}, { expected: { after: 'RX TRIP' } }),
  ]
  const shown = (lines: ReadonlyArray<ListLine>) => lines.map(line => line.kind === 'row' ? line.row.alert.id : `[${line.label}${line.open ? ' ▾' : ' ▸'}]`)

  test('first-outs as they came in, own states, new by priority, returned, then one line per first-out its expected alerts fold into, and one for the standing', () => {
    expect(shown(listLines(rows, new Set()))).toEqual(['turb-trip', 'rx-trip', 'csf-heat-sink', 'loop', 'rcp-a', 'bus-a', '[3 expected after RX TRIP ▸]', '[1 standing ▸]'])
    expect(rows.map(listPart)).toEqual(['expected', 'first-out', 'new', 'new', 'returned', 'first-out', 'state', 'expected', 'quiet', 'expected'])
    // An aggregate opens in place: its rows under it, the worst first.
    expect(shown(listLines(rows, new Set(['expected:RX TRIP'])))).toEqual(['turb-trip', 'rx-trip', 'csf-heat-sink', 'loop', 'rcp-a', 'bus-a', '[3 expected after RX TRIP ▾]', 'pzr-low', 'sg-b-low', 'sg-a-low', '[1 standing ▸]'])
    expect([firstOutMark(rows[1]!), firstOutMark(row('x', 1, { firstOut: { group: 'g', rank: 1 } })), firstOutMark(rows[2]!)]).toEqual(['1st RX TRIP', 'FIRST OUT', null])
  })

  test('what does not fit its room is counted on "+N more", the closing aggregates keeping their lines; a row on two lines costs two', () => {
    const lines = listLines(rows, new Set())
    expect(fitLines(lines, 20, () => 1)).toEqual({ shown: lines, pinned: [], hidden: [] })
    const tight = fitLines(lines, 6, () => 1)
    // Two aggregates and "+N more" take three rows; three rows are left for the list's head.
    expect([shown(tight.shown), shown(tight.pinned), tight.hidden.map(entry => entry.alert.id)]).toEqual([['turb-trip', 'rx-trip', 'csf-heat-sink'], ['[3 expected after RX TRIP ▸]', '[1 standing ▸]'], ['loop', 'rcp-a', 'bus-a']])
    const stacked = fitLines(lines, 6, line => line.kind === 'row' ? 2 : 1)
    expect([shown(stacked.shown), stacked.hidden.length]).toEqual([['turb-trip'], 5])
    // An opened aggregate stays in view with as many of its rows as half the room holds; the rows before it give way.
    const opened = fitLines(listLines(rows, new Set(['expected:RX TRIP'])), 8, () => 1)
    expect([shown(opened.shown), shown(opened.pinned), opened.hidden.map(entry => entry.alert.id)]).toEqual([
      ['turb-trip', 'rx-trip', 'csf-heat-sink', 'loop'], ['[3 expected after RX TRIP ▾]', 'pzr-low', '[1 standing ▸]'], ['rcp-a', 'bus-a', 'sg-b-low', 'sg-a-low'],
    ])
  })

  test('age in Run time: m:ss under an hour, then h mm', () => {
    expect(ageText(t0 + 179_000, row('a', 0))).toBe('2:59')
    expect(ageText(t0 + 3_900_000, row('a', 0))).toBe('1 h 05')
    expect(ageText(Number.NaN, row('a', 0))).toBeNull()
  })
})

describe('the trip line (W2.4)', () => {
  test('first-outs that stop an energy end lead as they came in, the other groups that hold are actuated, as OLD\'s banner and the strip order them', () => {
    // Halden LOOP (Run A): the turbine tripped on loss of load, then the reactor on the turbine trip; AFW started and feedwater isolated.
    const act = (id: string, seconds: number, label: string, ends?: ReadonlyArray<string>, firstOut = false) =>
      row(id, seconds, { latched: true, kind: 'trip', ...(firstOut ? { firstOut: { group: label, rank: 1 } } : {}) }, { action: { label, ...(ends === undefined ? {} : { ends }) } })
    const rows = [
      act('rx-trip', 2, 'RX TRIP', ['core'], true), act('rx-trip-rcp', 2, 'RX TRIP', ['core']), act('afw', 3, 'AFW START', undefined, true),
      act('p4', 3, 'TURB TRIP', ['turbine']), act('fwi', 12, 'FWI', undefined, true), act('turb-trip', 1, 'TURB TRIP', ['turbine'], true),
      row('loop', 1), { ...row('other-unit', 0, { firstOut: { group: 'RX TRIP', rank: 1 } }), objectId: 'unit-2' as ObjectId },
    ]
    const line = tripLine(rows, 'unit')
    expect(line.leads.map(lead => [lead.label, lead.row.alert.id, lead.ends])).toEqual([['TURB TRIP', 'turb-trip', ['turbine']], ['RX TRIP', 'rx-trip', ['core']]])
    expect(line.actuated.map(entry => [entry.label, entry.row.alert.id])).toEqual([['AFW START', 'afw'], ['FWI', 'fwi']])
    // Without a reactor or turbine trip nothing leads; the actuations still show. A reset one is no longer actuated.
    const quiet = rows.filter(entry => !['rx-trip', 'rx-trip-rcp', 'p4', 'turb-trip'].includes(entry.alert.id))
    expect(tripLine(quiet, 'unit').leads).toEqual([])
    expect(tripLine(quiet.map(entry => entry.alert.id === 'fwi' ? { ...entry, state: 'returned-unack' as const } : entry), 'unit').actuated.map(entry => entry.label)).toEqual(['AFW START'])
    // A Pack that names no groups: its first-outs lead as they came in.
    expect(tripLine([row('b', 5, { firstOut: { group: 'g2', rank: 1 } }), row('a', 4, { firstOut: { group: 'g1', rank: 1 } }), row('c', 3)], 'unit').leads.map(lead => lead.row.alert.id)).toEqual(['a', 'b'])
  })
})

describe('the full alerts view (W2.6)', () => {
  test('grouped by category in declared order, else by object; filtered in the grid alarm list\'s words', () => {
    const rows = [
      row('sg', 5, {}, { category: { id: 'sg', label: 'Steam generators', order: 2 } }),
      row('rcs', 6, {}, { category: { id: 'rcs', label: 'Reactor coolant system', order: 1 } }),
      row('rcs-old', 1, { returned: true }, { state: 'returned-unack', category: { id: 'rcs', label: 'Reactor coolant system', order: 1 } }),
      { ...row('grid', 2), objectId: 'grid' as ObjectId, objectLabel: 'Grid', key: 'grid|grid', group: { objectId: 'grid' as ObjectId } },
      row('standing', 0, { standing: true, acknowledged: true }, { state: 'active-ack', category: { id: 'sg', label: 'Steam generators', order: 2 } }),
    ]
    expect(categoryGroups(rows).map(group => [group.label, group.rows.map(entry => entry.alert.id)])).toEqual([
      ['Reactor coolant system', ['rcs', 'rcs-old']], ['Steam generators', ['sg', 'standing']], ['Grid', ['grid']],
    ])
    const ids = (filter: Parameters<typeof passes>[0]) => rows.filter(entry => passes(filter, entry)).map(entry => entry.alert.id)
    expect(ids('active')).toEqual(['sg', 'rcs', 'grid', 'standing'])
    expect(ids('unacknowledged')).toEqual(['sg', 'rcs', 'rcs-old', 'grid'])
    expect(ids('standing')).toEqual(['standing'])
    expect(ids('all')).toHaveLength(5)
    expect([...rows].sort(listOrder).map(entry => entry.alert.id)).toEqual(['rcs', 'sg', 'grid', 'rcs-old', 'standing'])
  })
})
