// A network topology as drawn (architecture B2), in OpenBridge: the server's
// ELK layout in grid units, one grid unit a row. Lines are connector-diagram
// segments with its crossing gaps and end caps (as the mimic draws pipes);
// buses are obc-bus; switches, converters and sources are obc-switch,
// obc-transformer and obc-source; a line element is a line through its box.
// Names and readings are text. Colour comes only from the bound observations'
// priorities; "on" only from a boolean or a state declared active (ruling Q8).
import type { Segment } from '@oicl/connector-diagram'
import type { Observation } from '../../../core/observation/model.ts'
import { NETWORK, NETWORK_READING_ROLES, NETWORK_ROW } from '../../../features/displays/topology/network-room.ts'
import { textWidth, type FlowTextStyle } from '../../../features/displays/topology/text.ts'
import { endStraight, pipeSegments, stubEndSegment } from './pipe-segments.ts'
import { DRAWING_TEXT_PX, TEXT_FLOOR_PX, VIGNETTE_ROW_PX } from './grid.ts'
import type { TopologyBinding, VignetteSection } from '../../../features/displays/compose/model.ts'
import { activeState, readingLook, toneOf, type AlertTone } from './readout.ts'

type Topology = Extract<VignetteSection, { kind: 'topology' }>
type Point = readonly [number, number]
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** OpenBridge's device symbol is two grid cells square. */
const SYMBOL_PX = NETWORK.symbol
const BUS_PX = NETWORK.bar

/** The OpenBridge device each node class is drawn as; a class not listed is no device. */
const DEVICES: Readonly<Partial<Record<Topology['nodes'][number]['class'], 'obc-switch' | 'obc-transformer' | 'obc-source'>>> = {
  switch: 'obc-switch', converter: 'obc-transformer', source: 'obc-source',
}

export interface NetworkDrawing {
  readonly width: number
  readonly height: number
  /** Lines, line elements, and the caps where the drawing stops: connector-diagram segments. */
  readonly segments: ReadonlyArray<Segment>
  /** A bar with its name in it, or none where its name stands beside it; `tone`: an alert on it, marked under the bar (obc-bus has no alert state). */
  readonly buses: ReadonlyArray<Box & { readonly id: string; readonly vertical: boolean; readonly label: string; readonly tone: AlertTone | null; readonly title: string }>
  /** Each at its symbol's centre (OpenBridge's `point` positioning). */
  readonly devices: ReadonlyArray<{ readonly id: string; readonly element: 'obc-switch' | 'obc-transformer' | 'obc-source'; readonly x: number; readonly y: number; readonly on: boolean; readonly tone: AlertTone | null; readonly title: string }>
  /**
   * Each item's words in rows, each row a box the composer kept room for (topology/network-room.ts), whole: a device's
   * name and its reading on the row under its symbol, a line element's name over its line and its reading under it, a
   * name beside a bar that runs across its box, a stop's label beside its cap. `framed`: an OpenBridge alert frame marks
   * the item, so its name is not underlined.
   */
  readonly texts: ReadonlyArray<NetworkText>
}

export interface NetworkRow extends Box {
  readonly align: 'start' | 'end'
  readonly parts: ReadonlyArray<{ readonly text: string; readonly kind: 'name' | 'reading'; readonly style: FlowTextStyle }>
}
export interface NetworkText {
  readonly id: string
  readonly rows: ReadonlyArray<NetworkRow>
  readonly tone: AlertTone | null
  readonly framed: boolean
  readonly title: string
}

/**
 * The scale a drawing is shown at: whole where its rows hold it, else the share of its height the composer left it
 * ("drawing scaled to n % to fit"): its rows but the last over the grid rows its layout reaches into.
 */
export const drawingScale = (section: Pick<Topology, 'rows' | 'layout'>): number => Math.min(1, (section.rows - 1) / Math.max(1, Math.ceil(section.layout.height)))

