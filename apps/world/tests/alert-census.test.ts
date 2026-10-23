import { describe, expect, test } from 'bun:test'
import type { AlertState } from '../src/core/model/alerts.ts'
import type { ObjectId } from '../src/core/model/ids.ts'
import { alertCensus, alertTiles, filtered, sameFilter } from '../src/features/displays/alerts/census.ts'
import type { AlertRow } from '../src/features/displays/alerts/rows.ts'
import { tileBadge, tileLayout, tilesHeight } from '../src/ui/embed/vignette/tile-fit.ts'

// An alert list's counts and tiles (plan v5 W2.1, W2.2), generic for every Pack: the counts are its census, each a
// filter; the tiles are its Pack's declared categories, all of them, in their order, lit by the worst news only.

const t0 = Date.parse('2026-07-12T04:00:00.000Z')
const iso = (seconds: number) => new Date(t0 + seconds * 1000).toISOString()
const SYSTEMS = [
  { id: 'rps', label: 'Reactor protection', short: 'RPS' }, { id: 'rcs', label: 'Reactor coolant system', short: 'RCS' },
  { id: 'sg', label: 'Steam generators', short: 'SG' }, { id: 'si', label: 'Safety injection', short: 'SI' },
  { id: 'elec', label: 'Electrical', short: 'ELEC' }, { id: 'fw', label: 'Feedwater', short: 'FW' },
]
const category = (id: string) => ({ id, label: SYSTEMS.find(system => system.id === id)!.label, order: SYSTEMS.findIndex(system => system.id === id) })
const row = (id: string, priority: AlertRow['priority'], extra: Partial<AlertState> = {}, rowExtra: Partial<AlertRow> = {}): AlertRow => ({
  key: `unit|${id}`, objectId: 'unit' as ObjectId, objectLabel: 'Unit 1', packId: 'fixture', categoryId: 'unit', group: { objectId: 'unit' as ObjectId },
  alert: { id, kind: 'alarm', severity: priority === 'alarm' ? 'critical' : 'warning', message: id, raisedAt: iso(1) as never, acknowledged: false, ...(priority === null ? {} : { priority }), clock: 'simulation', subject: { element: `${id}-element` }, ...extra },
  priority, state: 'active-unack', raised: { at: iso(1) as never, clock: 'simulation' }, ...rowExtra,
})

// A tripped unit: two first-outs, a LOOP, an RCP and a pump that failed, SG levels expected after the trip, one standing.
const rows: ReadonlyArray<AlertRow> = [
  row('rx-trip', 'alarm', { firstOut: { group: 'rt', rank: 1 } }, { action: { label: 'RX TRIP' }, category: category('rps') }),
  row('loop', 'alarm', {}, { category: category('elec') }),
  row('rcp-a', 'warning', {}, { category: category('rcs') }),
  row('afw-a', 'warning', {}, { category: category('fw') }),
  row('sg-a-low', 'alarm', {}, { category: category('sg'), expected: { after: 'RX TRIP' } }),
  row('sg-b-low', 'alarm', {}, { category: category('sg'), expected: { after: 'RX TRIP' } }),
  row('bus-a', 'caution', { returned: true }, { state: 'returned-unack', category: category('elec') }),
  row('cst', 'caution', { standing: true, acknowledged: true }, { state: 'active-ack', category: category('fw') }),
  row('csf', 'warning', {}, { ownState: true }),
]

