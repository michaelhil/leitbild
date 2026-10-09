import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  layoutDiagram,
  verifyDiagram,
  type DiagramEdge,
  type DiagramGraph,
  type DiagramLayoutResult,
  type DiagramNode,
  type DiagramProfile,
  type DiagramText,
} from '../src/packs/process-plant/displays/mimic/layout/index.ts'

// Synthetic, Plant-agnostic fixtures: the engine sees only structure.

type Line = DiagramText['lines'][number]
const tag = (width: number): Line => ({ width, height: 16, required: true })
const row = (width: number, required = false): Line => ({ width, height: 20, required })
const LANES = ['A', 'B', 'C', 'D', 'E', 'F']

interface NodeOptions {
  readonly lane?: number
  readonly cells?: readonly [number, number]
  readonly inset?: number
  readonly lines?: ReadonlyArray<Line>
  readonly frameable?: boolean
  readonly flapWidth?: number
}

const node = (id: string, role: DiagramNode['role'], rank: string, ports: Record<string, 'in' | 'out'>, options: NodeOptions = {}): DiagramNode => ({
  id,
  rank,
  role,
  cells: { width: options.cells?.[0] ?? 2, height: options.cells?.[1] ?? 2 },
  portInset: options.inset ?? 0,
  ports: Object.entries(ports).map(([port, direction]) => ({ id: port, direction, rank: port })),
  ...(options.lane === undefined ? {} : { lane: { key: `lane-${LANES[options.lane]}`, order: options.lane } }),
  text: { lines: options.lines ?? [] },
  frameable: options.frameable ?? false,
  ...(options.flapWidth === undefined ? {} : { flapWidth: options.flapWidth }),
})
const edge = (id: string, rank: string, from: string, to: string): DiagramEdge => {
  const [fromNode, fromPort] = from.split(':') as [string, string]
  const [toNode, toPort] = to.split(':') as [string, string]
  return { id, rank, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } }
}
const pump = (id: string, rank: string, lane?: number): DiagramNode =>
  node(id, 'device', rank, { in: 'in', out: 'out' }, { ...(lane === undefined ? {} : { lane }), lines: [tag(44), row(40)], frameable: true, flapWidth: 52 })
const valve = (id: string, rank: string, lane?: number): DiagramNode =>
  node(id, 'device', rank, { in: 'in', out: 'out' }, { ...(lane === undefined ? {} : { lane }), lines: [tag(48), row(44)], frameable: true, flapWidth: 40 })
const vessel = (id: string, rank: string, ports: Record<string, 'in' | 'out'>, lane?: number): DiagramNode =>
  node(id, 'device', rank, ports, { ...(lane === undefined ? {} : { lane }), cells: [2, 4], inset: 5, lines: [tag(40), row(52, true)], frameable: true, flapWidth: 44 })

const chain = (): DiagramGraph => ({
  nodes: [
    node('source', 'stub', 'a.source', { out: 'out' }, { cells: [2, 1], lines: [tag(72)] }),
    pump('pump', 'b.pump'),
    valve('valve', 'c.valve'),
    vessel('tank', 'd.tank', { in: 'in' }),
  ],
  edges: [
    edge('e1', 'line', 'source:out', 'pump:in'),
    edge('e2', 'line', 'pump:out', 'valve:in'),
    edge('e3', 'line', 'valve:out', 'tank:in'),
  ],
})

const headerFanOut = (lanes: number): DiagramGraph => ({
  nodes: [
    pump('pump-1', 'pump.1'),
    pump('pump-2', 'pump.2'),
    node('header', 'bar', 'header', { in: 'in', out: 'out' }, { lines: [tag(56)] }),
    ...Array.from({ length: lanes }, (_, lane) => [valve(`valve-${lane}`, 'valve', lane), vessel(`vessel-${lane}`, 'vessel', { in: 'in' }, lane)]).flat(),
  ],
  edges: [
    edge('p1', 'feed', 'pump-1:out', 'header:in'),
    edge('p2', 'feed', 'pump-2:out', 'header:in'),
    ...Array.from({ length: lanes }, (_, lane) => [
      edge(`b-${lane}`, 'branch', 'header:out', `valve-${lane}:in`),
      edge(`l-${lane}`, 'line', `valve-${lane}:out`, `vessel-${lane}:in`),
    ]).flat(),
  ],
})

