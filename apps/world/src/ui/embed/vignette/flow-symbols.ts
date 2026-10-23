// A flow topology as drawn (architecture B3), in OpenBridge: the server's
// diagram-engine layout in grid units, one grid unit a row. Pipes, header bars
// and the caps where the drawing stops are connector-diagram segments; each
// item is the OpenBridge equipment its class and the media of its pipes make
// it (symbolOf): a device on an obc-automation-button at its centre with
// OpenBridge's glyph, a tank, a heat exchanger, a bus, or, for a fluid source
// (the lanes' hub), the registered vessel shape (vessel-symbol.ts).
// Bindings drive what each draws: a level fills a tank or the vessel, running
// and conducting turn a device on (ruling Q8), a position opens a valve and
// inserts the vessel's parts, a flow fills its pipe and points its chevron.
// An item takes OpenBridge's alert frame at the worst priority of its bound
// readings and of the active alerts on its element the sample carries, those
// expected after a first-out aside: an item whose every active alert is
// expected is outlined dashed instead (W2.3). A frozen sample shows no alert
// colour: an item that had an alert is outlined in OpenBridge's low-integrity
// colours instead, the last it showed (W8.1). Every named item says what a
// press opens (W6.1): its element, a group's members, a stop's far ends. A
// reading that is missing, bad or stale, or a frozen sample, reads as
// unknown: a static device or tank, a dashed pipe; never as off or empty. One
// outside its declared validity draws as unknown and writes "—".
import type { Segment } from '@oicl/connector-diagram'
import type { Observation } from '../../../core/observation/model.ts'
import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
import type { TopologyBinding, VignetteSection } from '../../../features/displays/compose/model.ts'
import { groupName, itemText } from '../../../features/displays/topology/layout.ts'
import { farState } from '../../../features/displays/topology/stops.ts'
import { TEXT_INSET, type FlowTextStyle } from '../../../features/displays/topology/text.ts'
import { VIGNETTE_ROW_PX } from './grid.ts'
import { chevronSegment, endStraight, pipeSegments, pipeValue, stubEndSegment, type PipeLook } from './pipe-segments.ts'
import { stub } from './network.ts'
import { activeState, observedInput, readingLook, toneOf, type AlertTone } from './readout.ts'
import type { VesselDrawing } from './vessel-symbol.ts'

type Topology = Extract<VignetteSection, { kind: 'topology' }>
type NodeView = Topology['nodes'][number]
type Point = readonly [number, number]
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
type Face = 'top' | 'right' | 'bottom' | 'left'

export type FlowSymbol = 'vessel' | 'tank' | 'exchanger' | 'mover' | 'generator' | 'valve' | 'breaker' | 'transformer' | 'source' | 'bus' | 'header' | 'junction' | 'end'

/** A line drawn at a node: its medium, and whether it leaves the node (flow runs from it). */
export type DrawnLine = { readonly kind: string; readonly out: boolean }

const isElectric = (kind: string): boolean => kind === 'electric-ac' || kind === 'electric-dc'

/**
 * The OpenBridge equipment a node is drawn as, by its class first, then by its drawn lines: an item is electrical only
 * where every line drawn to it is (a valve drawn with its motor's supply stays a valve); a mover generates only where
 * an electrical line leaves it, never because the line that drives it is all a drawing shows of it; a bar is a bus or
 * a header.
 */
export const symbolOf = (node: Pick<NodeView, 'class' | 'bindings'>, lines: ReadonlyArray<DrawnLine>, bar: boolean): FlowSymbol => {
  const electric = lines.length > 0 && lines.every(line => isElectric(line.kind))
  if (bar) return electric ? 'bus' : 'header'
  switch (node.class) {
    case 'source': return electric ? 'source' : 'vessel'
    case 'store': return 'tank'
    case 'transfer': return 'exchanger'
    case 'converter': return electric ? 'transformer' : 'exchanger'
    case 'mover': return lines.some(line => line.out && isElectric(line.kind)) ? 'generator' : 'mover'
    case 'switch': return electric ? 'breaker' : 'valve'
    // A sink whose flow turns it (a running binding) generates; one that only takes the flow ends the line.
    case 'sink': return node.bindings.some(binding => binding.role === 'running') ? 'generator' : 'end'
    case 'bus': case 'junction': return 'junction'
    case 'boundary': case 'stop': return 'end'
  }
}

