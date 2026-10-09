// One layout attempt: an orientation and a text detail level, from the
// orientation-free structure (cycles, layers, order) to screen geometry.
import { placeAcross } from './across.ts'
import { placeAlong, type LayerExtent } from './along.ts'
import { attach } from './attach.ts'
import { planChannels, trackKey } from './channels.ts'
import type { DiagramProfile, DiagramZone, Face, PlacedNode } from './diagram.ts'
import { axisFace, ceilTo, floorTo, screenFace, toScreen, toScreenRect, translateRect, type AxisBox, type AxisFace, type Orientation, type Point, type Rect } from './geometry.ts'
import type { Layering } from './layering.ts'
import type { Model } from './model.ts'
import type { Ordering } from './ordering.ts'
import { chooseTextSide, dress, footprint, keptLines, planSideEntry, shiftBox, type Dressed, type SideEntry, type TextSide } from './shapes.ts'
import type { Structure } from './structure.ts'

export type Detail = DiagramProfile['fit'][number]['detail']
/**
 * Where symbols' text stacks go: right of each symbol where its pipes allow;
 * the same with stub labels below their ends; below the symbols of lanes; or
 * below every symbol. Below is narrower and taller, and right is the richer
 * drawing.
 */
export type TextPolicy = DiagramProfile['fit'][number]['text']

/** Everything that does not depend on orientation or detail. */
export interface Prepared {
  readonly model: Model
  readonly structure: Structure
  readonly layering: Layering
  readonly ordering: Ordering
  /** Per node: drawn mirrored, its in-ports downstream and out-ports upstream (a folded return leg). */
  readonly flipped: ReadonlyArray<boolean>
  /**
   * A refined arrangement: long edges run before the symbols they are ordered
   * before (across.ts), and a channel's tracks pack at half a grid except
   * between nets that cross there (channels.ts).
   */
  readonly refine: boolean
  readonly pipeFaces: ReadonlyArray<ReadonlySet<AxisFace>>
}

export interface AttemptGeometry {
  readonly orientation: Orientation
  readonly detail: Detail
  readonly policy: TextPolicy
  readonly width: number
  readonly height: number
  readonly nodes: ReadonlyArray<PlacedNode>
  readonly paths: ReadonlyArray<ReadonlyArray<Point>>
  readonly zones: ReadonlyArray<DiagramZone>
}

export const prepare = (model: Model, structure: Structure, layering: Layering, ordering: Ordering, flipped: ReadonlyArray<boolean>, refine: boolean): Prepared => {
  const pipeFaces = model.nodes.map(node => {
    const faces = new Set<AxisFace>()
    if (node.role === 'hub') {
      if (node.ports.some(port => port.use !== 'unused')) faces.add(ordering.hubSide === 'low' ? '+c' : '-c')
      return faces
    }
    if (node.ports.some(port => port.use === 'target')) faces.add(flipped[node.index] ? '+f' : '-f')
    if (node.ports.some(port => port.use === 'source')) faces.add(flipped[node.index] ? '-f' : '+f')
    return faces
  })
  return { model, structure, layering, ordering, flipped, refine, pipeFaces }
}

