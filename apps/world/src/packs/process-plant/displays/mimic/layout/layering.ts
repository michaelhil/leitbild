// Layers along the flow: longest path from the sources, sources pulled up next
// to their first successor, bars given layers of their own, and long edges cut
// into chains of dummy items, one per layer they pass.
//
// A reversed edge (a return run) attaches to its physical ends by their flow
// faces: its source leaves downstream and its target is entered from
// upstream, so the run turns back beside the lane. A hub's side face is
// reachable from any channel and needs no turn; neither does a mirrored
// symbol of a folded return leg (its faces swap), nor a bar a fold reaches.
//
// A hub's pipes reach their items through the channel just before each
// (`near`), or all through the first channel (`outer`), from where they run
// in their items' lanes: across the bars between, instead of along the
// lanes' own pipes.
import type { Model } from './model.ts'
import type { Structure } from './structure.ts'

export interface Item {
  readonly node: number | null
  /** The edge a dummy belongs to. */
  readonly edge: number | null
  readonly layer: number
  readonly lane: number | null
}

/** How consecutive chain items connect: to the next layer, or by a U-turn above or below their shared layer. */
export type Step = 'next' | 'turnAbove' | 'turnBelow'

export interface Chain {
  readonly edge: number
  /**
   * Items from the lower layer to the higher one (reversed edges run against
   * the flow here). A hub sits beside the layers: its neighbour in a chain may
   * share its layer, when the edge meets the hub in the channel past it.
   */
  readonly items: ReadonlyArray<number>
  readonly steps: ReadonlyArray<Step>
  readonly reversed: boolean
}

export interface LayeringOptions {
  /** Per node: drawn mirrored (a folded return leg). */
  readonly flipped: ReadonlyArray<boolean>
  /** Per edge: part of a fold. */
  readonly folded: ReadonlyArray<boolean>
  readonly hubReach: 'near' | 'outer'
}

export const plainLayering = (model: Model): LayeringOptions => ({
  flipped: model.nodes.map(() => false),
  folded: model.edges.map(() => false),
  hubReach: 'near',
})

export interface Layering {
  /** Item i < nodes.length is node i; dummies follow. */
  readonly items: ReadonlyArray<Item>
  readonly layerCount: number
  readonly chains: ReadonlyArray<Chain>
}

/** Layer per node: longest path, sources beside what they feed, stubs beside their node, bars on layers of their own. */
export const layerNodes = (model: Model, reversed: ReadonlyArray<boolean>, stubsIntoHubsFirst = false): number[] => {
  const count = model.nodes.length
  const dagFrom = (e: number): number => (reversed[e] ? model.edges[e]!.to : model.edges[e]!.from)
  const dagTo = (e: number): number => (reversed[e] ? model.edges[e]!.from : model.edges[e]!.to)
  const successors = model.nodes.map(() => [] as number[])
  const predecessors = model.nodes.map(() => [] as number[])
  for (const edge of model.edges) {
    successors[dagFrom(edge.index)]!.push(dagTo(edge.index))
    predecessors[dagTo(edge.index)]!.push(dagFrom(edge.index))
  }

  // Longest path, in a topological order that takes the lowest index first.
  const layer = new Array<number>(count).fill(0)
  const waiting = predecessors.map(list => list.length)
  const ready = model.nodes.filter(node => waiting[node.index] === 0).map(node => node.index)
  const topological: number[] = []
  while (ready.length > 0) {
    ready.sort((a, b) => a - b)
    const node = ready.shift()!
    topological.push(node)
    for (const next of successors[node]!) {
      layer[next] = Math.max(layer[next]!, layer[node]! + 1)
      if (--waiting[next]! === 0) ready.push(next)
    }
  }
  if (topological.length !== count) throw new Error('cycle breaking left a cycle')
  // A stub is an off-sheet end on one edge: it goes wherever its neighbour is,
  // so it never holds a source back from the equipment it feeds.
  const isStub = (node: number): boolean => model.nodes[node]!.role === 'stub'
  for (const node of topological) {
    if (predecessors[node]!.length === 0 && successors[node]!.length > 0) {
      const firm = successors[node]!.filter(next => !isStub(next))
      layer[node] = Math.min(...(firm.length > 0 ? firm : successors[node]!).map(next => layer[next]!)) - 1
    }
  }
  for (const node of topological) {
    if (isStub(node) && successors[node]!.length === 0 && predecessors[node]!.length === 1) layer[node] = layer[predecessors[node]![0]!]! + 1
  }

  // A bar spans what it connects; it never shares a layer with a symbol.
  for (let at = 0; at <= Math.max(0, ...layer); at++) {
    const here = model.nodes.filter(node => layer[node.index] === at)
    const bars = here.filter(node => node.role === 'bar')
    if (bars.length === 0 || bars.length === here.filter(node => node.role !== 'hub').length) continue
    for (const node of model.nodes) {
      if (layer[node.index]! >= at && !(layer[node.index] === at && node.role === 'bar')) layer[node.index]!++
    }
  }
  // In outer hub reach, a stub that feeds a hub comes in through the first channel, with the hub's other pipes.
  if (stubsIntoHubsFirst) {
    const feeding = topological.filter(node => isStub(node) && predecessors[node]!.length === 0 && successors[node]!.some(next => model.nodes[next]!.role === 'hub'))
    const firm = model.nodes.filter(node => node.role !== 'stub' && node.role !== 'hub').map(node => layer[node.index]!)
    if (feeding.length > 0 && firm.length > 0) {
      const first = Math.min(...firm)
      for (const node of feeding) layer[node] = first - 1
      const lowest = Math.min(...layer)
      if (lowest < 0) for (let node = 0; node < count; node++) layer[node]! -= lowest
    }
  }
  return layer
}