/** The classic loop drawing: every lane leaves the hub and returns to it. */
const hubLoops = (lanes: number): DiagramGraph => ({
  nodes: [
    node('hub', 'hub', 'hub', Object.fromEntries(Array.from({ length: lanes }, (_, lane) => [[`out-${LANES[lane]}`, 'out'], [`in-${LANES[lane]}`, 'in']]).flat()), { cells: [2, 4], inset: 5, lines: [tag(36)] }),
    ...Array.from({ length: lanes }, (_, lane) => [vessel(`vessel-${lane}`, 'vessel', { in: 'in', out: 'out' }, lane), pump(`pump-${lane}`, 'pump', lane)]).flat(),
  ],
  edges: Array.from({ length: lanes }, (_, lane) => [
    edge(`hot-${lane}`, 'hot', `hub:out-${LANES[lane]}`, `vessel-${lane}:in`),
    edge(`mid-${lane}`, 'mid', `vessel-${lane}:out`, `pump-${lane}:in`),
    edge(`cold-${lane}`, 'cold', `pump-${lane}:out`, `hub:in-${LANES[lane]}`),
  ]).flat(),
})

/** Two headers (feed and auxiliary feed) feeding the same lane vessels. */
const combined = (lanes: number): DiagramGraph => ({
  nodes: [
    pump('feed-pump-1', 'feed.pump.1'),
    pump('feed-pump-2', 'feed.pump.2'),
    pump('aux-pump-1', 'aux.pump.1'),
    pump('aux-pump-2', 'aux.pump.2'),
    node('feed-header', 'bar', 'feed.header', { in: 'in', out: 'out' }, { lines: [tag(64)] }),
    node('aux-header', 'bar', 'aux.header', { in: 'in', out: 'out' }, { lines: [tag(60)] }),
    ...Array.from({ length: lanes }, (_, lane) => [
      valve(`feed-valve-${lane}`, 'feed.valve', lane),
      valve(`aux-valve-${lane}`, 'aux.valve', lane),
      vessel(`vessel-${lane}`, 'vessel', { feed: 'in', aux: 'in', steam: 'out' }, lane),
      node(`steam-${lane}`, 'stub', 'steam', { in: 'in' }, { lane, cells: [2, 1], lines: [tag(64)] }),
    ]).flat(),
  ],
  edges: [
    edge('fp1', 'feed', 'feed-pump-1:out', 'feed-header:in'),
    edge('fp2', 'feed', 'feed-pump-2:out', 'feed-header:in'),
    edge('ap1', 'aux', 'aux-pump-1:out', 'aux-header:in'),
    edge('ap2', 'aux', 'aux-pump-2:out', 'aux-header:in'),
    ...Array.from({ length: lanes }, (_, lane) => [
      edge(`fb-${lane}`, 'branch', 'feed-header:out', `feed-valve-${lane}:in`),
      edge(`fl-${lane}`, 'line', `feed-valve-${lane}:out`, `vessel-${lane}:feed`),
      edge(`ab-${lane}`, 'branch', 'aux-header:out', `aux-valve-${lane}:in`),
      edge(`al-${lane}`, 'line', `aux-valve-${lane}:out`, `vessel-${lane}:aux`),
      edge(`st-${lane}`, 'steam', `vessel-${lane}:steam`, `steam-${lane}:in`),
    ]).flat(),
  ],
})

