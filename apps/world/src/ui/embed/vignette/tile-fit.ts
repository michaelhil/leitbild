import type { AlertTile } from '../../../features/displays/alerts/census.ts'
import type { RowFont } from './alerts.ts'

// How an alert list's tiles stand (plan v5 W2.2, §2 rule 2: a label is never cut): in the fewest rows of tiles, each
// tile as wide as that allows, with its label where it fits whole beside its badge, else its Pack's short label.
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

/** The columns the tiles stand in and the label each writes: the fewest rows, then the widest tiles whose labels fit. */
export const tileLayout = (tiles: ReadonlyArray<AlertTile>, width: number, measure: (text: string, font: RowFont) => number): { readonly columns: number; readonly labels: ReadonlyArray<string> } => {
  const most = Math.max(1, Math.min(tiles.length, Math.floor((width + TILE_GAP_PX) / (TILE_MIN_PX + TILE_GAP_PX))))
  const tried = Array.from({ length: most }, (_, at) => most - at).map(columns => {
    const room = (width - (columns - 1) * TILE_GAP_PX) / columns - TILE_CHROME_PX
    const labels = tiles.map(tile => {
      const left = room - trailing(tile, measure)
      return measure(tile.label, 'tile') <= left ? tile.label : tile.short !== undefined && measure(tile.short, 'tile') <= left ? tile.short : null
    })
    return { columns, rows: Math.ceil(tiles.length / columns), labels }
  }).filter((layout): layout is { columns: number; rows: number; labels: string[] } => layout.labels.every(label => label !== null))
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