/** A device's state: on, off, a position of travel (0 shut, 1 open), or not known. */
export type DeviceState = { readonly kind: 'on' | 'off' | 'unknown' } | { readonly kind: 'position'; readonly fraction: number }

export type Glyph = { readonly tag: `obi-${string}` } | { readonly tag: 'obc-valve-analog-two-way-icon'; readonly value: number }

/** OpenBridge's glyph for a device in a state; none for a breaker whose state is not known (an open glyph would claim one). */
export const glyphOf = (symbol: FlowSymbol, state: DeviceState, vertical: boolean): Glyph | null => {
  const word = state.kind === 'unknown' ? 'static' : state.kind === 'off' || (state.kind === 'position' && state.fraction <= 0) ? 'off' : 'on'
  switch (symbol) {
    case 'mover': return { tag: `obi-pump-${word}-${vertical ? 'vertical' : 'horizontal'}` }
    case 'generator': return { tag: `obi-electric-generator-ac-${word}` }
    case 'valve': return state.kind === 'position' ? { tag: 'obc-valve-analog-two-way-icon', value: Math.round(Math.min(1, Math.max(0, state.fraction)) * 100) } : { tag: 'obi-twoway-digital-static' }
    case 'breaker': return state.kind === 'unknown' ? null : { tag: `obi-switch-01-${word}` }
    case 'transformer': return { tag: word === 'static' ? 'obi-transformer-01' : `obi-transformer-01-${word}` }
    case 'source': return { tag: word === 'static' ? 'obi-sources-01' : `obi-sources-01-${word}` }
    default: return null
  }
}

/**
 * A line of an item's text: its name, its state word (or a group's count, or the word that says it stopped), the
 * command it does not follow, a reading; and the style it is set in (topology/text.ts), a vessel's readings larger.
 */
export interface FlowLine { readonly text: string; readonly kind: 'name' | 'word' | 'command' | 'reading'; readonly style: FlowTextStyle }

const DEVICES: ReadonlySet<FlowSymbol> = new Set(['mover', 'generator', 'valve', 'breaker', 'transformer', 'source'])

/**
 * How far inside the box it fills OpenBridge's tile draws its silhouette, per face, in px (OpenBridge 2.0.0, measured
 * in the drawing): a compact tank's and an exchanger's state container is padded 4 px within a 1 px border
 * (--automation-components-tanks-state-container-padding); below a tank's frame its empty readout cell keeps a 4 px
 * gap; an exchanger's domed caps stand 2 px inside its frame. A pipe runs on to it, so it meets the vessel (W6.4).
 */
export const SILHOUETTE: Readonly<Record<'tank' | 'exchanger', Readonly<Record<Face, number>>>> = {
  tank: { top: 5, right: 5, bottom: 9, left: 5 },
  exchanger: { top: 7, right: 5, bottom: 7, left: 5 },
}

/** A pipe's `end` that meets `box` on a face, run on along its last leg by that face's inset, to the silhouette inside it. */
export const toSilhouette = (points: ReadonlyArray<Point>, end: 'first' | 'last', box: Box, inset: Readonly<Record<Face, number>>): ReadonlyArray<Point> => {
  const ordered = end === 'last' ? [...points] : [...points].reverse()
  const [x, y] = ordered.at(-1)!
  const face: Face | null = Math.abs(x - box.x) < 1 ? 'left' : Math.abs(x - (box.x + box.width)) < 1 ? 'right' : Math.abs(y - box.y) < 1 ? 'top' : Math.abs(y - (box.y + box.height)) < 1 ? 'bottom' : null
  if (face === null) return points
  const by = inset[face]
  ordered[ordered.length - 1] = face === 'left' ? [x + by, y] : face === 'right' ? [x - by, y] : face === 'top' ? [x, y + by] : [x, y - by]
  return end === 'last' ? ordered : ordered.reverse()
}
/** A text line of the stacks the engine kept (flow-sizing.ts). */
export const FLOW_LINE_PX = 16
const passing = (state: DeviceState | undefined): boolean => state?.kind === 'on' || (state?.kind === 'position' && state.fraction > 0)
const shut = (state: DeviceState | undefined): boolean => state?.kind === 'off' || (state?.kind === 'position' && state.fraction <= 0)