// OpenBridge on its 24 px grid; the box is generous so every fixture fits.
const profile: DiagramProfile = {
  grid: 24,
  cell: 24,
  pipe: { outline: 6, cornerRadius: 8, crossingHalfGap: 5 },
  textClearance: 9,
  frameMargin: 1,
  flapHeight: 21,
  flapLabelPadding: 28,
  maxWidth: 1600,
  maxHeight: 1000,
  limits: { symbols: 40, symbolsPerLane: 4, sharedSymbols: 8, lanes: 6, crossings: 12, bendsPerEdge: 3 },
}

const accepted = (graph: DiagramGraph, using: DiagramProfile = profile): Extract<DiagramLayoutResult, { ok: true }> => {
  const result = layoutDiagram(graph, using)
  if (!result.ok) throw new Error(`layout refused: ${JSON.stringify(result.reasons)}`)
  return result
}
const crossings = (result: Extract<DiagramLayoutResult, { ok: true }>): number => result.edges.reduce((sum, routed) => sum + routed.gaps.length, 0)

// Deterministic shuffles and renames.
const random = (seed: number): (() => number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const shuffle = <T>(values: ReadonlyArray<T>, next: () => number): T[] => {
  const copy = [...values]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy
}
const scramble = (graph: DiagramGraph, seed: number): DiagramGraph => {
  const next = random(seed)
  const fresh = (prefix: string): string => `${prefix}${Math.floor(next() * 1e9).toString(36)}`
  const nodeIds = new Map(graph.nodes.map(n => [n.id, fresh('n')]))
  const portIds = new Map(graph.nodes.flatMap(n => n.ports.map(p => [`${n.id}:${p.id}`, fresh('p')] as const)))
  const laneKeys = new Map(graph.nodes.flatMap(n => (n.lane === undefined ? [] : [[n.lane.key, fresh('z')] as const])))
  return {
    nodes: shuffle(graph.nodes, next).map(n => ({
      ...n,
      id: nodeIds.get(n.id)!,
      ports: shuffle(n.ports, next).map(p => ({ ...p, id: portIds.get(`${n.id}:${p.id}`)! })),
      ...(n.lane === undefined ? {} : { lane: { key: laneKeys.get(n.lane.key)!, order: n.lane.order } }),
    })),
    edges: shuffle(graph.edges, next).map(e => ({
      ...e,
      id: fresh('e'),
      from: { node: nodeIds.get(e.from.node)!, port: portIds.get(`${e.from.node}:${e.from.port}`)! },
      to: { node: nodeIds.get(e.to.node)!, port: portIds.get(`${e.to.node}:${e.to.port}`)! },
    })),
  }
}

const fixtures: ReadonlyArray<readonly [string, DiagramGraph]> = [
  ['chain', chain()],
  ...[2, 3, 4, 6].flatMap(lanes => [
    [`header fan-out, ${lanes} lanes`, headerFanOut(lanes)] as const,
    [`hub loops, ${lanes} lanes`, hubLoops(lanes)] as const,
    [`combined headers, ${lanes} lanes`, combined(lanes)] as const,
  ]),
]

describe('diagram layout engine', () => {
  for (const [name, graph] of fixtures) {
    test(`${name}: accepted, verified clean, deterministic and id-free`, () => {
      const result = accepted(graph)
      expect(verifyDiagram(graph, profile, result)).toEqual([])
      for (let run = 0; run < 50; run++) expect(layoutDiagram(graph, profile)).toMatchObject({ ok: true, hash: result.hash })
      for (const seed of [1, 2, 3]) expect(accepted(scramble(graph, seed)).hash).toBe(result.hash)
    })
  }

  test('a chain draws straight, with no bends', () => {
    const result = accepted(chain())
    for (const routed of result.edges) expect(routed.points).toHaveLength(2)
  })

  test('a header spans its branches and every branch meets it straight', () => {
    const result = accepted(headerFanOut(4))
    expect(crossings(result)).toBe(0)
    for (const routed of result.edges) expect(routed.points).toHaveLength(2)
  })

  test('loop drawings have no crossings at any lane count', () => {
    for (const lanes of [2, 3, 4, 6]) expect(crossings(accepted(hubLoops(lanes)))).toBe(0)
  })

  test('the combined drawing gaps every crossing on the vertical pipe', () => {
    const result = accepted(combined(4))
    expect(crossings(result)).toBeGreaterThan(0)
    for (const routed of result.edges) {
      for (const [x, y] of routed.gaps) {
        const onVertical = routed.points.slice(1).some((b, i) => {
          const a = routed.points[i]!
          return a[0] === x && b[0] === x && Math.min(a[1], b[1]) < y && y < Math.max(a[1], b[1])
        })
        expect(onVertical).toBe(true)
      }
    }
  })

  test('adding lanes leaves lane 0 of a loop drawing where it was', () => {
    // A box too short for lanes stacked vertically, so flow runs bottom to top.
    const wide = { ...profile, maxWidth: 2400, maxHeight: 520 }
    const lane0 = (result: Extract<DiagramLayoutResult, { ok: true }>) => ({
      nodes: result.nodes.filter(n => n.id === 'vessel-0' || n.id === 'pump-0'),
      edges: result.edges.filter(e => e.id.endsWith('-0')),
      zone: result.zones[0],
    })
    const base = accepted(hubLoops(4), wide)
    const hub = base.nodes.find(n => n.id === 'hub')!
    const pump0 = base.nodes.find(n => n.id === 'pump-0')!
    const vessel0 = base.nodes.find(n => n.id === 'vessel-0')!
    expect(hub.x).toBeLessThan(vessel0.x)
    expect(pump0.y).toBeLessThan(vessel0.y)
    for (const lanes of [5, 6]) expect(lane0(accepted(hubLoops(lanes), wide))).toEqual(lane0(base))
  })

  test('symbols snap to the grid and ports sit on grid lines', () => {
    const result = accepted(combined(3))
    for (const placed of result.nodes) {
      if (placed.id.includes('header')) continue
      expect(placed.x % 24).toBe(0)
      expect(placed.y % 24).toBe(0)
      for (const port of Object.values(placed.ports)) expect((port.face === 'left' || port.face === 'right' ? port.y : port.x) % 24).toBe(0)
    }
  })

  test('a frameable node reserves its flap below, wide enough for its label', () => {
    const result = accepted(chain())
    const placed = result.nodes.find(n => n.id === 'pump')!
    const frame = placed.frame!
    const text = placed.text!
    const button = { top: Math.min(placed.y, text.y), bottom: Math.max(placed.y + placed.height, text.y + text.height) }
    expect(frame.y + frame.height).toBe(button.bottom + 1 + 21)
    expect(frame.y).toBe(button.top - 1)
    expect(frame.width).toBeGreaterThanOrEqual(52 + 28)
  })

  test('a drawing too wide with text right of its symbols fits with text below them', () => {
    const budget = { ...profile, maxWidth: 600, maxHeight: 624 }
    const graph = hubLoops(4)
    const roomy = accepted(graph)
    expect(roomy.width).toBeGreaterThan(600)
    for (const placed of roomy.nodes.filter(n => /^(vessel|pump)-/.test(n.id))) expect(placed.text!.side).toBe('right')
    const result = accepted(graph, budget)
    expect(result.width).toBeLessThanOrEqual(600)
    for (const placed of result.nodes.filter(n => /^(vessel|pump)-/.test(n.id))) {
      expect(placed.text!.side).toBe('bottom')
      // The stack covers the symbol's lower face, so its inlet enters the side.
      expect(placed.ports['in']!.face).toBe('left')
    }
    expect(verifyDiagram(graph, budget, result)).toEqual([])
    expect(crossings(result)).toBe(0)
    for (const seed of [1, 2]) expect(accepted(scramble(graph, seed), budget).hash).toBe(result.hash)
    // Lane symbols go below first; the shared pumps under a header keep their text right.
    const fanOut = accepted(headerFanOut(6), budget)
    expect(fanOut.width).toBeLessThanOrEqual(600)
    expect(fanOut.nodes.find(n => n.id === 'valve-0')!.text!.side).toBe('bottom')
    expect(fanOut.nodes.find(n => n.id === 'pump-1')!.text!.side).toBe('right')
    expect(verifyDiagram(headerFanOut(6), budget, fanOut)).toEqual([])
  })

  test('when the full text does not fit, optional trailing lines go, and the result says how many show', () => {
    // Left to right the stacks sit below their symbols, so dropping a line saves height.
    const result = accepted(chain(), { ...profile, maxWidth: 470, maxHeight: 150 })
    expect(result.nodes.find(n => n.id === 'pump')!.text!.lines).toBe(1)
    expect(result.nodes.find(n => n.id === 'tank')!.text!.lines).toBe(2)
    expect(accepted(chain()).nodes.find(n => n.id === 'pump')!.text!.lines).toBe(2)
  })

  test('the verifier finds tampered geometry', () => {
    const graph = hubLoops(2)
    const result = accepted(graph)
    const rules = (tampered: typeof result): string[] => [...new Set(verifyDiagram(graph, profile, tampered).map(v => v.rule))]
    const vessel = result.nodes.find(n => n.id === 'vessel-0')!
    const other = result.nodes.find(n => n.id === 'vessel-1')!
    const withNode = (id: string, change: (n: typeof vessel) => typeof vessel): typeof result => ({ ...result, nodes: result.nodes.map(n => (n.id === id ? change(n) : n)) })
    const withEdge = (id: string, points: Array<readonly [number, number]>): typeof result => ({ ...result, edges: result.edges.map(e => (e.id === id ? { ...e, points } : e)) })
    expect(rules(withNode('pump-0', n => ({ ...n, x: vessel.x, y: vessel.y })))).toContain('overlap')
    expect(rules(withNode('pump-0', n => ({ ...n, x: n.x + 5 })))).toContain('pitch')
    expect(rules(withNode('pump-0', n => ({ ...n, x: -48 })))).toContain('outsideBox')
    const frame = other.frame!
    expect(rules(withNode('pump-0', n => ({ ...n, text: { ...n.text!, x: frame.x + frame.width + 3, y: frame.y } })))).toContain('textClearance')
    const mid = result.edges.find(e => e.id === 'mid-0')!.points
    expect(rules(withEdge('mid-0', [mid[0]!, [mid[1]![0] + 24, mid[1]![1]]]))).toContain('diagonal')
    const [from, to] = [mid[0]!, mid.at(-1)!]
    const step = (to[1] - from[1]) / 4
    const zigzag: Array<readonly [number, number]> = [from, [from[0], from[1] + step], [from[0] + 24, from[1] + step], [from[0] + 24, from[1] + 2 * step], [from[0], from[1] + 2 * step], to]
    expect(rules(withEdge('mid-0', zigzag))).toContain('bends')
  })

  test('too many symbols or too wide a drawing is refused with explicit reasons', () => {
    const crowded = layoutDiagram(combined(4), { ...profile, limits: { ...profile.limits, symbols: 12, symbolsPerLane: 2 } })
    expect(crowded).toEqual({
      ok: false,
      reasons: [
        { kind: 'density', limit: 'symbols', count: 16, max: 12 },
        { kind: 'density', limit: 'symbolsPerLane', count: 3, max: 2 },
      ],
    })
    const tangled = layoutDiagram(combined(4), { ...profile, limits: { ...profile.limits, crossings: 2 } })
    expect(tangled).toEqual({ ok: false, reasons: [{ kind: 'density', limit: 'crossings', count: 5, max: 2 }] })
    const lanes = layoutDiagram(hubLoops(6), { ...profile, limits: { ...profile.limits, lanes: 4 } })
    expect(lanes).toEqual({ ok: false, reasons: [{ kind: 'density', limit: 'lanes', count: 6, max: 4 }] })
    const narrow = layoutDiagram(hubLoops(6), { ...profile, maxWidth: 400, maxHeight: 300 })
    expect(narrow.ok).toBe(false)
    if (narrow.ok) return
    expect(narrow.reasons.length).toBe(2)
    for (const reason of narrow.reasons) {
      expect(reason.kind).toBe('size')
      if (reason.kind === 'size') expect(reason.width > 400 || reason.height > 300).toBe(true)
    }
  })

  test('input the engine cannot order by structure is rejected', () => {
    const twins: DiagramGraph = { nodes: [pump('a', 'same'), pump('b', 'same')], edges: [edge('e', 'line', 'a:out', 'b:in')] }
    expect(() => layoutDiagram(twins, profile)).toThrow(/share rank/)
    const backwards: DiagramGraph = { nodes: [pump('a', 'a'), pump('b', 'b')], edges: [edge('e', 'line', 'a:in', 'b:in')] }
    expect(() => layoutDiagram(backwards, profile)).toThrow(/leaves through in-port/)
  })

  test('the engine imports nothing outside itself: it stays Plant-agnostic', () => {
    const folder = join(import.meta.dir, '../src/packs/process-plant/displays/mimic/layout')
    for (const file of readdirSync(folder).filter(name => name.endsWith('.ts'))) {
      const specifiers = [...readFileSync(join(folder, file), 'utf8').matchAll(/from '([^']+)'/g)].map(match => match[1]!)
      for (const specifier of specifiers) expect(specifier.startsWith('./') || specifier === 'node:crypto').toBe(true)
    }
  })

  test('lays out within 50 ms at p99, up to 40 nodes and 60 edges', () => {
    const largest = dense()
    expect([largest.nodes.length, largest.edges.length]).toEqual([40, 60])
    const graphs = [...fixtures.map(([, graph]) => graph), largest]
    const timings: number[] = []
    for (let run = 0; run < 20; run++) {
      for (const graph of graphs) {
        const start = performance.now()
        layoutDiagram(graph, profile)
        timings.push(performance.now() - start)
      }
    }
    timings.sort((a, b) => a - b)
    expect(timings[Math.floor(timings.length * 0.99)]!).toBeLessThan(50)
  })
})

/** 40 nodes and 60 edges: the combined drawing at six lanes with suction, drains, bypasses, recirculation and spills. */
const dense = (): DiagramGraph => {
  const lanes = 6
  const base = combined(lanes)
  return {
    nodes: [
      ...base.nodes.map(n => (n.id.startsWith('vessel-') ? { ...n, ports: [...n.ports, { id: 'drain', direction: 'out' as const, rank: 'drain' }] } : n)),
      vessel('tank', 'tank', { out: 'out', return: 'in' }),
      ...Array.from({ length: lanes }, (_, lane) => node(`drain-${lane}`, 'stub', 'drain', { in: 'in' }, { lane, cells: [2, 1], lines: [tag(48)] })),
      ...['a', 'b', 'c'].map(k => node(`spill-${k}`, 'stub', `spill.${k}`, { in: 'in' }, { cells: [2, 1], lines: [tag(40)] })),
    ],
    edges: [
      ...base.edges,
      ...['feed-pump-1', 'feed-pump-2', 'aux-pump-1', 'aux-pump-2'].map((p, i) => edge(`t-${i}`, 'suction', 'tank:out', `${p}:in`)),
      ...Array.from({ length: lanes }, (_, lane) => [
        edge(`dr-${lane}`, 'drain', `vessel-${lane}:drain`, `drain-${lane}:in`),
        edge(`by-${lane}`, 'bypass', 'feed-header:out', `vessel-${lane}:feed`),
        edge(`rc-${lane}`, 'recirculation', `aux-valve-${lane}:out`, 'tank:return'),
      ]).flat(),
      edge('sp-a', 'spill', 'feed-header:out', 'spill-a:in'),
      edge('sp-a2', 'spill.2', 'feed-header:out', 'spill-a:in'),
      edge('sp-b', 'spill', 'aux-header:out', 'spill-b:in'),
      edge('sp-c', 'spill', 'tank:out', 'spill-c:in'),
    ],
  }
}