/**
 * How much further a drawing `width` px wide at `scale` is scaled to fit a frame `available` px wide (W4.3): to the
 * frame's width while its 12 px text stays at TEXT_FLOOR_PX or more on screen at the window's `zoom` (the floor a
 * window frame keeps for a flow drawing, grid.ts frameLayout); else not at all, and it scrolls sideways.
 */
export const widthFit = (width: number, scale: number, available: number, zoom: number): number => {
  const natural = width * scale
  if (available <= 0 || natural <= available) return 1
  const fit = available / natural
  return DRAWING_TEXT_PX * zoom * scale * fit >= TEXT_FLOOR_PX ? fit : 1
}

/**
 * A bus's bar: along the one face its edge ends meet (feeders all on one
 * side), across the box between two opposite faces (feeders on both sides),
 * and across the box's middle along its longer side where none or all meet it.
 */
export const barLine = (box: Box, ends: ReadonlyArray<Point>): { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number } => {
  const near = ends.filter(([x, y]) => x >= box.x - 1 && x <= box.x + box.width + 1 && y >= box.y - 1 && y <= box.y + box.height + 1)
  const on = (x: number, edge: number): boolean => Math.abs(x - edge) < 1
  const left = near.filter(([x]) => on(x, box.x))
  const right = near.filter(([x]) => on(x, box.x + box.width))
  const top = near.filter(([, y]) => on(y, box.y))
  const bottom = near.filter(([, y]) => on(y, box.y + box.height))
  const mean = (values: ReadonlyArray<number>): number => values.reduce((sum, value) => sum + value, 0) / values.length
  const across = { horizontal: (y: number) => ({ x1: box.x, y1: y, x2: box.x + box.width, y2: y }), vertical: (x: number) => ({ x1: x, y1: box.y, x2: x, y2: box.y + box.height }) }
  const sideways = left.length + right.length === near.length && near.length > 0
  const upright = top.length + bottom.length === near.length && near.length > 0
  if (sideways && (left.length === 0 || right.length === 0)) return across.vertical(left.length > 0 ? box.x : box.x + box.width)
  if (sideways) return across.horizontal(mean(near.map(([, y]) => y)))
  if (upright && (top.length === 0 || bottom.length === 0)) return across.horizontal(top.length > 0 ? box.y : box.y + box.height)
  if (upright) return across.vertical(mean(near.map(([x]) => x)))
  return box.width >= box.height ? across.horizontal(box.y + box.height / 2) : across.vertical(box.x + box.width / 2)
}

/** An orthogonal path from an edge end on a box's face to a point inside it: straight in, then along. */
export const stub = (end: Point, to: Point, box: Box): ReadonlyArray<Point> => {
  const sideways = Math.abs(end[0] - box.x) < 1 || Math.abs(end[0] - (box.x + box.width)) < 1
  if ((sideways && end[1] === to[1]) || (!sideways && end[0] === to[0])) return [end, to]
  return sideways ? [end, [to[0], end[1]], to] : [end, [end[0], to[1]], to]
}


