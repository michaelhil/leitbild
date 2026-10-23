/**
 * A topology view's drawing (architecture A4, A5): the generic scope of its
 * request on the graph the caller reads, at most 60 nodes (a one-ended or
 * around request's reach shrinks first), laid out in grid units by family and
 * kept across vignettes by the graph's revision and scope.
 */
import type { ObjectId } from '../../../core/model/index.ts'
import type { Observable } from '../../../core/observation/model.ts'
import type { TopologyGraph } from '../../../core/observation/topology.ts'
import { drawingCache, drawingKey } from '../topology/cache.ts'
import { flowLayout, type DrawnStops } from '../topology/flow-sizing.ts'
import type { TopologyLayout } from '../topology/layout.ts'
import { networkLayout, type NetworkSizing } from '../topology/network.ts'
import { drawingStops, scopeTopology, TOPOLOGY_REACH, withOtherMediaStopped, type ScopedTopology, type TopologyRequest } from '../topology/scope.ts'
import { stopRefs, stopViews } from '../topology/stops.ts'
import type { SearchRun } from '../observation/search.ts'
import { declaredRefs } from './declared.ts'
import type { VignetteSection } from './model.ts'

export const TOPOLOGY_MAX_NODES = 60
/**
 * The room a flow drawing is laid out for, in grid units (lead, 21 Oct: the four-loop reference overview lays out at
 * 60 × 33 within it, so the window frame fits 1920 px beside its 360 px column; a narrower frame scrolls sideways).
 * R2 (W1.2, W1.3): the core's "Rods off bottom" and a line under each commanded item's state for the command it does
 * not follow take the four-loop overview to 64 × 37; with its attribution and frame, the 40 rows a vignette holds.
 * R3 (W6.5): its text measured in Noto Sans, it lays out at 62 columns, so the window frame holds it whole beside its
 * column at 1920 px, and a row more lets its loops' stops write "from" over what they name.
 */
export const FLOW_ROOM = { columns: 62, rows: 38 } as const

const labelOf = (graph: TopologyGraph, id: string): string => {
  const node = graph.nodes.find(entry => entry.id === id)
  return node?.shortLabel ?? node?.label ?? id
}
/** A network stop's label: the names of what lies beyond, at most 24 characters (a flow drawing's, topology/stops.ts). */
export const stopLabel = (names: ReadonlyArray<string>): string => names.join(', ').slice(0, 24)
/** Boxes that keep every drawn name whole at the renderer's 12 text (about 7 a character, 6 of padding, 24 a grid unit); a symbol (two units) stands over its name. */
const box = (text: string, height: number) => ({ width: Math.max(2, Math.ceil((text.length * 7 + 6) / 24)), height })
const symbols: ReadonlySet<string> = new Set(['switch', 'converter', 'source'])
const networkSizing = (graph: TopologyGraph): NetworkSizing => ({
  key: 'vignette-network-3',
  node: node => box(node.shortLabel ?? node.label, symbols.has(node.class) ? 3 : 2),
  stop: stop => box(stopLabel(stop.others.map(other => labelOf(graph, other.node))), 1),
  spacing: 1,
})

export type Scoped = { readonly ok: true; readonly scoped: ScopedTopology; readonly reach?: number } | { readonly ok: false; readonly reason: string }

/**
 * Whether flow leaving into these far ends only ends: followed through each node's port circuit, it reaches no drawn
 * node and stops only at terminal nodes, those with no outgoing edge that store nothing (a relief line to the
 * atmosphere). Such a stop says nothing an overview needs; flow into a store fills something one watches, and stays.
 */
const endsOutside = (graph: TopologyGraph, drawn: ReadonlySet<string>, others: ReadonlyArray<{ readonly node: string; readonly port: string }>): boolean => {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const leaving = new Map<string, Array<TopologyGraph['edges'][number]>>()
  for (const edge of graph.edges) leaving.set(edge.from.node, [...leaving.get(edge.from.node) ?? [], edge])
  const seen = new Set<string>()
  const queue = [...others]
  while (queue.length > 0) {
    const { node, port } = queue.pop()!
    if (drawn.has(node)) return false
    if (seen.has(`${node}|${port}`)) continue
    seen.add(`${node}|${port}`)
    const all = leaving.get(node) ?? []
    if (all.length === 0 && nodes.get(node)?.class === 'store') return false
    const circuit = nodes.get(node)?.ports.find(entry => entry.id === port)?.circuit
    const onward = circuit === undefined ? [] : all.filter(edge => nodes.get(node)?.ports.find(entry => entry.id === edge.from.port)?.circuit === circuit)
    if (onward.length === 0 && all.length > 0) return false
    queue.push(...onward.map(edge => edge.to))
  }
  return true
}

