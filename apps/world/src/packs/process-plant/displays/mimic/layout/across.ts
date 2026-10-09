// Cross-axis placement. Bands run hubs | shared | lane 0 … lane n | stubs.
// Every lane has the same pitch, and a lane's drawing depends only on its own
// content and the bands before lane 0: adding lanes after it moves nothing in
// it. In a lane, the first symbol of every layer sits on the lane's main axis
// (lanes run straight); further symbols pack after it, and a long edge's
// dummies share one column. Layers without lane content (pumps under a
// header) place items at the median of their neighbours.
//
// Spacing: every item has a full reach (including pipes it routes beside
// itself) and a solid reach (symbol, text, frame). Text keeps the text
// clearance from other symbols' frames, so solids keep it between them; a
// pipe only has to stay off everything, so full reaches may touch. The pitch
// is the widest a lane reaches in any one layer, against the next lane in
// that same layer.
import type { DiagramProfile } from './diagram.ts'
import { ceilTo, roundTo } from './geometry.ts'
import type { Layering } from './layering.ts'
import type { Model } from './model.ts'
import { HUB_BLOCK, SHARED_BLOCK, laneBlock, stubBlock, type Ordering } from './ordering.ts'

export interface AcrossInput {
  readonly model: Model
  readonly profile: DiagramProfile
  readonly layering: Layering
  readonly ordering: Ordering
  /** Full reach of each item left and right of its anchor (bars: unused). */
  readonly left: ReadonlyArray<number>
  readonly right: ReadonlyArray<number>
  /** Solid reach (symbol, text, frame); −Infinity for a pipe. */
  readonly leftSolid: ReadonlyArray<number>
  readonly rightSolid: ReadonlyArray<number>
}

/** Where a band of items ends: everything, and the solids. */
interface Edge {
  readonly full: number
  readonly solid: number
}

export interface AcrossPlacement {
  /** Anchor per item; bars are placed later, by their attachments. */
  readonly c: ReadonlyArray<number>
  /** Lane i's band starts at `laneStart + i × pitch`. */
  readonly laneStart: number
  readonly pitch: number
}

const MEDIAN_SWEEPS = 4