describe('the counts (W2.1)', () => {
  test('the news by priority, the worst first, and apart from it the expected, the standing and the advisory: every alert once', () => {
    const census = alertCensus(rows)
    expect(census.news).toEqual([{ priority: 'alarm', count: 2 }, { priority: 'warning', count: 3 }, { priority: 'caution', count: 1 }])
    expect([census.expected, census.standing, census.advisory]).toEqual([2, 1, 0])
    expect(census.news.reduce((sum, entry) => sum + entry.count, 0) + census.expected + census.standing + census.advisory).toBe(census.total)
    expect(census.total).toBe(rows.length)
    // The unacknowledged cross them: what asks attention and is not acknowledged, expected ones included (R43).
    expect(census.unacknowledged).toBe(8)
  })

  test('each count narrows the list to what it counts', () => {
    const ids = (filter: Parameters<typeof filtered>[1]) => filtered(rows, filter, alertTiles(rows, SYSTEMS)).map(entry => entry.alert.id)
    expect(ids({ kind: 'priority', priority: 'alarm' })).toEqual(['rx-trip', 'loop'])
    expect(ids({ kind: 'priority', priority: 'warning' })).toEqual(['rcp-a', 'afw-a', 'csf'])
    expect(ids({ kind: 'apart', counted: 'expected' })).toEqual(['sg-a-low', 'sg-b-low'])
    expect(ids({ kind: 'apart', counted: 'standing' })).toEqual(['cst'])
    expect(ids({ kind: 'unacknowledged' })).toHaveLength(8)
    expect(ids({ kind: 'tile', key: 'category:fw' })).toEqual(['afw-a', 'cst'])
    expect(sameFilter({ kind: 'tile', key: 'category:fw' }, { kind: 'tile', key: 'category:fw' })).toBe(true)
    expect(sameFilter({ kind: 'unacknowledged' }, null)).toBe(false)
  })
})

describe('the tiles (W2.2)', () => {
  test('every declared category, in its declared order, with or without alerts; an alert in none takes its object\'s tile after them', () => {
    const tiles = alertTiles(rows, SYSTEMS)
    expect(tiles.map(tile => [tile.key, tile.short ?? null, tile.rows.map(entry => entry.alert.id)])).toEqual([
      ['category:rps', 'RPS', ['rx-trip']], ['category:rcs', 'RCS', ['rcp-a']], ['category:sg', 'SG', ['sg-a-low', 'sg-b-low']], ['category:si', 'SI', []],
      ['category:elec', 'ELEC', ['loop', 'bus-a']], ['category:fw', 'FW', ['afw-a', 'cst']], ['group:unit', null, ['csf']],
    ])
    // Lit by the worst of its news only: what is expected after the trip lights nothing; a returned alarm is news.
    const badges = Object.fromEntries(tiles.map(tile => [tile.key, tileBadge(tile)]))
    expect(badges['category:sg']).toEqual({ priority: 'quiet', count: 2 })
    expect(badges['category:si']).toBeNull()
    expect(badges['category:elec']).toEqual({ priority: 'alarm', count: 2 })
    expect(badges['category:fw']).toEqual({ priority: 'warning', count: 1 })
  })

  test('without a declaration, the categories its rows name; several objects, a tile per object; one object in no category, none', () => {
    expect(alertTiles(rows).map(tile => tile.key)).toEqual(['category:rps', 'category:rcs', 'category:sg', 'category:elec', 'category:fw', 'group:unit'])
    const grid = { ...row('line', 'alarm'), key: 'grid|line', objectId: 'grid' as ObjectId, objectLabel: 'Grid', group: { objectId: 'grid' as ObjectId, subjectGroup: 'Substation Nord' } }
    expect(alertTiles([...rows, grid], SYSTEMS).map(tile => [tile.label, tile.rows.length])).toEqual([['Unit 1', rows.length], ['Substation Nord', 1]])
    expect(alertTiles([row('a', 'alarm'), row('b', 'warning')])).toEqual([])
  })

  test('tiles stand in the fewest rows whose labels fit whole beside their badge, a narrow tile writing its short label', () => {
    const measure = (text: string) => text.length * 9
    const tiles = alertTiles(rows, SYSTEMS)
    // 360 px: three columns of 117 px leave about 60 px beside a badge, room for "ELEC" but not "Electrical".
    const narrow = tileLayout(tiles, 360, measure)
    expect(narrow.columns).toBe(3)
    expect(narrow.labels).toEqual(['RPS', 'RCS', 'SG', 'SI', 'ELEC', 'FW', 'Unit 1'])
    // Wide, two rows: the widest tiles that make them, and whole labels where they fit.
    const wide = tileLayout(tiles, 760, measure)
    expect(wide.columns).toBe(4)
    expect(wide.labels).toContain('Electrical')
    for (const [at, label] of narrow.labels.entries()) expect([tiles[at]!.label, tiles[at]!.short]).toContain(label)
    expect(tilesHeight(tiles, 3)).toBe(3 * 42 + 2 * 4)
  })
})