export interface FlowDrawing {
  readonly width: number
  readonly height: number
  readonly segments: ReadonlyArray<Segment>
  /** Each at its symbol's centre (OpenBridge's `point` positioning). */
  /** `orientation`: OpenBridge's turn of a vertical symbol (a mover's glyph turns itself). */
  readonly devices: ReadonlyArray<{ readonly id: string; readonly element: string; readonly glyph: Glyph | null; readonly x: number; readonly y: number; readonly on: boolean; readonly unknown: boolean; readonly vertical: boolean; readonly orientation: 'horizontal' | 'verticalRight'; readonly tone: AlertTone | null; readonly title: string }>
  /** A tank's or the vessel's level in percent, null where not known; a vessel's parts each inserted 0..1, null where not known, in their groups. */
  readonly vessels: ReadonlyArray<Box & { readonly id: string; readonly element: string; readonly kind: 'tank' | 'exchanger' | 'vessel'; readonly level: number | null; readonly unknown: boolean; readonly tone: AlertTone | null; readonly title: string; readonly drawing?: VesselDrawing; readonly parts?: ReadonlyArray<ReadonlyArray<number | null>> }>
  readonly buses: ReadonlyArray<Box & { readonly id: string; readonly vertical: boolean; readonly title: string }>
  /** Each named item: its text, and what it is to a person (plan v5 contract 3). */
  readonly texts: ReadonlyArray<FlowItem>
  /** What the alerts of the items outlined as expected are expected after ("RX TRIP"), each once: the legend names it. */
  readonly expectedAfter: ReadonlyArray<string>
}

/**
 * A named item as drawn: its text at its place, and what a press on it opens (`targets`: the elements whose default
 * it opens, one for an item, its members for a group, the equipment a stop names; none where it carries no element),
 * the box its symbol and text cover (`area`, what a press and an outline take), and its `outline`: `abnormal` where
 * it does not follow a command (told to run, it stopped; a trip has not stopped it), `expected` where every active
 * alert on it is expected after a first-out, where no alarm frames it; `low-integrity` in place of any of them while
 * the sample is frozen and an alert stood on it: no frame, no alarm colour, nothing that reads as current (W8.1).
 */
export interface FlowItem {
  readonly id: string
  readonly kind: 'item' | 'group' | 'stop'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly lines: ReadonlyArray<FlowLine>
  readonly tone: AlertTone | null
  readonly title: string
  readonly targets: ReadonlyArray<{ readonly element: string; readonly label: string }>
  readonly area: Box
  readonly outline: 'abnormal' | 'expected' | 'low-integrity' | null
  /** Where its text stands beside its symbol: its first line keeps clear of the symbol's alert frame there. */
  readonly side: 'top' | 'right' | 'bottom' | 'left'
}