export const placeAcross = (input: AcrossInput): AcrossPlacement => {
  const { model, profile, layering, ordering, left, right, leftSolid, rightSolid } = input
  const grid = profile.grid
  const laneCount = model.lanes.length
  const items = layering.items
  const c = new Array<number>(items.length).fill(Number.NaN)
  const isDummy = (item: number): boolean => items[item]!.node === null
  const isBar = (item: number): boolean => items[item]!.node !== null && model.nodes[items[item]!.node!]!.role === 'bar'
  const clear = profile.textClearance
  const need = (rightFull: number, rightHard: number, leftFull: number, leftHard: number): number => Math.max(rightFull + leftFull, rightHard + leftHard + clear)
  const separation = (a: number, b: number): number => ceilTo(need(right[a]!, rightSolid[a]!, left[b]!, leftSolid[b]!), grid)
  const edgeOf = (run: ReadonlyArray<number>, start: Edge): Edge => ({
    full: Math.max(start.full, ...run.map(item => c[item]! + right[item]!)),
    solid: Math.max(start.solid, ...run.map(item => c[item]! + rightSolid[item]!)),
  })
  /** Packs items after `start`; returns where they end. */
  const pack = (run: ReadonlyArray<number>, start: Edge): Edge => {
    let previous = -1
    for (const item of run) {
      c[item] = previous < 0 ? ceilTo(need(start.full, start.solid, left[item]!, leftSolid[item]!), grid) : c[previous]! + separation(previous, item)
      previous = item
    }
    return edgeOf(run, start)
  }
  const origin: Edge = { full: 0, solid: -Infinity }

  const inBlock = (layer: ReadonlyArray<number>, block: number): number[] => layer.filter(item => ordering.block[item] === block && !isBar(item))
  const hasLaneContent = (layer: ReadonlyArray<number>): boolean => layer.some(item => ordering.block[item]! >= laneBlock(0) && ordering.block[item]! < stubBlock(laneCount))

  const hubs = ordering.layers.flatMap(layer => inBlock(layer, HUB_BLOCK)).sort((a, b) => items[a]!.node! - items[b]!.node!)
  const hubBandEnd = pack(hubs, origin)
  const laneLayers = ordering.layers.filter(hasLaneContent)
  const sharedEnds = laneLayers.map(layer => pack(inBlock(layer, SHARED_BLOCK), hubBandEnd))
  const sharedEnd: Edge = { full: Math.max(hubBandEnd.full, ...sharedEnds.map(edge => edge.full)), solid: Math.max(hubBandEnd.solid, ...sharedEnds.map(edge => edge.solid)) }

  // Each lane relative to its own main axis (0).
  const relative = new Array<number>(items.length).fill(Number.NaN)
  const lanes = model.lanes.map((_, lane) => {
    const cells = ordering.layers.map(layer => inBlock(layer, laneBlock(lane)))
    const placed = cells.map(() => [] as number[])
    const axisTaken = cells.map(() => false)
    const after = (layer: number, item: number): number => {
      const last = placed[layer]!.at(-1)
      return last === undefined ? -Infinity : relative[last]! + separation(last, item)
    }
    cells.forEach((cell, layer) => {
      for (const item of cell.filter(member => !isDummy(member))) {
        relative[item] = placed[layer]!.length === 0 ? 0 : after(layer, item)
        if (relative[item] === 0) axisTaken[layer] = true
        placed[layer]!.push(item)
      }
    })
    const strands = new Map<number, number[]>()
    cells.forEach(cell => cell.filter(isDummy).forEach(item => {
      const edge = items[item]!.edge!
      strands.set(edge, [...(strands.get(edge) ?? []), item])
    }))
    for (const edge of [...strands.keys()].sort((a, b) => a - b)) {
      const strand = strands.get(edge)!
      const onAxis = strand.every(item => !axisTaken[items[item]!.layer])
      const wanted = Math.max(...strand.map(item => after(items[item]!.layer, item)))
      const at = onAxis ? 0 : Number.isFinite(wanted) ? wanted : 0
      for (const item of strand) {
        relative[item] = at
        if (at === 0) axisTaken[items[item]!.layer] = true
        placed[items[item]!.layer]!.push(item)
      }
    }
    // Per layer: how far the lane reaches, fully and with solids.
    return placed.map(list => (list.length === 0 ? null : {
      low: Math.min(...list.map(item => relative[item]! - left[item]!)),
      high: Math.max(...list.map(item => relative[item]! + right[item]!)),
      lowSolid: Math.min(...list.map(item => relative[item]! - leftSolid[item]!)),
      highSolid: Math.max(...list.map(item => relative[item]! + rightSolid[item]!)),
    }))
  })
  const reach = (lane: number, which: 'low' | 'high' | 'lowSolid' | 'highSolid'): number => {
    const values = lanes[lane]!.filter(entry => entry !== null).map(entry => entry![which])
    return which === 'low' || which === 'lowSolid' ? Math.min(0, ...values) : Math.max(0, ...values)
  }
  const pairs: number[] = []
  for (let lane = 0; lane < laneCount; lane++) {
    const next = lanes[lane + 1] === undefined ? lane : lane + 1
    lanes[lane]!.forEach((here, layer) => {
      const there = lanes[next]![layer]
      if (here === null || there === null || there === undefined) return
      pairs.push(need(here.high, here.highSolid, -there.low, -there.lowSolid))
    })
  }
  const pitch = ceilTo(Math.max(grid, ...pairs), grid)
  const firstAxis = laneCount === 0 ? 0 : ceilTo(need(sharedEnd.full, sharedEnd.solid, -reach(0, 'low'), -reach(0, 'lowSolid')), grid)
  items.forEach((item, index) => {
    if (item.lane !== null && ordering.block[index] === laneBlock(item.lane)) c[index] = firstAxis + item.lane * pitch + relative[index]!
  })
  const bandLow = Math.min(0, ...model.lanes.map((_, lane) => reach(lane, 'low')))
  const lastAxis = firstAxis + (laneCount - 1) * pitch
  const lanesEnd: Edge = laneCount === 0 ? sharedEnd : { full: lastAxis + reach(laneCount - 1, 'high'), solid: lastAxis + reach(laneCount - 1, 'highSolid') }
  for (const layer of laneLayers) pack(inBlock(layer, stubBlock(laneCount)), lanesEnd)

  // Layers without lane content: medians of neighbours, order kept.
  const free = ordering.layers.map(layer => (hasLaneContent(layer) ? [] : layer.filter(item => ordering.block[item] !== HUB_BLOCK && !isBar(item))))
    .filter(run => run.length > 0)
  const lowerBound = hubs.length > 0 ? hubBandEnd : null
  for (const run of free) pack(run, lowerBound ?? origin)
  const neighbours = items.map(() => [] as number[])
  for (const chain of layering.chains) {
    chain.steps.forEach((step, k) => {
      if (step !== 'next') return
      neighbours[chain.items[k]!]!.push(chain.items[k + 1]!)
      neighbours[chain.items[k + 1]!]!.push(chain.items[k]!)
    })
  }
  const neighbourPositions = (item: number): number[] => {
    const own = items[item]!.layer
    const positions: number[] = []
    for (const other of neighbours[item]!) {
      if (ordering.block[other] === HUB_BLOCK) continue
      if (!isBar(other)) {
        if (Number.isFinite(c[other]!)) positions.push(c[other]!)
        continue
      }
      // Through a bar: align with what the bar feeds on its far side.
      for (const far of neighbours[other]!) {
        if (far !== item && items[far]!.layer !== own && !isBar(far) && ordering.block[far] !== HUB_BLOCK && Number.isFinite(c[far]!)) positions.push(c[far]!)
      }
    }
    return positions.sort((a, b) => a - b)
  }
  const forbidden = (item: number): Set<number> => {
    // A run through a stack of bars must not share a column with another bar's branch on the far side.
    const own = items[item]!.layer
    const result = new Set<number>()
    for (const direction of [1, -1]) {
      const barLayer = ordering.layers[own + direction]
      if (barLayer === undefined) continue
      const bars = barLayer.filter(isBar)
      if (bars.length < 2) continue
      for (const bar of bars) {
        if (neighbours[item]!.includes(bar)) continue
        for (const far of neighbours[bar]!) {
          if (items[far]!.layer === own + 2 * direction && Number.isFinite(c[far]!)) result.add(c[far]!)
        }
      }
    }
    return result
  }
  const placeMedian = (run: ReadonlyArray<number>): void => {
    const want = run.map(item => {
      const positions = neighbourPositions(item)
      if (positions.length === 0) return c[item]!
      return (positions[Math.floor((positions.length - 1) / 2)]! + positions[Math.ceil((positions.length - 1) / 2)]!) / 2
    })
    const offsets = run.map(() => 0)
    for (let i = 1; i < run.length; i++) offsets[i] = offsets[i - 1]! + separation(run[i - 1]!, run[i]!)
    // Isotonic regression (pool adjacent violators) of want − offset keeps order and separation.
    const pools: Array<{ sum: number; count: number }> = []
    run.forEach((_, i) => {
      pools.push({ sum: want[i]! - offsets[i]!, count: 1 })
      while (pools.length > 1 && pools.at(-2)!.sum / pools.at(-2)!.count > pools.at(-1)!.sum / pools.at(-1)!.count) {
        const top = pools.pop()!
        pools.at(-1)!.sum += top.sum
        pools.at(-1)!.count += top.count
      }
    })
    const floor = lowerBound === null ? -Infinity : ceilTo(need(lowerBound.full, lowerBound.solid, left[run[0]!]!, leftSolid[run[0]!]!), grid)
    let i = 0
    for (const pool of pools) {
      const value = Math.max(roundTo(pool.sum / pool.count, grid), floor)
      for (let k = 0; k < pool.count; k++, i++) c[run[i]!] = value + offsets[i]!
    }
    for (let k = 0; k < run.length; k++) {
      if (k > 0) c[run[k]!] = Math.max(c[run[k]!]!, c[run[k - 1]!]! + separation(run[k - 1]!, run[k]!))
      const blocked = forbidden(run[k]!)
      while (blocked.has(c[run[k]!]!)) c[run[k]!]! += grid
    }
  }
  for (let round = 0; round < MEDIAN_SWEEPS; round++) {
    for (const run of free) placeMedian(run)
    for (const run of [...free].reverse()) placeMedian(run)
  }
  return { c, laneStart: firstAxis + bandLow, pitch }
}
