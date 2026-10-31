import type { AlertTile } from '../../../features/displays/alerts/census.ts'
import { priorityRank } from '../../../features/displays/alerts/rows.ts'
import type { RowFont } from './alerts.ts'

// How an alert list's tiles stand (plan v5 W2.2, §2 rule 2: a label is never cut): in the fewest rows of tiles, each
// tile as wide as that allows, every tile with its label where all fit whole beside their badges, else every one
// with its Pack's short label.
// obc-alert-subsystem-counter would cut a label that does not fit with an ellipsis; no layout here lets it.

/** A tile's frame and the gaps inside it (obc-alert-subsystem-counter: 8 px padding, 1 px border, 8 px gap, 4 px label inset), in px. */
const TILE_CHROME_PX = 2 * 8 + 2 + 8 + 4
/** Between tiles, in px. */
export const TILE_GAP_PX = 4
/** The narrowest tile, in px. */
const TILE_MIN_PX = 112
/** A large obc-badge: at least 24 px, its number inset 4 px either side. */
const badgeWidth = (count: number, measure: (text: string, font: RowFont) => number): number => Math.max(24, measure(String(count), 'badge') + 8 + 2)

/** A tile's one badge: its news counted, in the colour of the worst (what lights it); else its other alerts counted, neutral; none without alerts. */
export const tileBadge = (tile: AlertTile): { readonly priority: AlertTile['news'][number]['priority'] | 'quiet'; readonly count: number } | null => {
  const news = tile.news.reduce((sum, entry) => sum + entry.count, 0)
  return news > 0 ? { priority: tile.news[0]!.priority, count: news } : tile.rows.length > 0 ? { priority: 'quiet', count: tile.rows.length } : null
}

/** The room a tile's badge takes beside its label. */
const trailing = (tile: AlertTile, measure: (text: string, font: RowFont) => number): number => {
  const badge = tileBadge(tile)
  return badge === null ? 0 : badgeWidth(badge.count, measure)
}

/** The columns the tiles stand in and the label each writes: the fewest rows, then the widest tiles whose labels all fit. */
export const tileLayout = (tiles: ReadonlyArray<AlertTile>, width: number, measure: (text: string, font: RowFont) => number): { readonly columns: number; readonly labels: ReadonlyArray<string> } => {
  const most = Math.max(1, Math.min(tiles.length, Math.floor((width + TILE_GAP_PX) / (TILE_MIN_PX + TILE_GAP_PX))))
  const tried = Array.from({ length: most }, (_, at) => most - at).map(columns => {
    const room = (width - (columns - 1) * TILE_GAP_PX) / columns - TILE_CHROME_PX
    const fits = (label: string, tile: AlertTile): boolean => measure(label, 'tile') <= room - trailing(tile, measure)
    // One kind of label for all: whole where every one fits, else each its short label.
    const labels = tiles.every(tile => fits(tile.label, tile)) ? tiles.map(tile => tile.label)
      : tiles.every(tile => fits(tile.short ?? tile.label, tile)) ? tiles.map(tile => tile.short ?? tile.label) : null
    return { columns, rows: Math.ceil(tiles.length / columns), labels }
  }).filter((layout): layout is { columns: number; rows: number; labels: string[] } => layout.labels !== null)
  const fewest = Math.min(...tried.map(layout => layout.rows))
  const chosen = tried.filter(layout => layout.rows === fewest).at(-1)
  return chosen === undefined ? { columns: 1, labels: tiles.map(tile => tile.short ?? tile.label) } : { columns: chosen.columns, labels: chosen.labels }
}

/** A tile's height: its 24 px line inside 8 px padding and a 1 px border (obc-alert-subsystem-counter). */
const TILE_PX = 24 + 2 * 8 + 2

/** How tall the tiles stand: their rows of tiles and the gaps between. */
export const tilesHeight = (tiles: ReadonlyArray<AlertTile>, columns: number): number => {
  const rows = Math.ceil(tiles.length / Math.max(1, columns))
  return rows === 0 ? 0 : rows * TILE_PX + (rows - 1) * TILE_GAP_PX
}

// One compact row of tiles, where full tiles would leave the list fewer than its least rows (a narrow display's
// band): the tiles with alerts, the worst first, each a small chip of its label and a regular obc-badge, as many as
// stand whole in the row; the rest counted ("+2").

/** A chip's frame: 4 px padding either side, a 1 px border, 4 px between its label and its badge; and between chips. */
const CHIP_CHROME_PX = 2 * 4 + 2 + 4
const CHIP_GAP_PX = 4
/** A regular obc-badge: at least 16 px, its number inset 4 px either side ("12" measured 21.7 px). */
const chipBadgeWidth = (count: number, measure: (text: string, font: RowFont) => number): number => Math.max(16, measure(String(count), 'chip') + 8)

/** The tiles with alerts, the worst first: lit by the worse news, then more of it; then those only expected, standing or advisory, more first; else in their order. */
export const worstTiles = (tiles: ReadonlyArray<AlertTile>): ReadonlyArray<AlertTile> => {
  const rank = (tile: AlertTile): number => tile.news.length === 0 ? -2 : priorityRank(tile.news[0]!.priority)
  return tiles.filter(tile => tile.rows.length > 0).map((tile, at) => ({ tile, at }))
    .sort((left, right) => rank(right.tile) - rank(left.tile) || tileBadge(right.tile)!.count - tileBadge(left.tile)!.count || left.at - right.at)
    .map(entry => entry.tile)
}

/** The chips one row of `width` px holds, the worst first, each by its short label where its Pack declares one; the rest counted. */
export const tileStrip = (tiles: ReadonlyArray<AlertTile>, width: number, measure: (text: string, font: RowFont) => number): {
  readonly shown: ReadonlyArray<{ readonly tile: AlertTile; readonly label: string }>; readonly more: ReadonlyArray<AlertTile>
} => {
  const worst = worstTiles(tiles)
  const chip = (tile: AlertTile): number => CHIP_CHROME_PX + measure(tile.short ?? tile.label, 'chip') + chipBadgeWidth(tileBadge(tile)!.count, measure)
  const shown: Array<{ tile: AlertTile; label: string }> = []
  let used = 0
  for (const [at, tile] of worst.entries()) {
    const left = worst.length - at - 1
    const after = left === 0 ? 0 : CHIP_GAP_PX + measure(`+${left}`, 'chip')
    const next = used + (shown.length === 0 ? 0 : CHIP_GAP_PX) + chip(tile)
    if (next + after > width) break
    shown.push({ tile, label: tile.short ?? tile.label })
    used = next
  }
  return { shown, more: worst.slice(shown.length) }
}
