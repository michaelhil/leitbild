// A network drawing's items as the renderer sets them (ui/embed/vignette/network.ts), and the room the composer
// reserves for them in ELK's boxes: every name and reading whole, measured in the Noto Sans the embed ships
// (text.ts), as a flow drawing's are (plan v5 W6.5, R3 eval: "Follo - Tegneby / Syllin", "Sylling trafostasjon
// 420/…"). A device's symbol stands over one row: its name, then its reading after " · ". A bus's name stands in its
// bar where the bar runs along the box, else in a row beside the bar. A line element's name stands over the line
// through its box, its reading under it. A stop's or a boundary's label stands in its row beside the cap its line
// ends in. Names at 12 px neutral, readings at 14 px in the active colour.
import type { Observable } from '../../../core/observation/model.ts'
import type { TopologyNode } from '../../../core/observation/topology.ts'
import { readingRoom, textWidth } from './text.ts'

/** In px: the grid, a device's symbol (two cells), a bus's bar, a stop's cap and the gap before its label, a bus label's padding in its bar, the gap between a bar and the name beside it. */
export const NETWORK = { grid: 24, symbol: 48, bar: 16, cap: 6, barPadding: 16, gap: 4 } as const
/** A name over a line, and a reading under it: each a row this high, clear of the line through the middle of a two-cell box. */
export const NETWORK_ROW = 20
/** Between a reading and the name before it, on a device's row. */
export const NETWORK_SEPARATOR = ' · '

/** The roles a network item writes its reading from, the first that reads a number. */
export const NETWORK_READING_ROLES: ReadonlyArray<TopologyNode['bindings'][number]['role']> = ['loading', 'flow', 'level', 'value']
const DEVICES: ReadonlySet<TopologyNode['class']> = new Set(['switch', 'converter', 'source'])

export type NetworkDeclaredOf = (ref: string) => Pick<Observable, 'unit' | 'decades'> | undefined

/** The widest reading an item writes: any of its reading roles' bindings, five figures and its unit. */
const readingOf = (node: Pick<TopologyNode, 'bindings'>, declaredOf: NetworkDeclaredOf): number =>
  Math.max(0, ...node.bindings.filter(binding => NETWORK_READING_ROLES.includes(binding.role)).map(binding => readingRoom(declaredOf(binding.ref), undefined, 5, 'reading')))

/** An item's box in grid cells: wide enough for its words, as tall as its symbol and rows. */
export const networkRoom = (node: Pick<TopologyNode, 'class' | 'label' | 'shortLabel' | 'bindings'>, declaredOf: NetworkDeclaredOf): { readonly width: number; readonly height: number } => {
  const name = node.shortLabel ?? node.label
  const reading = readingOf(node, declaredOf)
  const cells = (px: number): number => Math.max(2, Math.ceil(px / NETWORK.grid))
  if (DEVICES.has(node.class)) return { width: cells(Math.max(NETWORK.symbol, textWidth(name, 'name') + (reading === 0 ? 0 : textWidth(NETWORK_SEPARATOR, 'name') + reading))), height: 3 }
  if (node.class === 'bus') return { width: cells(Math.max(textWidth(name, 'busLabel') + NETWORK.barPadding, textWidth(name, 'name') + NETWORK.bar + NETWORK.gap)), height: 2 }
  if (node.class === 'boundary') return { width: cells(stopRoom(name)), height: 1 }
  if (node.class === 'junction') return { width: 1, height: 1 }
  return { width: cells(Math.max(textWidth(name, 'name'), reading)), height: 2 }
}

/** A stop's or a boundary's room: its cap, the gap, its label. */
export const stopRoom = (label: string): number => NETWORK.cap + NETWORK.gap + textWidth(label, 'name')