export const flowDrawing = (section: Topology, observations: ReadonlyArray<Observation>, alerts: ReadonlyArray<AlertRow>, frozen: boolean): FlowDrawing => {
  const px = (grid: number): number => grid * VIGNETTE_ROW_PX
  const byId = new Map(section.nodes.map(node => [node.id, node]))
  const viewEdges = new Map(section.edges.map(edge => [edge.id, edge]))
  const observed = new Map(observations.map(observation => [observation.ref, observation]))
  // A reading the drawing can draw from: none while the sample is frozen, or where it is missing, bad, stale, or
  // outside the validity its observable declares (not-applicable).
  const usable = (binding: TopologyBinding): Observation | null => {
    const observation = observed.get(binding.ref)
    return frozen || observation === undefined || observation.value === null || ['bad', 'stale', 'not-applicable'].includes(observation.quality) ? null : observation
  }
  // What its text writes: a reading outside its validity reads "—", one not known "?" (stale included, as the drawing reads it).
  const shownReading = (binding: TopologyBinding): Observation | undefined => {
    const observation = frozen ? undefined : observed.get(binding.ref)
    return observation?.quality === 'stale' ? undefined : observation
  }
  const percent = (binding: TopologyBinding): number | null => {
    const value = usable(binding)?.value
    return typeof value !== 'number' || (binding.unit !== '%' && binding.unit !== '1') ? null : Math.min(100, Math.max(0, binding.unit === '%' ? value : value * 100))
  }
  const stateOf = (node: NodeView): DeviceState => {
    const position = node.bindings.find(binding => binding.role === 'position' || binding.quantity === 'fraction')
    if (position !== undefined) {
      const value = percent(position)
      return value === null ? { kind: 'unknown' } : { kind: 'position', fraction: value / 100 }
    }
    const switching = node.bindings.find(binding => binding.role === 'running' || binding.role === 'conducting')
    const on = switching === undefined ? null : activeState(usable(switching)?.value, switching.states)
    return on === null ? { kind: 'unknown' } : { kind: on ? 'on' : 'off' }
  }
  // Active alerts of the drawn object by the element they are on.
  const alerted = new Map<string, Array<AlertRow>>()
  for (const row of alerts) {
    const subject = row.alert.subject
    if (row.objectId !== section.objectId || row.state === 'returned-unack' || subject === undefined || !('element' in subject)) continue
    alerted.set(subject.element, [...alerted.get(subject.element) ?? [], row])
  }
  const rowsAt = (nodes: ReadonlyArray<NodeView>): ReadonlyArray<AlertRow> => nodes.flatMap(node => alerted.get(node.element ?? node.id) ?? [])
  // An alert expected after a first-out colours nothing: its item is outlined dashed instead, while every one is.
  const toneAt = (nodes: ReadonlyArray<NodeView>): AlertTone | null => {
    const tones = [...nodes.flatMap(node => node.bindings.map(binding => toneOf(observed.get(binding.ref)?.priority))), ...rowsAt(nodes).filter(row => row.expected === undefined).map(row => toneOf(row.priority ?? undefined))]
    return (['critical', 'alarm', 'warning', 'caution'] as const).find(level => tones.includes(level)) ?? null
  }
  const expectedAt = (nodes: ReadonlyArray<NodeView>): boolean => rowsAt(nodes).length > 0 && rowsAt(nodes).every(row => row.expected !== undefined)

  const boxes = new Map(section.layout.nodes.map(node => [node.id, { x: px(node.x), y: px(node.y), width: px(node.width), height: px(node.height) }]))
  const inside = (box: Box) => (point: Point): boolean => point[0] >= box.x - 1 && point[0] <= box.x + box.width + 1 && point[1] >= box.y - 1 && point[1] <= box.y + box.height + 1
  const edges = section.layout.edges.map(edge => ({
    ...edge,
    view: viewEdges.get(edge.id) ?? viewEdges.get(edge.id.replace(/\.\d+$/, '')),
    points: edge.points.map(([x, y]) => [px(x), px(y)] as const),
    gaps: edge.gaps.map(([x, y]) => [px(x), px(y)] as const),
  }))
  const endsAt = (id: string) => edges.filter(edge => inside(boxes.get(id)!)(edge.points[0]!) || inside(boxes.get(id)!)(edge.points.at(-1)!))
  const thin = (box: Box): boolean => Math.min(box.width, box.height) < VIGNETTE_ROW_PX
  const symbols = new Map(section.layout.nodes.flatMap(node => {
    const view = byId.get(node.id)
    if (view === undefined) return []
    const box = boxes.get(node.id)!
    // A routed line runs from its source port: it leaves the node its first point is at.
    const lines = endsAt(node.id).flatMap(edge => (edge.view === undefined ? [] : [{ kind: edge.view.mediumKind, out: inside(box)(edge.points[0]!) }]))
    return [[node.id, symbolOf(view, lines, thin(box))] as const]
  }))
  const states = new Map([...symbols.keys()].map(id => [id, stateOf(byId.get(id)!)]))
  // A pipe to where the drawing stops ends on a straight of its own, never with its cap in a bend (W6.3).
  const stopAt = (point: Point): Box | undefined => [...boxes].find(([id, box]) => symbols.get(id) === 'end' && inside(box)(point))?.[1]
  // A pipe to a tank or an exchanger runs on to its silhouette, inside the box OpenBridge's tile fills (W6.4).
  const vesselAt = (point: Point): { readonly box: Box; readonly inset: Readonly<Record<Face, number>> } | undefined => {
    const [id, box] = [...boxes].find(([key, entry]) => (symbols.get(key) === 'tank' || symbols.get(key) === 'exchanger') && inside(entry)(point)) ?? []
    return id === undefined ? undefined : { box: box!, inset: SILHOUETTE[symbols.get(id) as 'tank' | 'exchanger'] }
  }
  const pipes = new Map(edges.map(edge => {
    const [first, last] = [stopAt(edge.points[0]!), stopAt(edge.points.at(-1)!)]
    const ended = last === undefined ? edge.points : endStraight(edge.points, 'last', last)
    const both = first === undefined ? ended : endStraight(ended, 'first', first)
    const [into, from] = [vesselAt(edge.points.at(-1)!), vesselAt(edge.points[0]!)]
    const reached = into === undefined ? both : toSilhouette(both, 'last', into.box, into.inset)
    return [edge.id, from === undefined ? reached : toSilhouette(reached, 'first', from.box, from.inset)] as const
  }))
  // Where a chevron may not stand: on the drawing's text, its symbols and its bars.
  const avoid: ReadonlyArray<Box> = [
    ...section.layout.nodes.flatMap(node => (node.text === undefined ? [] : [{ x: px(node.text.x), y: px(node.text.y), width: px(node.text.width), height: px(node.text.height) }])),
    ...[...boxes].filter(([id]) => symbols.get(id) !== 'end').map(([, box]) => box),
  ]

  // A pipe reads its flow where it is bound (a stop's, the lines it stands for: forward where any flows); else it is
  // open unless a switch at either end reads shut, never emptied by what is not known.
  const lookOf = (edge: (typeof edges)[number]): PipeLook | 'open' => {
    const flows = edge.view?.bindings.filter(binding => binding.role === 'flow') ?? []
    if (flows.length > 0) {
      const values = flows.map(flow => usable(flow)?.value)
      return values.some(value => typeof value !== 'number') ? 'unknown' : values.some(value => (value as number) > 0) ? 'forward' : values.some(value => (value as number) < 0) ? 'reverse' : 'none'
    }
    const ends = [edge.points[0]!, edge.points.at(-1)!].map(point => [...boxes].find(([, box]) => inside(box)(point))?.[0])
    return ends.some(id => id !== undefined && ['valve', 'breaker'].includes(symbols.get(id) ?? '') && shut(states.get(id))) ? 'none' : 'open'
  }
  // Principal lines medium, auxiliary and electric ones small (U-20); headers large.
  const sizeOf = (edge: (typeof edges)[number]): 'small' | 'medium' => edge.view?.mediumKind.startsWith('electric') === true || edge.view?.auxiliary === true ? 'small' : 'medium'
  const segments: Segment[] = edges.flatMap(edge => {
    const look = lookOf(edge)
    const size = sizeOf(edge)
    const value = look === 'open' ? 'open-generic' : pipeValue(look)
    const points = pipes.get(edge.id)!
    const chevron = look === 'forward' || look === 'reverse' ? chevronSegment(edge.id, points, edge.gaps, value, size, look === 'reverse', avoid) : null
    return [...pipeSegments(edge.id, points, edge.gaps, value, size), ...(chevron === null ? [] : [chevron])]
  })

  const drawing: { devices: FlowDrawing['devices'][number][]; vessels: FlowDrawing['vessels'][number][]; buses: FlowDrawing['buses'][number][]; texts: FlowItem[] } = { devices: [], vessels: [], buses: [], texts: [] }
  for (const node of section.layout.nodes) {
    const view = byId.get(node.id)
    const symbol = symbols.get(node.id)
    if (view === undefined || symbol === undefined) continue
    const box = boxes.get(node.id)!
    const members = (node.members ?? [node.id]).flatMap(id => byId.get(id) ?? [])
    // Frozen, no alarm colour: the alert it last had shows as its low-integrity outline.
    const last = toneAt(members)
    const tone = frozen ? null : last
    const element = view.element ?? view.id
    const name = members.length > 1 ? groupName(members.map(member => member.shortLabel ?? member.label)) : view.shortLabel ?? view.label
    // A group says how many of its members are in its state's word ("RUN 1/2", "STOP 2/2"), a lone item its state word
    // in the words its observable declares, or the word that says it stopped; on the line under it the command it does
    // not follow (the observation's why), so a demand never reads as the state; then its readings. Each line stands in
    // the slot the layout kept for it, in its order; an empty one is left out.
    const readingOf = (binding: TopologyBinding, valueType: 'number' | 'enum') => readingLook(view.label, valueType, binding.states, observedInput({ ...binding, thresholds: [] }, shownReading(binding)))
    const written = itemText(view.bindings)
    const stateLines = (binding: TopologyBinding, commanded: boolean): ReadonlyArray<FlowLine> => {
      const word = binding.states === undefined ? '' : readingOf(binding, 'enum').text
      const why = usable(binding)?.why
      const command: ReadonlyArray<FlowLine> = commanded ? [{ text: why ?? '', kind: 'command', style: 'command' }] : []
      if (binding.role !== 'stopped') return [{ text: word, kind: 'word', style: 'word' }, ...command]
      // The word that says it stopped while it holds; while a command to stop it stands unmet its other word, with that
      // command; else nothing ("?" or "—" where it is not known, or outside its validity).
      const stopped = activeState(usable(binding)?.value, binding.states)
      return [{ text: stopped === true || usable(binding) === null || why !== undefined ? word : '', kind: 'word', style: 'word' }, ...command]
    }
    const groupLines = (): ReadonlyArray<FlowLine> => {
      const states = members.flatMap(member => itemText(member.bindings).state ?? [])
      const declared = states[0]?.states ?? []
      const [on, off] = [declared.find(state => state.active === true)?.label, declared.find(state => state.active !== true)?.label]
      const looks = members.map(stateOf)
      const running = looks.filter(state => passing(state)).length
      const count = looks.some(state => state.kind === 'unknown') ? `${on ?? ''} ?/${members.length}` : running > 0 || off === undefined ? `${on ?? ''} ${running}/${members.length}` : `${off} ${members.length}/${members.length}`
      const why = states.flatMap(state => usable(state)?.why ?? [])[0]
      return [{ text: count.trim(), kind: 'word', style: 'word' }, ...(members.some(member => itemText(member.bindings).commanded) ? [{ text: why ?? '', kind: 'command' as const, style: 'command' as const }] : [])]
    }
    // A stop on a power line writes the state of what it names, in their words: all of them ("LIVE"), none ("DEAD"),
    // or how many ("LIVE 1/2"); "?" while one is not known. Never the line's own, which its pipe draws.
    const stopWord = (): string => {
      const states = (view.stop?.far ?? []).map(end => farState(end.bindings))
      const declared = states[0]?.states ?? []
      if (states.length === 0 || states.some(state => state === undefined || JSON.stringify(state.states) !== JSON.stringify(declared))) return ''
      const on = states.map(state => activeState(usable(state!)?.value, state!.states))
      const [live, dead] = [declared.find(state => state.active === true)?.label ?? '', declared.find(state => state.active !== true)?.label ?? '']
      const count = on.filter(state => state === true).length
      return on.some(state => state === null) ? '?' : count === on.length ? live : count === 0 ? dead : `${live} ${count}/${on.length}`
    }
    // A quantity read in turn reads on the widest instrument whose flag holds, else the narrowest; not known where a flag is not.
    const inRange = (reading: ReadonlyArray<TopologyBinding>): TopologyBinding | null => {
      for (let at = reading.length - 1; at > 0; at -= 1) {
        const flag = usable({ ...reading[at]!, ref: reading[at]!.while! })?.value
        if (typeof flag !== 'boolean') return null
        if (flag) return reading[at]!
      }
      return reading[0]!
    }
    // A vessel (a tank, an exchanger, the lanes' hub) writes its readings larger.
    const readingStyle: FlowTextStyle = symbol === 'tank' || symbol === 'exchanger' || symbol === 'vessel' ? 'vesselReading' : 'reading'
    const sized: ReadonlyArray<FlowLine> = view.stop !== undefined
      ? [...view.stop.lines.map(text => ({ text, kind: 'name' as const, style: 'name' as const })), ...((node.text?.lines ?? 1) > view.stop.lines.length ? [{ text: stopWord(), kind: 'word' as const, style: 'word' as const }] : [])]
      : members.length > 1 ? [{ text: name, kind: 'name', style: 'name' }, ...groupLines()]
      : [
        { text: name, kind: 'name', style: 'name' },
        ...(written.state === null ? [] : stateLines(written.state, written.commanded)),
        ...written.readings.map(reading => {
          const binding = inRange(reading)
          if (binding === null) return { text: '?', kind: 'reading' as const, style: readingStyle }
          const look = readingOf(binding, 'number')
          const value = look.unit === '' ? look.text : `${look.text} ${look.unit}`
          // A share says what it reads (its Pack's word, "LVL", "PWR"), in the room the sizing reserved for the word beside the value.
          return { text: binding.word === undefined ? value : `${binding.word} ${value}`, kind: 'reading' as const, style: readingStyle }
        }),
      ]
    const lines = sized.filter(line => line.text !== '')
    const title = [view.label, ...lines.slice(1).map(line => line.text)].join(' · ')
    if (node.text !== undefined) {
      const shown = sized.slice(0, Math.max(view.stop?.lines.length ?? 1, node.text.lines)).filter(line => line.text !== '')
      // A command not followed is outlined, else alerts all expected, where no alarm frames the item; the frame says more.
      const outline = frozen ? (last !== null || expectedAt(members) ? 'low-integrity' as const : null)
        : tone !== null ? null : lines.some(line => line.kind === 'command') ? 'abnormal' as const : expectedAt(members) ? 'expected' as const : null
      // What a press opens: a stop the equipment it names, a group its members, an item its element; nothing without one.
      const targets = view.stop !== undefined ? view.stop.far.flatMap(end => (end.element === undefined ? [] : [{ element: end.element, label: end.label }]))
        : members.flatMap(member => (member.element === undefined ? [] : [{ element: member.element, label: member.label }]))
      const laid = { x: px(node.text.x), y: px(node.text.y), width: px(node.text.width), height: px(node.text.height) }
      // Its lines keep clear of the alert frame round its symbol by the inset the sizing reserved on that side (U-14).
      const text = node.text.side === 'right' ? { ...laid, x: laid.x + TEXT_INSET, width: laid.width - TEXT_INSET } : node.text.side === 'left' ? { ...laid, width: laid.width - TEXT_INSET } : laid
      // A device's symbol is its two cells at its centre; anything else covers its box.
      const drawn = DEVICES.has(symbol) ? { x: box.x + box.width / 2 - VIGNETTE_ROW_PX, y: box.y + box.height / 2 - VIGNETTE_ROW_PX, width: 2 * VIGNETTE_ROW_PX, height: 2 * VIGNETTE_ROW_PX } : box
      const area = { x: Math.min(drawn.x, text.x), y: Math.min(drawn.y, text.y), width: Math.max(drawn.x + drawn.width, text.x + text.width) - Math.min(drawn.x, text.x), height: Math.max(drawn.y + drawn.height, text.y + text.height) - Math.min(drawn.y, text.y) }
      drawing.texts.push({ id: node.id, kind: view.stop !== undefined ? 'stop' : members.length > 1 ? 'group' : 'item', x: text.x, y: text.y, width: text.width, lines: shown, tone, title, targets, area, outline, side: node.text.side })
    }
    const counted = members.map(stateOf)
    const state: DeviceState = members.length > 1
      ? counted.some(entry => entry.kind === 'on') ? { kind: 'on' } : counted.some(entry => entry.kind === 'unknown') ? { kind: 'unknown' } : { kind: 'off' }
      : states.get(node.id)!
    const ports = Object.values(node.ports)
    const vertical = ports.some(port => port.face === 'top' || port.face === 'bottom') && !ports.some(port => port.face === 'left' || port.face === 'right')
    if (DEVICES.has(symbol)) {
      const centre = [box.x + box.width / 2, box.y + box.height / 2] as const
      drawing.devices.push({ id: node.id, element, glyph: glyphOf(symbol, state, vertical), x: centre[0], y: centre[1], on: passing(state), unknown: state.kind === 'unknown', vertical, orientation: vertical && symbol !== 'mover' ? 'verticalRight' : 'horizontal', tone, title })
    } else if (symbol === 'tank' || symbol === 'exchanger' || symbol === 'vessel') {
      const level = view.bindings.find(binding => binding.role === 'level')
      // A vessel's parts hang in by their position bindings, in their groups: a part's inserted share, 1 fully in, as the role declares.
      const positions = view.bindings.filter(binding => binding.role === 'position')
      const parts = [...new Set(positions.map(binding => binding.group))].map(group => positions.filter(binding => binding.group === group).map(binding => { const value = percent(binding); return value === null ? null : value / 100 }))
      const nozzles = Object.values(node.ports).map(port => ({ x: px(port.x), y: px(port.y), face: port.face as Face }))
      drawing.vessels.push({
        id: node.id, element, kind: symbol, ...box, level: level === undefined ? null : percent(level), unknown: level !== undefined && percent(level) === null, tone, title,
        ...(symbol === 'vessel' ? { drawing: { span: { x: 0, width: box.width }, nozzles, core: parts.length > 0 ? 'overlap' as const : null }, parts } : {}),
      })
    } else if (symbol === 'bus' || symbol === 'header') {
      const horizontal = box.width >= box.height
      const at = horizontal ? box.y + box.height / 2 : box.x + box.width / 2
      if (symbol === 'header') segments.push({ kind: 'straight', connectionId: node.id, value: 'open-generic', size: 'large', ...(horizontal ? { x1: box.x, y1: at, x2: box.x + box.width, y2: at } : { x1: at, y1: box.y, x2: at, y2: box.y + box.height }) })
      else drawing.buses.push({ id: node.id, vertical: !horizontal, title, ...(horizontal ? { x: box.x, y: at - 8, width: box.width, height: 16 } : { x: at - 8, y: box.y, width: 16, height: box.height }) })
    } else if (symbol === 'junction') {
      // A junction drawn as a box: its lines meet at its centre.
      const centre = [box.x + box.width / 2, box.y + box.height / 2] as const
      for (const edge of endsAt(node.id)) {
        const end = inside(box)(edge.points[0]!) ? edge.points[0]! : edge.points.at(-1)!
        const look = lookOf(edge)
        segments.push(...pipeSegments(`${node.id}:${end.join(',')}`, stub(end, centre, box), [], look === 'open' ? 'open-generic' : pipeValue(look), sizeOf(edge)))
      }
    } else if (symbol === 'end') {
      // Where the drawing stops, or meets another graph: OpenBridge's end cap on the line that arrives.
      for (const edge of endsAt(node.id)) {
        const out = inside(box)(edge.points.at(-1)!)
        const look = lookOf(edge)
        segments.push(stubEndSegment(`${edge.id}:end`, pipes.get(edge.id)!, out ? 'out' : 'in', look === 'open' ? 'open-generic' : pipeValue(look), sizeOf(edge)))
      }
    }
  }
  const outlinedExpected = new Set(drawing.texts.filter(text => text.outline === 'expected').map(text => text.id))
  const expectedAfter = [...new Set(section.layout.nodes.filter(node => outlinedExpected.has(node.id))
    .flatMap(node => rowsAt((node.members ?? [node.id]).flatMap(id => byId.get(id) ?? [])).flatMap(row => row.expected?.after ?? [])))]
  return { width: px(section.layout.width), height: px(section.layout.height), segments, ...drawing, expectedAfter }
}