/** A network drawing; `frozen`: the sample no longer follows the Run, so no alert colour and no reading shows (W8.1). */
export const networkDrawing = (section: Topology, observations: ReadonlyArray<Observation>, frozen = false): NetworkDrawing => {
  const px = (grid: number): number => grid * VIGNETTE_ROW_PX
  const byId = new Map(section.nodes.map(node => [node.id, node]))
  const read = (binding: TopologyBinding): Observation | undefined => observations.find(observation => observation.ref === binding.ref)
  const conducting = (id: string): boolean | null => {
    const binding = byId.get(id)?.bindings.find(entry => entry.role === 'conducting')
    return binding === undefined ? null : activeState(read(binding)?.value, binding.states)
  }
  const at = (box: Box) => (point: Point): boolean => point[0] >= box.x - 1 && point[0] <= box.x + box.width + 1 && point[1] >= box.y - 1 && point[1] <= box.y + box.height + 1
  const boxes = new Map(section.layout.nodes.map(node => [node.id, { x: px(node.x), y: px(node.y), width: px(node.width), height: px(node.height) }]))
  // A line to where the drawing stops ends on a straight of its own, never with its cap in a bend (W6.3).
  const stopAt = (point: Point): Box | undefined => [...boxes].find(([id, box]) => ['stop', 'boundary'].includes(byId.get(id)?.class ?? '') && at(box)(point))?.[1]
  const edges = section.layout.edges.map(edge => {
    const points = edge.points.map(([x, y]) => [px(x), px(y)] as const)
    const [first, last] = [stopAt(points[0]!), stopAt(points.at(-1)!)]
    const ended = last === undefined ? points : endStraight(points, 'last', last)
    return { ...edge, points, drawn: first === undefined ? ended : endStraight(ended, 'first', first), gaps: edge.gaps.map(([x, y]) => [px(x), px(y)] as const) }
  })
  const ends = edges.flatMap(edge => [edge.points[0]!, edge.points.at(-1)!])
  const nodeAt = (point: Point): string | undefined => [...boxes].find(([, box]) => at(box)(point))?.[0]
  // A line goes empty where a node at either end reads off; else it is drawn as an open line.
  const lineValue = (points: ReadonlyArray<Point>) => [nodeAt(points[0]!), nodeAt(points.at(-1)!)].some(id => id !== undefined && conducting(id) === false) ? 'empty' : 'open-generic'
  const segments: Segment[] = edges.flatMap(edge => pipeSegments(edge.id, edge.drawn, edge.gaps, lineValue(edge.points), 'small'))
  const drawing: { buses: NetworkDrawing['buses'][number][]; devices: NetworkDrawing['devices'][number][]; texts: NetworkDrawing['texts'][number][] } = { buses: [], devices: [], texts: [] }
  for (const [id, box] of boxes) {
    const node = byId.get(id)
    if (node === undefined) continue
    const bound = node.bindings.map(binding => ({ binding, observation: read(binding) }))
    const tones = bound.map(entry => toneOf(entry.observation?.priority)).filter(tone => tone !== null)
    const tone = frozen ? null : (['critical', 'alarm', 'warning', 'caution'] as const).find(level => tones.includes(level)) ?? null
    const lead = frozen ? undefined : NETWORK_READING_ROLES.flatMap(role => bound.filter(entry => entry.binding.role === role && typeof entry.observation?.value === 'number'))[0]
    const look = lead === undefined ? null : readingLook(node.label, 'number', undefined, { value: lead.observation!.value, unit: lead.binding.unit, thresholds: [] })
    const reading = look === null ? null : `${look.text}${look.unit === '' ? '' : ` ${look.unit}`}`
    const name = node.shortLabel ?? node.label
    const title = `${node.label}${reading === null ? '' : ` · ${reading}`}`
    const here = ends.filter(at(box))
    const words = (rows: ReadonlyArray<NetworkRow>, framed = false): void => { drawing.texts.push({ id, rows, tone, framed, title }) }
    const named = { text: name, kind: 'name' as const, style: 'name' as const }
    const readingPart = reading === null ? [] : [{ text: reading, kind: 'reading' as const, style: 'reading' as const }]
    const element = DEVICES[node.class]
    if (node.class === 'bus') {
      const line = barLine(box, here)
      const vertical = line.x1 === line.x2
      const length = vertical ? line.y2 - line.y1 : line.x2 - line.x1
      // Its name in its bar where the bar runs along the box (the composer sized the box for it); beside a bar that
      // runs across it, on the side the bar leaves free, in a row at its middle.
      const inBar = !vertical && textWidth(name, 'busLabel') + NETWORK.barPadding <= length
      drawing.buses.push({ id, vertical, label: inBar ? name : '', tone, title: node.label, x: vertical ? line.x1 - BUS_PX / 2 : line.x1, y: vertical ? line.y1 : line.y1 - BUS_PX / 2, width: vertical ? BUS_PX : length, height: vertical ? length : BUS_PX })
      if (!inBar) {
        const rowY = vertical ? box.y + box.height / 2 - NETWORK_ROW / 2
          : line.y1 - box.y >= box.y + box.height - line.y1 ? line.y1 - BUS_PX / 2 - NETWORK.gap - NETWORK_ROW : line.y1 + BUS_PX / 2 + NETWORK.gap
        const left = vertical && line.x1 - box.x > box.x + box.width - line.x1
        const row = vertical
          ? (left ? { x: box.x, width: line.x1 - BUS_PX / 2 - NETWORK.gap - box.x, align: 'end' as const } : { x: line.x1 + BUS_PX / 2 + NETWORK.gap, width: box.x + box.width - line.x1 - BUS_PX / 2 - NETWORK.gap, align: 'start' as const })
          : { x: box.x, width: box.width, align: 'start' as const }
        words([{ ...row, y: rowY, height: NETWORK_ROW, parts: [named] }])
      }
    } else if (element !== undefined) {
      const centre = [box.x + box.width / 2, box.y + SYMBOL_PX / 2] as const
      segments.push(...here.flatMap(end => pipeSegments(`${id}:${end.join(',')}`, stub(end, centre, box), [], lineValue([end, end]), 'small')))
      drawing.devices.push({ id, element, x: centre[0], y: centre[1], on: conducting(id) === true, tone, title })
      // Its name, then its reading, on the row under its symbol; OpenBridge's alert frame marks it.
      words([{ x: box.x, y: box.y + SYMBOL_PX, width: box.width, height: VIGNETTE_ROW_PX, align: 'start', parts: [named, ...readingPart] }], true)
    } else if (node.class === 'stop' || node.class === 'boundary') {
      // Where the drawing stops, or meets another graph: OpenBridge's end cap on the line that arrives, its label beside the cap.
      let capRight = false
      for (const edge of edges) {
        const into = at(box)(edge.points.at(-1)!) ? 'out' : at(box)(edge.points[0]!) ? 'in' : null
        if (into === null) continue
        segments.push(stubEndSegment(`${edge.id}:end`, edge.drawn, into, lineValue(edge.points), 'small'))
        const end = into === 'out' ? edge.points.at(-1)! : edge.points[0]!
        capRight = Math.abs(end[0] - (box.x + box.width)) < 1
      }
      const room = NETWORK.cap + NETWORK.gap
      words([{ x: capRight ? box.x : box.x + room, y: box.y, width: box.width - room, height: box.height, align: capRight ? 'end' : 'start', parts: [named] }])
    } else if (node.class !== 'junction') {
      // A line element (a branch): one line through its box from end to end, its name over it and its reading under it.
      // Its ends on one face (the line turns back into the drawing) join along that face, clear of its words.
      const faces = new Set(here.map(([x, y]) => (Math.abs(x - box.x) < 1 ? 'left' : Math.abs(x - (box.x + box.width)) < 1 ? 'right' : Math.abs(y - box.y) < 1 ? 'top' : 'bottom')))
      const centre = [box.x + box.width / 2, here.length > 0 ? here.reduce((sum, end) => sum + end[1], 0) / here.length : box.y + box.height / 2] as const
      const value = conducting(id) === false ? 'empty' : 'open-generic'
      if (here.length === 2 && faces.size === 1 && (faces.has('left') || faces.has('right'))) {
        const inside = faces.has('left') ? box.x + NETWORK.symbol / 4 : box.x + box.width - NETWORK.symbol / 4
        const [a, b] = here as unknown as [Point, Point]
        segments.push(...pipeSegments(`${id}:turn`, [a, [inside, a[1]], [inside, b[1]], b], [], value, 'small'))
      } else segments.push(...here.flatMap(end => pipeSegments(`${id}:${end.join(',')}`, stub(end, centre, box), [], value, 'small')))
      words([
        { x: box.x, y: box.y, width: box.width, height: NETWORK_ROW, align: 'start', parts: [named] },
        ...(readingPart.length === 0 ? [] : [{ x: box.x, y: box.y + box.height - NETWORK_ROW, width: box.width, height: NETWORK_ROW, align: 'start' as const, parts: readingPart }]),
      ])
    }
  }
  return {
    width: px(section.layout.width),
    height: px(section.layout.height),
    segments,
    ...drawing,
  }
}