export const assignLayers = (model: Model, structure: Structure, reversed: ReadonlyArray<boolean>, options: LayeringOptions): Layering => {
  const layer = layerNodes(model, reversed, options.hubReach === 'outer')
  const firstLayer = options.hubReach === 'outer' ? Math.min(...model.nodes.filter(node => node.role !== 'stub' && node.role !== 'hub').map(node => layer[node.index]!), Infinity) : Infinity
  const dagFrom = (e: number): number => (reversed[e] ? model.edges[e]!.to : model.edges[e]!.from)
  const dagTo = (e: number): number => (reversed[e] ? model.edges[e]!.from : model.edges[e]!.to)
  const role = (node: number) => model.nodes[node]!.role
  // Which flow face of a node an edge's port is on, in layering terms: +f downstream, -f upstream.
  const portFace = (node: number, e: number): '-f' | '+f' => {
    const source = model.edges[e]!.from === node
    return source !== options.flipped[node] ? '+f' : '-f'
  }
  const turnless = (node: number, e: number): boolean => role(node) === 'hub' || (role(node) === 'bar' && options.folded[e]!)

  const items: Item[] = model.nodes.map(node => ({ node: node.index, edge: null, layer: layer[node.index]!, lane: node.lane }))
  // Outer reach: a hub's pipes leave it, and pipes from upstream of everything reach it, through the first channel.
  // A hub port that something else reaches from its layer's side (a makeup line) keeps near reach, so its pipes meet in one place.
  const hubPort = (edge: Model['edges'][number], node: number): string => `${node}:${edge.from === node ? edge.fromPort : edge.toPort}`
  const reachesFirst = (edge: Model['edges'][number]): boolean => Number.isFinite(firstLayer) && layer[dagFrom(edge.index)]! < firstLayer
  const nearPorts = new Set(model.edges.filter(edge => role(dagTo(edge.index)) === 'hub' && !reachesFirst(edge)).map(edge => hubPort(edge, dagTo(edge.index))))
  const chains: Chain[] = model.edges.map(edge => {
    const start = dagFrom(edge.index)
    const end = dagTo(edge.index)
    const isReversed = reversed[edge.index]!
    const turnBelow = !turnless(start, edge.index) && portFace(start, edge.index) === '-f'
    const turnAbove = !turnless(end, edge.index) && portFace(end, edge.index) === '+f'
    const outer = role(start) === 'hub' && Number.isFinite(firstLayer) && firstLayer < layer[start]! + 1 && !nearPorts.has(hubPort(edge, start))
    const outerEnd = role(end) === 'hub' && reachesFirst(edge)
    const first = turnBelow ? layer[start]! : outer ? firstLayer : layer[start]! + 1
    const last = turnAbove ? layer[end]! : outerEnd ? firstLayer - 1 : layer[end]! - 1
    const chain = [start]
    for (let at = first; at <= last; at++) {
      chain.push(items.length)
      items.push({ node: null, edge: edge.index, layer: at, lane: structure.edgeLane[edge.index]! })
    }
    chain.push(end)
    const steps: Step[] = []
    for (let k = 0; k + 1 < chain.length; k++) {
      const same = items[chain[k]!]!.layer === items[chain[k + 1]!]!.layer
      steps.push(!same ? 'next' : k === 0 && turnBelow ? 'turnBelow' : 'turnAbove')
    }
    return { edge: edge.index, items: chain, steps, reversed: isReversed }
  })
  // A hub port is one place on the hub's side face, on one track. Edges reach
  // a hub in the channel before its layer (from upstream) or after it (to
  // downstream); where one port has both, the side with fewer edges (on a
  // tie, the upstream one) runs on through the hub's layer to the other
  // side's channel and meets the rest there, in a tee.
  model.nodes.filter(node => node.role === 'hub').forEach(hub => hub.ports.forEach((_, port) => {
    const at = (chain: Chain): 'start' | 'end' | null => {
      const edge = model.edges[chain.edge]!
      const own = (node: number, p: number): boolean => node === hub.index && p === port
      const touches = own(edge.from, edge.fromPort) || own(edge.to, edge.toPort)
      if (!touches) return null
      return chain.items[0] === hub.index ? 'start' : 'end'
    }
    const starting = chains.filter(chain => at(chain) === 'start')
    const ending = chains.filter(chain => at(chain) === 'end')
    if (starting.length === 0 || ending.length === 0) return
    // Already in one channel (outer reach, where a feeding stub comes in through the first channel too).
    const channelOf = (chain: Chain): number => at(chain) === 'start' ? items[chain.items[1]!]!.layer : items[chain.items.at(-2)!]!.layer + 1
    if (new Set([...starting, ...ending].map(channelOf)).size === 1) return
    const moved = starting.length >= ending.length ? ending : starting
    for (const chain of moved) {
      const dummy = items.length
      items.push({ node: null, edge: chain.edge, layer: layer[hub.index]!, lane: structure.edgeLane[chain.edge]! })
      const index = chains.indexOf(chain)
      chains[index] = at(chain) === 'end'
        ? { ...chain, items: [...chain.items.slice(0, -1), dummy, hub.index], steps: [...chain.steps, 'next'] }
        : { ...chain, items: [hub.index, dummy, ...chain.items.slice(1)], steps: ['next', ...chain.steps] }
    }
  }))
  const layerCount = Math.max(0, ...items.map(item => item.layer)) + 1
  return { items, layerCount, chains }
}