/**
 * An object's overview: the nodes and edges its graph declares as its principal equipment, stopped at every other
 * non-electric edge of those nodes, except outgoing flow that only ends (endsOutside); a graph that declares none,
 * whole where it is small enough; else none.
 */
export const overviewOf = (graph: TopologyGraph): ScopedTopology | null => {
  if (graph.overview === undefined) {
    return graph.nodes.length > TOPOLOGY_MAX_NODES ? null
      : { graph, nodes: graph.nodes.map(node => node.id), edges: graph.edges.map(edge => edge.id), stubs: [], media: [...new Set(graph.edges.map(edge => edge.medium))].sort(), roots: [], anchors: [] }
  }
  const edges = new Set(graph.overview.edges)
  const drawn = new Set(graph.overview.nodes)
  const media = new Set(graph.media.filter(medium => medium.kind !== 'electric-ac' && medium.kind !== 'electric-dc').map(medium => medium.id))
  const stubs = drawingStops(graph, graph.overview.nodes, edges, media).filter(stub => stub.direction === 'in' || !endsOutside(graph, drawn, stub.others))
  return { graph, nodes: [...graph.overview.nodes], edges: [...graph.overview.edges], stubs, media: [...new Set(graph.edges.filter(edge => edges.has(edge.id)).map(edge => edge.medium))].sort(), roots: [], anchors: [] }
}

type Request = { readonly overview?: true | undefined } & { readonly [K in keyof TopologyRequest]?: TopologyRequest[K] | undefined }

/** The request's scope within the node cap; a narrowed reach comes back with it. */
export const scopeWithin = (graph: TopologyGraph, asked: Request): Scoped => {
  if (asked.overview === true) {
    const overview = overviewOf(graph)
    return overview === null ? { ok: false, reason: 'no overview declared' } : { ok: true, scoped: overview }
  }
  const request = Object.fromEntries(Object.entries(asked).filter(([key, value]) => value !== undefined && key !== 'overview')) as TopologyRequest
  const scoped = scopeByReach(graph, request)
  // Around items with media named, every other medium they carry stops the drawing at them, so it shows where they join.
  if (!scoped.ok || request.around === undefined || request.media === undefined) return scoped
  const others = [...new Set(graph.nodes.filter(node => request.around!.includes(node.id)).flatMap(node => node.ports.flatMap(port => port.media)))]
  return { ...scoped, scoped: withOtherMediaStopped(scoped.scoped, request.around, others) }
}

const scopeByReach = (graph: TopologyGraph, request: TopologyRequest): Scoped => {
  const oneEnded = !(request.from !== undefined && request.to !== undefined)
  for (let reach = request.reach ?? TOPOLOGY_REACH; reach >= 1; reach -= 1) {
    // A vignette draws a node between drawn ones rather than name it at a stop on each side.
    const result = scopeTopology(graph, { ...request, between: true, ...(oneEnded ? { reach } : {}) })
    if (!result.ok) return { ok: false, reason: result.refusal.code }
    if (result.scoped.nodes.length <= TOPOLOGY_MAX_NODES) return { ok: true, scoped: result.scoped, ...(oneEnded && reach !== (request.reach ?? TOPOLOGY_REACH) ? { reach } : {}) }
    if (!oneEnded) break
  }
  return { ok: false, reason: `more than ${TOPOLOGY_MAX_NODES} nodes` }
}

export interface Drawing { readonly layout: TopologyLayout; readonly stops: DrawnStops }
const drawings = drawingCache<Promise<Drawing | null>>(64)
/** A scope's drawing, kept by its graph's revision; a flow drawing sizes its text by what its bindings declare (their words and units), static for a revision. */
export const drawingOf = (run: SearchRun, scoped: ScopedTopology): Promise<Drawing | null> => drawings.get(drawingKey(scoped, scoped.graph.family), async () => {
  if (scoped.graph.family === 'flow') {
    const declared = await declaredRefs(run, bindingRefs(scoped))
    return flowLayout(scoped, FLOW_ROOM, ref => declared.get(ref)?.observable)
  }
  const layout = await networkLayout(scoped, networkSizing(scoped.graph))
  const mediumOf = (edge: string): string => scoped.graph.edges.find(entry => entry.id === edge)!.medium
  return { layout, stops: Object.fromEntries(scoped.stubs.map((stop, at) => {
    const label = stopLabel(stop.others.map(other => labelOf(scoped.graph, other.node)))
    return [`s${at}`, { direction: stop.direction, label, lines: [label], far: [...new Set(stop.others.map(other => other.node))], edges: stop.edges, medium: mediumOf(stop.edges[0]!) }]
  })) }
})

