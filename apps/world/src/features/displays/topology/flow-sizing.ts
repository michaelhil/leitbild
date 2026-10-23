// A flow drawing's sizing from the topology contract alone (architecture A6,
// audit B11): a bus that joins more than two lines, and a header (a junction
// whose ports, more than two, are one circuit), draw as bars; a switch takes
// its neighbours' lane; alike nodes group by kind; flow into a sink or
// boundary that leads nowhere ends without a stop; nothing is chained in line,
// and drawing ids are the graph's node and edge ids. A store stands two cells
// by four, as OpenBridge's tank does, and the lanes' hub as the vessel it is
// drawn as, its head above its nozzles. Each item writes its name and under
// it its state (layout.ts itemText): its state word, or the word that says it
// stopped, and on the line below the command it may not follow; then, where
// there is room, its readings. A group writes its members' word and how many
// of them say it, and the command they may not follow.
// The ceilings are today's displays': a drawing across lanes keeps the unit
// overview's twelve crossings, one within a lane an equipment detail's four;
// three bends an edge, a fourth only where three draw nothing. The layout
// comes back in grid units.
import { layoutDiagram, type DiagramProfile } from '../diagram/index.ts'
import { unitSymbol, type Observable } from '../../../core/observation/model.ts'
import type { TopologyGraph, TopologyNode } from '../../../core/observation/topology.ts'
import { flowPlan, type FlowSizing } from './flow.ts'
import { groupName, itemText, type TopologyLayout } from './layout.ts'
import type { ScopedTopology } from './scope.ts'
import { farState, stopLabel, stopLines, stopStated, type DrawnStop, type StopWords } from './stops.ts'
import { FLOW_TEXT, FLOW_TRACE, TEXT_INSET, textFigures, textWidth, type FlowTextStyle } from './text.ts'

/**
 * The renderer's grid pitch and its text lines, each as high and as wide as Noto Sans sets it (text.ts) at its
 * longest: a name or a stop's label as written; a state word at its longest declared word, or "?"; the command an item
 * may not follow at "CMD" and the end of travel it is told to (its first active or inactive word), or for an item
 * with a position, to a position ("CMD 100 %"), or, for an item that says it stopped, at the words that say so; a reading at its word, a value of so many figures, or, read over
 * decades, a two-digit power of ten ("8.8×10⁻¹¹"), and its unit's symbol. A value takes five figures ("15.51",
 * "100.0"), seven where instruments read it in turn (a count to a million). A vessel (a tank, an exchanger, the
 * lanes' hub) writes its readings larger.
 */
const GRID = 24
export const VALUE_FIGURES = 5
export const IN_TURN_FIGURES = 7
/** A value read over decades at its longest. */
export const DECADES_TEXT = '8.8×10⁻¹¹'
/** What a word reads while its reading is not known, or outside its declared validity. */
const UNKNOWN_WORDS = ['?', '—']
/** The vessel's head and flange above its first nozzle, and its bottom below its last. */
const VESSEL_ENDS = { top: 2 * GRID, bottom: GRID }

const limits = { symbols: 60, symbolsPerPartition: 12, sharedSymbols: 30, partitions: 8 } as const
type Detail = DiagramProfile['fit'][number]['detail']
const profile = (crossings: number, bendsPerEdge: number, detail: Detail): DiagramProfile => ({
  grid: GRID, cell: GRID, pipe: { outline: 6, cornerRadius: 8, crossingHalfGap: 5, trackGap: 4 }, textClearance: 9, frameMargin: 1, flapHeight: 0, flapLabelPadding: 0,
  limits: { ...limits, crossings, bendsPerEdge },
  fit: (['right', 'partitionsBelow', 'allBelow'] as const).map(text => ({ detail, text })),
})
/**
 * Across lanes, and within one lane or none, at each detail (every line, or the required ones): today's three bends
 * an edge first; a fourth only for a drawing that three refuse (a line-up from a mover and a header to the transfer
 * in every lane), so every drawing three allow stays as it is.
 */
export const flowProfiles = (detail: Detail) => ({
  lanes: [profile(12, 3, detail), profile(12, 4, detail)],
  lane: [profile(4, 3, detail), profile(4, 4, detail)],
}) as const

