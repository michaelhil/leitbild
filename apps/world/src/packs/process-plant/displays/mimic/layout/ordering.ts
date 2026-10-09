// Order within layers. Blocks are fixed: hubs, shared items, lanes in lane
// order, then lane-less stubs. Barycentre sweeps reorder items only inside
// their block, so lanes always line up and never swap.
import type { Layering } from './layering.ts'
import type { Model } from './model.ts'

export interface Ordering {
  /** Item indices per layer, in cross-axis order. */
  readonly layers: ReadonlyArray<ReadonlyArray<number>>
  readonly block: ReadonlyArray<number>
}

export const HUB_BLOCK = 0
export const SHARED_BLOCK = 1
export const laneBlock = (lane: number): number => 2 + lane
export const stubBlock = (laneCount: number): number => 2 + laneCount

const SWEEPS = 4

export const orderLayers = (model: Model, layering: Layering): Ordering => {
  const laneCount = model.lanes.length
  const block = layering.items.map(item => {
    if (item.node !== null) {
      const role = model.nodes[item.node]!.role
      if (role === 'hub') return HUB_BLOCK
      if (role === 'stub' && item.lane === null) return stubBlock(laneCount)
    }
    return item.lane === null ? SHARED_BLOCK : laneBlock(item.lane)
  })
  // Structural key: nodes by index, then dummies by edge and layer.
  const compareKey = (a: number, b: number): number => {
    const x = layering.items[a]!
    const y = layering.items[b]!
    if (x.node !== null && y.node !== null) return x.node - y.node
    if (x.node !== null) return -1
    if (y.node !== null) return 1
    return (x.edge! - y.edge!) || (x.layer - y.layer)
  }
  const neighbours = layering.items.map(() => [] as number[])
  for (const chain of layering.chains) {
    chain.steps.forEach((step, k) => {
      if (step !== 'next') return
      const a = chain.items[k]!
      const b = chain.items[k + 1]!
      neighbours[a]!.push(b)
      neighbours[b]!.push(a)
    })
  }
  const layers: number[][] = Array.from({ length: layering.layerCount }, () => [])
  layering.items.forEach((item, index) => layers[item.layer]!.push(index))
  const position = new Array<number>(layering.items.length).fill(0)
  const bary = new Array<number>(layering.items.length).fill(0)
  const sortLayer = (layer: number[]): void => {
    layer.sort((a, b) => (block[a]! - block[b]!) || (bary[a]! - bary[b]!) || compareKey(a, b))
    layer.forEach((item, index) => (position[item] = index))
  }
  for (const layer of layers) sortLayer(layer)
  const sweep = (at: number, from: number): void => {
    const layer = layers[at]!
    for (const item of layer) {
      const adjacent = neighbours[item]!.filter(other => layering.items[other]!.layer === from)
      bary[item] = adjacent.length === 0 ? position[item]! : adjacent.reduce((sum, other) => sum + position[other]!, 0) / adjacent.length
    }
    sortLayer(layer)
  }
  for (let round = 0; round < SWEEPS; round++) {
    for (let at = 1; at < layers.length; at++) sweep(at, at - 1)
    for (let at = layers.length - 2; at >= 0; at--) sweep(at, at + 1)
  }
  return { layers, block }
}
