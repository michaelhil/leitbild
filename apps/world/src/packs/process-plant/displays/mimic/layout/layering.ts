// Layers along the flow: longest path from the sources, sources pulled up next
// to their first successor, bars given layers of their own, and long edges cut
// into chains of dummy items, one per layer they pass.
//
// A reversed edge (a return run) attaches to its physical ends by their flow
// faces: its source leaves downstream and its target is entered from
// upstream, so the run turns back beside the lane. A hub's side face is
// reachable from any channel and needs no turn.
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
  /** Items from the lower layer to the higher one (reversed edges run against the flow here). */
  readonly items: ReadonlyArray<number>
  readonly steps: ReadonlyArray<Step>
  readonly reversed: boolean
}

export interface Layering {
  /** Item i < nodes.length is node i; dummies follow. */
  readonly items: ReadonlyArray<Item>
  readonly layerCount: number
  readonly chains: ReadonlyArray<Chain>
}

export const assignLayers = (model: Model, structure: Structure, reversed: ReadonlyArray<boolean>): Layering => {
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
  for (const node of topological) {
    if (predecessors[node]!.length === 0 && successors[node]!.length > 0) {
      layer[node] = Math.min(...successors[node]!.map(next => layer[next]!)) - 1
    }
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

  const items: Item[] = model.nodes.map(node => ({ node: node.index, edge: null, layer: layer[node.index]!, lane: node.lane }))
  const chains: Chain[] = model.edges.map(edge => {
    const start = dagFrom(edge.index)
    const end = dagTo(edge.index)
    const isReversed = reversed[edge.index]!
    const turnBelow = isReversed && model.nodes[start]!.role !== 'hub'
    const turnAbove = isReversed && model.nodes[end]!.role !== 'hub'
    const first = turnBelow ? layer[start]! : layer[start]! + 1
    const last = turnAbove ? layer[end]! : layer[end]! - 1
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
  const layerCount = Math.max(0, ...items.map(item => item.layer)) + 1
  return { items, layerCount, chains }
}