/** A header: a junction whose ports, more than two, are all one circuit. */
const isHeader = (node: TopologyNode): boolean => node.class === 'junction' && node.ports.length > 2 && new Set(node.ports.map(port => port.circuit ?? port.id)).size === 1
const TALL: ReadonlySet<string> = new Set(['store'])
/** Items drawn as a vessel (flow-symbols.ts symbolOf), whose readings are set larger: a tank, an exchanger, a source or converter of no power. */
const VESSELS: ReadonlySet<string> = new Set(['store', 'transfer'])
const POWERED: ReadonlySet<string> = new Set(['electric-ac', 'electric-dc'])

/** A name without its last word, the one alike items differ by ("Unit X A" → "Unit X"); a one-word name whole. */
export const nameStem = (name: string): string => {
  const words = name.trim().split(/\s+/)
  return words.length < 2 ? name.trim() : words.slice(0, -1).join(' ')
}

/** What the sizing reads of a bound observable: its unit, its declared state words, and whether it reads over decades. */
export type DeclaredOf = (ref: string) => Pick<Observable, 'unit' | 'states' | 'decades'> | undefined

/** `words`: how its stops write their labels (stops.ts): flowLayout sets them on one line, else on two, where it finds room. */
export const flowSizing = (graph: TopologyGraph, declaredOf: DeclaredOf, words: StopWords = 'inline'): FlowSizing<null> => {
  const classOf = new Map(graph.nodes.map(node => [node.id, node.class]))
  // A bus joins more than two lines; one with fewer (a battery, an inverter, a load at the end of a line) is an item on its line.
  const lines = new Map<string, number>()
  for (const edge of graph.edges) for (const end of [edge.from.node, edge.to.node]) lines.set(end, (lines.get(end) ?? 0) + 1)
  const leaving = new Set(graph.edges.map(edge => edge.from.node))
  const label = (node: TopologyNode): string => node.shortLabel ?? node.label
  const line = (width: number, required: boolean, style: FlowTextStyle = 'name') => ({ width: Math.max(GRID, TEXT_INSET + width), height: FLOW_TEXT[style].line, required })
  const widest = (texts: ReadonlyArray<string>, style: FlowTextStyle): number => Math.max(...texts.map(text => textWidth(text, style)))
  type Binding = TopologyNode['bindings'][number]
  const labels = (binding: Binding): ReadonlyArray<string> => declaredOf(binding.ref)?.states?.map(state => state.label) ?? []
  /** The ends of an item's travel, as a drawing names them: its first active word and its first other. */
  const ends = (binding: Binding): ReadonlyArray<string> => {
    const states = declaredOf(binding.ref)?.states ?? []
    return [states.find(state => state.active === true), states.find(state => state.active !== true)].flatMap(state => (state === undefined ? [] : [state.label]))
  }
  const command = (bindings: ReadonlyArray<Binding>, positioned: boolean) =>
    line(widest([...bindings.flatMap(ends).map(word => `CMD ${word}`), ...(positioned ? ['CMD 100 %'] : []), ...UNKNOWN_WORDS], 'command'), true)
  const reading = (chain: ReadonlyArray<Binding>, style: FlowTextStyle): number => Math.max(...chain.map(binding => {
    const declared = declaredOf(binding.ref)
    const unit = declared === undefined ? '' : unitSymbol(declared.unit)
    const figures = textFigures(chain.length > 1 ? IN_TURN_FIGURES : VALUE_FIGURES, style)
    const value = declared?.decades === true ? Math.max(figures, textWidth(DECADES_TEXT, style)) : figures
    return (binding.word === undefined ? 0 : textWidth(`${binding.word} `, style)) + value + (unit === '' ? 0 : textWidth(` ${unit}`, style))
  }))
  return {
    key: 'vignette-flow-13',
    visible: () => true,
    silent: edge => ['sink', 'boundary'].includes(classOf.get(edge.to.node) ?? '') && !leaving.has(edge.to.node),
    bar: node => (node.class === 'bus' && (lines.get(node.id) ?? 0) > 2) || isHeader(node),
    infersLane: node => node.class === 'switch',
    // Only alike items are drawn as one (W3.5): one kind and one name but for its last word ("Unit X A", "Unit X B"),
    // so a group never hides a different item of that kind among its members ("Unit Y", "Unit Z A").
    groupKey: node => `${node.kind}|${nameStem(label(node))}`,
    chain: () => [],
    itemId: node => node.id,
    edgeId: edge => edge.id,
    label,
    item: item => {
      const grouped = item.members.length > 1
      const text = grouped ? groupName(item.members.map(label)) : label(item.node)
      // A group says how many of its members say its word ("RUN 2/2", "STOP 2/2", "RUN ?/2"); a lone item its state
      // and its readings. A state its item may not follow (a command it is given, a trip that stops it) keeps a line
      // for the command under it.
      const written = itemText(item.node.bindings)
      const vessel = item.role === 'hub'
      const powered = item.node.ports.some(port => port.media.some(medium => POWERED.has(graph.media.find(entry => entry.id === medium)?.kind ?? '')))
      const style = vessel || VESSELS.has(item.node.class) || ((item.node.class === 'source' || item.node.class === 'converter') && !powered) ? 'vesselReading' as const : 'reading' as const
      const positioned = item.members.some(member => member.bindings.some(binding => binding.role === 'position'))
      const states = item.members.flatMap(member => itemText(member.bindings).state ?? [])
      const count = (word: string) => [`${word} ${item.members.length}/${item.members.length}`, `${word} ?/${item.members.length}`]
      const lines = [line(textWidth(text, 'name'), true), ...(grouped ? [
        line(widest([...states.flatMap(ends).flatMap(count), ...UNKNOWN_WORDS], 'word'), true),
        ...(item.members.some(member => itemText(member.bindings).commanded) ? [command(states, positioned)] : []),
      ] : [
        ...(written.state === null ? [] : [line(widest([...labels(written.state), ...UNKNOWN_WORDS], 'word'), true), ...(!written.commanded ? []
          // The command to stop an item that says it stopped is reserved as long as the words that say so ("CMD trip").
          : written.state.role === 'stopped' ? [line(widest([...labels(written.state), ...UNKNOWN_WORDS], 'word'), true)] : [command([written.state], positioned)])]),
        ...written.readings.map(chain => line(reading(chain, style), false, style)),
        // What it traces, under its readings; an exchanger traces in its tile.
        ...(item.node.class !== 'transfer' && item.node.bindings.some(binding => binding.trace === true) ? [{ width: TEXT_INSET + FLOW_TRACE.width, height: FLOW_TRACE.line, required: false }] : []),
      ])]
      const cells = vessel || TALL.has(item.node.class) ? { width: 2, height: 4 } : { width: 2, height: 2 }
      return { label: text, node: { cells, portInset: 0, text: { lines }, frameable: false, ...(vessel ? { ends: VESSEL_ENDS } : {}) }, keep: null }
    },
    // A stop writes "to" or "from" and what lies beyond (stops.ts), and on a power line the state of what it names.
    stop: stop => {
      const far = stop.others.map(other => graph.nodes.find(node => node.id === other.node)!)
      const states = far.flatMap(node => farState(node.bindings) ?? [])
      return { lines: [
        ...stopLines(words, stop.direction, far.map(label)).map(text => line(textWidth(text, 'name'), true)),
        ...(stopStated(graph, stop) ? [line(widest([...states.flatMap(ends).flatMap(word => [word, `${word} ${far.length}/${far.length}`]), ...UNKNOWN_WORDS], 'word'), true)] : []),
      ] }
    },
  }
}