export const runAttempt = (prepared: Prepared, profile: DiagramProfile, orientation: Orientation, detail: Detail, policy: TextPolicy): AttemptGeometry => {
  const { model, structure, layering, ordering } = prepared
  const grid = profile.grid
  const outline = profile.pipe.outline
  const items = layering.items
  const nodeCount = model.nodes.length
  const kept = model.nodes.map(node => keptLines(node, detail))
  // Screen footprints in the flow axes; flow faces run across. A face of n
  // grid steps has n − 1 interior grid points, so a busy face grows.
  const alongCells = (node: Model['nodes'][number]): number => (orientation === 'leftToRight' ? node.width : node.height)
  const footprintOf = (node: Model['nodes'][number], sideEntry: boolean): AxisBox => {
    const own = orientation === 'leftToRight' ? node.height : node.width
    const ports = (['source', 'target'] as const).filter(use => !(sideEntry && use === 'target')).map(use => node.ports.filter(port => port.use === use).length)
    const across = node.role === 'hub' ? own : Math.max(own, Math.ceil(((Math.max(0, ...ports) + 1) * grid) / profile.cell))
    return footprint(alongCells(node) * profile.cell, across * profile.cell, grid)
  }
  const dressAt = (node: number, box: AxisBox, side: TextSide): Dressed =>
    dress({ orientation, profile, node: model.nodes[node]!, box, lines: kept[node]!, side, gap: model.nodes[node]!.role === 'bar' ? outline : 0 })
  // Text side per node. A stack below a symbol whose lower face takes pipes
  // (vertical flow) sends its in-ports to the side; without room there the
  // symbol keeps its stack on the right.
  const side: TextSide[] = []
  const entries: Array<SideEntry | null> = []
  const shape: Array<AxisBox | null> = []
  for (const node of model.nodes) {
    if (node.role === 'bar') {
      side.push(screenFace(orientation, '+c'))
      entries.push(null)
      shape.push(null)
      continue
    }
    const bottom = axisFace(orientation, 'bottom')
    // Refined, a hub's label goes on its downstream end, which no pipe reaches: beside the hub it would widen the lanes' band.
    if (prepared.refine && node.role === 'hub') {
      side.push(screenFace(orientation, '+f'))
      entries.push(null)
      shape.push(footprintOf(node, false))
      continue
    }
    const fallback = chooseTextSide(orientation, prepared.pipeFaces[node.index]!)
    // A stub's label goes below its end where no pipe leaves that way: narrower, and only a line taller.
    if (policy === 'stubsBelow' && node.role === 'stub' && !prepared.pipeFaces[node.index]!.has(bottom)) {
      side.push('bottom')
      entries.push(null)
      shape.push(footprintOf(node, false))
      continue
    }
    const below = (node.role === 'device' || node.role === 'stub') && (policy === 'allBelow' || (policy === 'lanesBelow' && node.lane !== null))
    if (!below || !prepared.pipeFaces[node.index]!.has(bottom)) {
      side.push(below ? 'bottom' : fallback)
      entries.push(null)
      shape.push(footprintOf(node, false))
      continue
    }
    const box = footprintOf(node, true)
    const entry = bottom === '-f' && !prepared.flipped[node.index] ? planSideEntry(node, box, dressAt(node.index, box, 'bottom').text?.box ?? null, profile) : null
    side.push(entry === null ? fallback : 'bottom')
    entries.push(entry)
    shape.push(entry === null ? footprintOf(node, false) : box)
  }
  const dressNode = (node: number, box: AxisBox): Dressed => dressAt(node, box, side[node]!)
  const relative = model.nodes.map(node => {
    const own = shape[node.index]
    return own === null || own === undefined ? null : dressNode(node.index, own)
  })
  // A pipe reserves its half width and a pixel, so nothing touches it; it has no solid reach.
  const reachOf = (item: number, key: 'c0' | 'c1', withRisers: boolean): number => {
    const node = items[item]!.node
    if (node === null) return withRisers ? outline / 2 + 1 : -Infinity
    const own = relative[node]
    if (own === null || own === undefined) return 0
    const value = key === 'c0' ? -own.reserve.c0 : own.reserve.c1
    const entry = entries[node]
    return withRisers && key === 'c0' && entry !== null && entry !== undefined ? Math.max(value, -entry.reach) : value
  }
  const left = items.map((_, item) => reachOf(item, 'c0', true))
  const right = items.map((_, item) => reachOf(item, 'c1', true))
  const leftSolid = items.map((_, item) => reachOf(item, 'c0', false))
  const rightSolid = items.map((_, item) => reachOf(item, 'c1', false))

  const across = placeAcross({ model, profile, layering, ordering, left, right, leftSolid, rightSolid, refine: prepared.refine })
  const attachAt = (anchors: ReadonlyArray<number>) => attach({
    model, profile, layering, ordering, c: anchors, entries,
    box: model.nodes.map(node => (shape[node.index] === null ? { f0: 0, f1: 0, c0: 0, c1: 0 } : shiftBox(shape[node.index]!, 0, anchors[node.index]!))),
  })
  // Strands line up with the ports their ends were given, until none can move.
  let c = across.c
  let attached = attachAt(c)
  for (let next = across.align(attached.pin); next !== null; next = across.align(attached.pin)) {
    c = next
    attached = attachAt(c)
  }
  const plan = planChannels({ model, profile, layering, structure, pin: attached.pin, tighten: prepared.refine })

  // Bars: a line `outline` thick, rows a grid apart.
  const barLine = (node: number): AxisBox => ({ f0: -outline / 2, f1: outline / 2, c0: attached.span[node]![0], c1: attached.span[node]![1] })
  // A bar's label goes to the first end no vertical run passes: runs through
  // its layer (dummies), and runs to the other bars of its stack that cross
  // its row. Hubs may reach any row, so their band counts as taken.
  const hubReach = model.nodes.filter(node => node.role === 'hub').map(node => [c[node.index]! + relative[node.index]!.reserve.c0, c[node.index]! + relative[node.index]!.reserve.c1] as const)
  for (const bar of model.nodes.filter(node => node.role === 'bar')) {
    const layer = items[bar.index]!.layer
    const row = attached.barRow[bar.index]!
    const columns: number[] = []
    items.forEach((item, index) => { if (item.node === null && item.layer === layer) columns.push(c[index]!) })
    layering.chains.forEach((chain, index) => chain.items.forEach((item, position) => {
      if (item === bar.index || item >= nodeCount || model.nodes[item]!.role !== 'bar' || items[item]!.layer !== layer) return
      const neighbour = chain.items[position === 0 ? 1 : position - 1]!
      const otherRow = attached.barRow[item]!
      if (items[neighbour]!.layer < layer ? row < otherRow : row > otherRow) columns.push(attached.pin[index]![position]!)
    }))
    const stacked = model.nodes.filter(other => other.role === 'bar' && other.index !== bar.index && items[other.index]!.layer === layer)
    const free = (end: AxisFace): boolean => {
      const text = dress({ orientation, profile, node: bar, box: barLine(bar.index), lines: kept[bar.index]!, side: screenFace(orientation, end), gap: outline }).text
      if (text === null) return true
      const [low, high] = [text.box.c0 - outline / 2, text.box.c1 + outline / 2]
      const clearOfBars = stacked.every(other => {
        const offset = (attached.barRow[other.index]! - row) * grid
        const [a, b] = attached.span[other.index]!
        return b <= low || a >= high || offset + outline / 2 <= text.box.f0 || offset - outline / 2 >= text.box.f1
      })
      return clearOfBars && columns.every(column => column <= low || column >= high) && hubReach.every(([a, b]) => b <= text.box.c0 || a >= text.box.c1)
    }
    side[bar.index] = screenFace(orientation, free('+c') || !free('-c') ? '+c' : '-c')
  }
  const extents: LayerExtent[] = Array.from({ length: layering.layerCount }, () => ({ lowReserve: 0, highReserve: 0, lowFace: 0, highFace: 0 }))
  for (const node of model.nodes) {
    if (node.role === 'hub') continue
    const layer = items[node.index]!.layer
    const current = extents[layer]!
    if (node.role === 'bar') {
      const row = attached.barRow[node.index]! * grid
      const reserve = dressNode(node.index, barLine(node.index)).reserve
      extents[layer] = {
        lowReserve: Math.max(current.lowReserve, -(row + reserve.f0)),
        highReserve: Math.max(current.highReserve, row + reserve.f1),
        lowFace: current.lowFace,
        highFace: Math.max(current.highFace, row),
      }
      continue
    }
    const reserve = relative[node.index]!.reserve
    extents[layer] = {
      lowReserve: Math.max(current.lowReserve, -reserve.f0),
      highReserve: Math.max(current.highReserve, reserve.f1),
      lowFace: Math.max(current.lowFace, -shape[node.index]!.f0),
      highFace: Math.max(current.highFace, shape[node.index]!.f1),
    }
  }
  const along = placeAlong(profile, extents, plan)
  const trackF = (channel: number, net: number): number => along.firstTrack[channel]! + plan.offset[channel]![plan.track.get(trackKey(channel, net))!]!
  const stepTrack = (chain: number, step: number): number => {
    const jog = plan.jog[chain]![step]!
    return trackF(jog.channel, jog.net)
  }

  // Hubs grow along their side face to cover their tracks.
  const hubPorts = model.nodes.map(() => new Map<number, Set<number>>())
  layering.chains.forEach((chain, index) => chain.steps.forEach((_, k) => {
    for (const position of [k, k + 1]) {
      const item = chain.items[position]!
      if (item >= nodeCount || model.nodes[item]!.role !== 'hub') continue
      const edge = model.edges[chain.edge]!
      const port = item === edge.from ? edge.fromPort : edge.toPort
      const tracks = hubPorts[item]!.get(port) ?? new Set<number>()
      tracks.add(stepTrack(index, k))
      hubPorts[item]!.set(port, tracks)
    }
  }))
  const box: AxisBox[] = model.nodes.map(node => {
    const layer = items[node.index]!.layer
    if (node.role === 'bar') return shiftBox(barLine(node.index), along.axis[layer]! + attached.barRow[node.index]! * grid, 0)
    const placed = shiftBox(shape[node.index]!, along.axis[layer]!, c[node.index]!)
    if (node.role !== 'hub') return placed
    const tracks = [...hubPorts[node.index]!.values()].flatMap(set => [...set])
    if (tracks.length === 0) return placed
    const low = Math.min(...tracks)
    const high = Math.max(...tracks)
    const size = alongCells(node) * profile.cell
    const f0 = floorTo(Math.min(low - grid, (low + high) / 2 - size / 2), grid)
    const f1 = Math.max(f0 + size, ceilTo(high + grid, grid))
    return { f0, f1, c0: placed.c0, c1: placed.c1 }
  })
  hubPorts.forEach((ports, node) => ports.forEach((tracks, port) => {
    if (tracks.size > 1) throw new Error(`hub ${model.nodes[node]!.id} port ${model.nodes[node]!.ports[port]!.id} would need two places on its face; split its edges over separate ports`)
  }))
  const dressed = model.nodes.map(node => dressNode(node.index, box[node.index]!))

  // Polylines in the abstract axes. An approach runs from the item outward to
  // where it meets its channel: one point, or a side entry's turn and riser.
  const approach = (chain: number, position: number, face: 'in' | 'out' | 'pass', track: number): Point[] => {
    const item = layering.chains[chain]!.items[position]!
    const pinC = attached.pin[chain]![position]!
    if (item >= nodeCount) return [[along.axis[items[item]!.layer]!, pinC]]
    const node = model.nodes[item]!
    if (node.role === 'bar') return [[box[item]!.f0 + outline / 2, pinC]]
    if (node.role === 'hub') return [[track, pinC]]
    if (face === 'out') return [[box[item]!.f1 - node.portInset, pinC]]
    const edge = model.edges[layering.chains[chain]!.edge]!
    const entry = entries[item]?.ports.get(item === edge.from ? edge.fromPort : edge.toPort)
    if (entry === undefined) return [[box[item]!.f0 + node.portInset, pinC]]
    const slotF = along.axis[items[item]!.layer]! + entry.slot
    return [[slotF, box[item]!.c0 + node.portInset], [slotF, pinC]]
  }
  const paths: Point[][] = layering.chains.map((chain, index) => {
    const points: Point[] = []
    chain.steps.forEach((step, k) => {
      const jog = plan.jog[index]![k]!
      const track = jog === null ? Number.NaN : trackF(jog.channel, jog.net)
      const a = approach(index, k, step === 'turnBelow' ? 'in' : step === 'turnAbove' ? 'pass' : 'out', track)
      const b = approach(index, k + 1, step === 'turnAbove' ? 'out' : step === 'turnBelow' ? 'pass' : 'in', track).reverse()
      points.push(...a)
      if (jog !== null) points.push([track, a.at(-1)![1]], [track, b[0]![1]])
      points.push(...b)
    })
    const clean: Point[] = []
    for (const point of points) {
      const last = clean.at(-1)
      if (last !== undefined && last[0] === point[0] && last[1] === point[1]) continue
      if (clean.length >= 2) {
        const before = clean.at(-2)!
        if ((before[0] === last![0] && last![0] === point[0]) || (before[1] === last![1] && last![1] === point[1])) clean.pop()
      }
      clean.push(point)
    }
    return chain.reversed ? clean.reverse() : clean
  })

  // Ports, in the abstract axes, with their faces.
  const ports = model.nodes.map(node => {
    const list: Array<{ id: string; point: Point; face: AxisFace }> = []
    node.ports.forEach((port, index) => {
      if (port.use === 'unused') return
      if (node.role === 'hub') {
        const tracks = hubPorts[node.index]!.get(index)
        const low = ordering.hubSide === 'low'
        if (tracks !== undefined) list.push({ id: port.id, point: [[...tracks][0]!, low ? box[node.index]!.c1 - node.portInset : box[node.index]!.c0 + node.portInset], face: low ? '+c' : '-c' })
        return
      }
      if (node.role === 'bar') {
        const middle = (box[node.index]!.c0 + box[node.index]!.c1) / 2
        list.push({ id: port.id, point: [(box[node.index]!.f0 + box[node.index]!.f1) / 2, middle], face: port.use === 'target' ? '-f' : '+f' })
        return
      }
      const entry = entries[node.index]?.ports.get(index)
      if (entry !== undefined) {
        list.push({ id: port.id, point: [along.axis[items[node.index]!.layer]! + entry.slot, box[node.index]!.c0 + node.portInset], face: '-c' })
        return
      }
      const slot = attached.slot[node.index]![index]!
      list.push((port.use === 'target') !== prepared.flipped[node.index]
        ? { id: port.id, point: [box[node.index]!.f0 + node.portInset, slot], face: '-f' }
        : { id: port.id, point: [box[node.index]!.f1 - node.portInset, slot], face: '+f' })
    })
    return list
  })

  // Lane zones: the lane's band across, its items' reach along.
  const zoneBoxes: Array<{ lane: number; box: AxisBox }> = model.lanes.map((_, lane) => {
    const reach = items.flatMap(item => {
      if (item.lane !== lane) return []
      if (item.node === null) return [along.axis[item.layer]!]
      return [dressed[item.node]!.reserve.f0, dressed[item.node]!.reserve.f1]
    })
    const c0 = across.laneStart + lane * across.pitch
    return { lane, box: { f0: Math.min(...reach), f1: Math.max(...reach), c0, c1: c0 + across.pitch } }
  })

  // To screen, then translate by whole grid steps so the drawing starts at the origin.
  const rect = (b: AxisBox): Rect => toScreenRect(orientation, b)
  const screenPaths = paths.map(path => path.map(([f, cc]) => toScreen(orientation, f, cc)))
  const extentRects: Rect[] = [
    ...dressed.flatMap(d => [rect(d.box), ...(d.text === null ? [] : [rect(d.text.box)]), ...(d.frame === null ? [] : [rect(d.frame)])]),
    ...screenPaths.flatMap(path => path.map(([x, y]) => ({ x: x - outline / 2, y: y - outline / 2, width: outline, height: outline }))),
  ]
  const minX = Math.min(...extentRects.map(r => r.x))
  const minY = Math.min(...extentRects.map(r => r.y))
  const dx = -floorTo(minX, grid)
  const dy = -floorTo(minY, grid)
  const width = Math.ceil(Math.max(...extentRects.map(r => r.x + r.width)) + dx - 1e-6)
  const height = Math.ceil(Math.max(...extentRects.map(r => r.y + r.height)) + dy - 1e-6)
  const move = (point: Point): readonly [number, number] => [point[0] + dx, point[1] + dy]
  const nodes: PlacedNode[] = model.nodes.map(node => {
    const d = dressed[node.index]!
    const r = translateRect(rect(d.box), dx, dy)
    const portRecord: Record<string, { x: number; y: number; face: Face }> = {}
    for (const entry of ports[node.index]!) {
      const [x, y] = move(toScreen(orientation, entry.point[0], entry.point[1]))
      portRecord[entry.id] = { x, y, face: screenFace(orientation, entry.face) }
    }
    const text = d.text === null ? null : { ...translateRect(rect(d.text.box), dx, dy), side: d.text.side, lines: d.text.lines }
    return { id: node.id, x: r.x, y: r.y, width: r.width, height: r.height, ports: portRecord, text, frame: d.frame === null ? null : translateRect(rect(d.frame), dx, dy) }
  })
  const zones: DiagramZone[] = zoneBoxes.map(({ lane, box: zoneBox }) => {
    const r = translateRect(rect(zoneBox), dx, dy)
    const x0 = Math.max(0, r.x)
    const y0 = Math.max(0, r.y)
    const x1 = Math.min(width, r.x + r.width)
    const y1 = Math.min(height, r.y + r.height)
    return { lane: model.lanes[lane]!, x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
  })
  return { orientation, detail, policy, width, height, nodes, paths: screenPaths.map(path => path.map(move)), zones }
}