export const topologyOf = async (run: SearchRun, objectId: ObjectId): Promise<TopologyGraph | null> => {
  if (run.denied.has(objectId)) return null
  const graph = await run.port.topology(objectId)
  return 'refused' in graph ? null : graph
}

/** What the renderer draws: the layout, every drawn node (stops as `s<n>`, with their far ends) and edge with its medium's kind, and bindings the caller reads, with their declared units. */
export const topologySection = (objectId: string, packId: string, scoped: ScopedTopology, drawing: Drawing, rows: number, declaredOf: (ref: string) => Pick<Observable, 'quantity' | 'unit' | 'states' | 'decades'> & Partial<Pick<Observable, 'series'>> | undefined): VignetteSection => {
  const { graph } = scoped
  const [nodes, edges] = [new Set(scoped.nodes), new Set(scoped.edges)]
  const kindOf = (medium: string) => graph.media.find(entry => entry.id === medium)!.kind
  // Lines outside the principal equipment the graph declares are auxiliary (U-20); a graph that declares none has none.
  const principal = new Set(graph.overview?.edges ?? [])
  const auxiliary = (lines: ReadonlyArray<string>): boolean => graph.overview !== undefined && !lines.some(line => principal.has(line))
  const bound = (bindings: TopologyGraph['nodes'][number]['bindings']) => bindings.flatMap(binding => {
    const declared = declaredOf(binding.ref)
    // A traced reading carries its record's series, which the samples serve (W6.6).
    const series = binding.trace === true ? declared?.series ?? null : null
    return declared === undefined ? [] : [{ ...binding, quantity: declared.quantity, unit: declared.unit, ...(declared.states === undefined ? {} : { states: declared.states }), ...(declared.decades === true ? { decades: true as const } : {}), ...(series === null ? {} : { series }) }]
  })
  return {
    kind: 'topology', rows, objectId, packId, family: graph.family, layout: drawing.layout,
    nodes: [
      ...graph.nodes.filter(node => nodes.has(node.id)).map(node => ({
        id: node.id, class: node.class, label: node.label, bindings: bound(node.bindings),
        ...(node.shortLabel === undefined ? {} : { shortLabel: node.shortLabel }), ...(node.element === undefined ? {} : { element: node.element }),
      })),
      ...Object.entries(drawing.stops).map(([id, stop]) => stopViews(graph, id, stop, bound).node),
    ],
    edges: [
      ...graph.edges.filter(edge => edges.has(edge.id)).map(edge => ({ id: edge.id, mediumKind: kindOf(edge.medium), bindings: bound(edge.bindings), ...(auxiliary([edge.id]) ? { auxiliary: true as const } : {}) })),
      ...Object.entries(drawing.stops).map(([id, stop]) => ({ ...stopViews(graph, id, stop, bound).edge, ...(auxiliary(stop.edges) ? { auxiliary: true as const } : {}) })),
    ],
    ...(graph.attribution === undefined ? {} : { attribution: graph.attribution }),
  }
}

/** The readings a drawing traces with its drawn items (W6.6): their records are served with its samples' history. */
export const tracedRefs = (scoped: ScopedTopology): ReadonlyArray<string> => {
  const nodes = new Set(scoped.nodes)
  return [...new Set(scoped.graph.nodes.filter(node => nodes.has(node.id)).flatMap(node => node.bindings.filter(binding => binding.trace === true).map(binding => binding.ref)))]
}

/** The values a drawing binds: every drawn node's and edge's binding refs, the flags a reading in turn stands in `while`, and what its stops read. */
export const bindingRefs = (scoped: ScopedTopology): ReadonlyArray<string> => {
  const [nodes, edges] = [new Set(scoped.nodes), new Set(scoped.edges)]
  return [...new Set([...[...scoped.graph.nodes.filter(node => nodes.has(node.id)), ...scoped.graph.edges.filter(edge => edges.has(edge.id))]
    .flatMap(item => item.bindings.flatMap(binding => [binding.ref, ...(binding.while === undefined ? [] : [binding.while])])), ...stopRefs(scoped.graph, scoped.stubs)])]
}