/** Two bars joined only to each other have nowhere to stand (the engine refuses them): such a scope draws nothing. */
const barsOnlyJoinBars = (graph: ReturnType<typeof flowPlan>['graph']): boolean => {
  const bars = new Set(graph.nodes.filter(node => node.role === 'bar').map(node => node.id))
  const neighbours = (id: string): ReadonlyArray<string> => graph.edges.flatMap(edge => (edge.from.node === id ? [edge.to.node] : edge.to.node === id ? [edge.from.node] : []))
  return graph.edges.some(edge => bars.has(edge.from.node) && bars.has(edge.to.node) && [edge.from.node, edge.to.node].every(bar => neighbours(bar).every(other => bars.has(other))))
}

/** Where a drawing stops, by its layout id. */
export type DrawnStops = Readonly<Record<string, DrawnStop>>

/**
 * A scoped flow graph laid out for a room in grid units, or null where no drawing verifies within its ceilings. Its
 * items write every line where any drawing has room for them, before their stops' words: the stops write "to" and
 * "from" before what they name on one line, else on a line above (the four-loop overview's stops in its loops), else
 * name what lies beyond bare, every name kept; only where none of these has room do the items keep their required
 * lines alone.
 */
export const flowLayout = (scoped: ScopedTopology, room: { readonly columns: number; readonly rows: number }, declaredOf: DeclaredOf): { readonly layout: TopologyLayout; readonly stops: DrawnStops } | null => {
  for (const detail of ['full', 'required'] as const) {
    for (const words of ['inline', 'stacked', 'bare'] as const) {
      const drawn = flowLayoutWith(scoped, room, declaredOf, words, detail)
      if (drawn === null) return null
      if (drawn !== 'no room') return drawn
      if (scoped.stubs.length === 0) break
    }
  }
  return null
}

