import type { Priority } from '../../../core/model/alerts.ts'
import type { Annunciation } from '../../../core/observation/annunciation.ts'
import { listOrder, listPart } from './list.ts'
import { groupKey, priorityRank, unacknowledged, type AlertRow } from './rows.ts'

// What an alert list counts and the tiles it sorts its alerts into (plan v5
// W2.1, W2.2), over the rows a sample carries, generic for every Pack.
// The counts: the news (first-outs, own states, new and returned alarms) by
// priority, and apart from them what came in as expected after a first-out,
// the standing and the advisory ones; together every row once (the census).
// Besides, the unacknowledged. Each count is a filter of the list.
// The tiles: one per category (annunciator system) its object's Pack
// declares, all of them in their declared order whether or not an alert is in
// them, each lit by the worst of its news, never by what is expected; an alert
// in none, or a list of several objects, takes its object's (or subject
// group's) tile, in the order they come. A tile with alerts is a filter too.

/** How a row is counted: as news, or apart, as expected after a first-out, standing or advisory. */
export type Counted = 'news' | 'expected' | 'standing' | 'advisory'
export const countedAs = (row: AlertRow): Counted => {
  const part = listPart(row)
  return part === 'expected' ? 'expected' : part === 'quiet' ? (row.alert.standing === true ? 'standing' : 'advisory') : 'news'
}

/** News by priority, the worst first; a priority not declared (null) last. */
export type PriorityCounts = ReadonlyArray<{ readonly priority: Priority | null; readonly count: number }>
const byPriority = (rows: ReadonlyArray<AlertRow>): PriorityCounts => {
  const counts = new Map<Priority | null, number>()
  for (const row of rows) if (countedAs(row) === 'news') counts.set(row.priority, (counts.get(row.priority) ?? 0) + 1)
  return [...counts].map(([priority, count]) => ({ priority, count })).sort((left, right) => priorityRank(right.priority) - priorityRank(left.priority))
}

export interface AlertCensus {
  readonly total: number
  readonly news: PriorityCounts
  readonly unacknowledged: number
  readonly expected: number
  readonly standing: number
  readonly advisory: number
}

export const alertCensus = (rows: ReadonlyArray<AlertRow>): AlertCensus => {
  const apart = (counted: Counted): number => rows.filter(row => countedAs(row) === counted).length
  return { total: rows.length, news: byPriority(rows), unacknowledged: rows.filter(unacknowledged).length, expected: apart('expected'), standing: apart('standing'), advisory: apart('advisory') }
}

/** A category its object's Pack declares. */
export type DeclaredCategory = Annunciation['categories'][number]

export interface AlertTile {
  /** `category:<id>`, or `group:<object|subject group>` where an alert is in no declared category. */
  readonly key: string
  readonly label: string
  /** Its Pack's short label, written where its tile is too narrow for its label. */
  readonly short?: string
  /** Its alerts, in list order. */
  readonly rows: ReadonlyArray<AlertRow>
  /** Its news by priority: what lights it, by the worst. */
  readonly news: PriorityCounts
}

/**
 * A list's tiles. A list of one object whose Pack declares categories (`declared`, else those its rows name) has one
 * per category, in their declared order, and after them one per object or named subject group of an alert in none; a
 * list of several objects one per object or named subject group, in the order they come (a subject group its Pack does
 * not name stays with its object: no tile shows an id). Where every alert falls in one group and nothing is declared,
 * a tile would only repeat the list: there are none.
 */
export const alertTiles = (rows: ReadonlyArray<AlertRow>, declared?: ReadonlyArray<DeclaredCategory>): ReadonlyArray<AlertTile> => {
  const single = new Set(rows.map(row => row.objectId)).size <= 1
  const declaredByRows: ReadonlyArray<DeclaredCategory> = [...new Map(rows.flatMap(row => row.category === undefined ? [] : [[row.category.id, row.category] as const])).values()]
    .sort((left, right) => left.order - right.order).map(category => ({ id: category.id, label: category.label }))
  const categories = !single ? [] : declared !== undefined && declared.length > 0 ? declared : declaredByRows
  const known = new Set(categories.map(category => category.id))
  // A subject group its Pack names (group.label) has its tile; one it does not name stays with its object, never shown by its id.
  const named = (row: AlertRow): boolean => row.group.subjectGroup !== undefined && row.group.label !== undefined
  const keyOf = (row: AlertRow): string => row.category !== undefined && known.has(row.category.id) ? `category:${row.category.id}`
    : named(row) ? `group:${groupKey(row)}` : `group:${row.objectId}`
  const groups = new Map<string, { label: string; rows: AlertRow[] }>(categories.map(category => [`category:${category.id}`, { label: category.label, rows: [] }]))
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key) ?? groups.set(key, { label: named(row) ? row.group.label! : row.objectLabel, rows: [] }).get(key)!
    group.rows.push(row)
  }
  if (categories.length === 0 && groups.size <= 1) return []
  const shortOf = new Map<string, string>(categories.flatMap(category => category.short === undefined ? [] : [[`category:${category.id}`, category.short] as const]))
  return [...groups].map(([key, group]) => {
    const sorted = [...group.rows].sort(listOrder)
    return { key, label: group.label, ...(shortOf.has(key) ? { short: shortOf.get(key)! } : {}), rows: sorted, news: byPriority(sorted) }
  })
}

/** What a list is narrowed to: the news of one priority, the unacknowledged, those counted apart, or a tile's. */
export type AlertFilter =
  | { readonly kind: 'priority'; readonly priority: Priority | null }
  | { readonly kind: 'unacknowledged' }
  | { readonly kind: 'apart'; readonly counted: Exclude<Counted, 'news'> }
  | { readonly kind: 'tile'; readonly key: string }

export const sameFilter = (left: AlertFilter | null, right: AlertFilter | null): boolean => JSON.stringify(left) === JSON.stringify(right)

/** The rows a filter keeps (a tile's from `tiles`). */
export const filtered = (rows: ReadonlyArray<AlertRow>, filter: AlertFilter, tiles: ReadonlyArray<AlertTile>): ReadonlyArray<AlertRow> => {
  if (filter.kind === 'tile') {
    const keys = new Set(tiles.find(tile => tile.key === filter.key)?.rows.map(row => row.key) ?? [])
    return rows.filter(row => keys.has(row.key))
  }
  return rows.filter(row => filter.kind === 'priority' ? countedAs(row) === 'news' && row.priority === filter.priority
    : filter.kind === 'unacknowledged' ? unacknowledged(row) : countedAs(row) === filter.counted)
}