const flowLayoutWith = (scoped: ScopedTopology, room: { readonly columns: number; readonly rows: number }, declaredOf: DeclaredOf, words: StopWords, detail: Detail): { readonly layout: TopologyLayout; readonly stops: DrawnStops } | null | 'no room' => {
  const sizing = flowSizing(scoped.graph, declaredOf, words)
  const planned = flowPlan(scoped, sizing)
  if (planned.graph.nodes.length === 0 || barsOnlyJoinBars(planned.graph)) return null
  const lanes = new Set(planned.graph.nodes.flatMap(node => (node.partition === undefined ? [] : [node.partition.key]))).size
  const ladder = lanes > 1 ? flowProfiles(detail).lanes : flowProfiles(detail).lane
  const fit = { maxWidth: room.columns * GRID, maxHeight: room.rows * GRID }
  const first = layoutDiagram(planned.graph, ladder[0], fit)
  const result = first.ok ? first : layoutDiagram(planned.graph, ladder[1], fit)
  if (!result.ok) return 'no room'
  const grid = (value: number): number => value / GRID
  const box = <T extends { readonly x: number; readonly y: number; readonly width: number; readonly height: number }>(at: T) => ({ x: grid(at.x), y: grid(at.y), width: grid(at.width), height: grid(at.height) })
  const label = (id: string): string => sizing.label(scoped.graph.nodes.find(node => node.id === id)!)
  const mediumOf = (edge: string): string => scoped.graph.edges.find(entry => entry.id === edge)!.medium
  // Each far end once, however many of its ports the drawing stops at.
  const stops = Object.fromEntries([...planned.stops].map(([id, stop]) => [id, {
    direction: stop.direction, label: stopLabel(words === 'bare' ? null : stop.direction, stop.others.map(other => label(other.node))), lines: stopLines(words, stop.direction, stop.others.map(other => label(other.node))),
    far: [...new Set(stop.others.map(other => other.node))], edges: stop.edges, medium: mediumOf(stop.edges[0]!),
  }]))
  const membersOf = (id: string): ReadonlyArray<string> => planned.items.get(id)?.item.members.map(member => member.id) ?? []
  return { stops, layout: {
    family: 'flow', unit: 'grid', width: Math.ceil(grid(result.width)), height: Math.ceil(grid(result.height)),
    nodes: result.nodes.map(node => ({
      id: node.id, ...box(node), ports: Object.fromEntries(Object.entries(node.ports).map(([id, port]) => [id, { x: grid(port.x), y: grid(port.y), face: port.face }])),
      ...(membersOf(node.id).length > 1 ? { members: membersOf(node.id) } : {}),
      ...(node.text === null ? {} : { text: { ...box(node.text), lines: node.text.lines, side: node.text.side } }),
    })),
    edges: result.edges.map(edge => ({ id: edge.id, points: edge.points.map(([x, y]) => [grid(x), grid(y)] as const), gaps: edge.gaps.map(([x, y]) => [grid(x), grid(y)] as const) })),
    crossings: result.crossings, hash: result.hash,
  } }
}
