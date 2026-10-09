// The diagram engine's entry point. Density limits are checked first, from
// the graph alone. Then the profile's fit ladder runs from richest to leanest
// (which text the stacks keep, and where they go: right of symbols, stub
// labels below, below the symbols of lanes, below every symbol). Each rung is
// laid out in both orientations and in each arrangement the graph allows
// (hubs on either side of the lanes, reaching their items near or from the
// outer channel; cycles whose return runs through shared symbols folded or
// not), and the first rung with an attempt that verifies, keeps within the
// crossing limits and fits the box wins; within it, fewer crossings, then the
// earlier arrangement (the plain one first), then the better fit. The crossing
// limits are absolute and relative to the crossings the graph's structure
// forces (bound.ts). Without one, the result says why: density (crossings,
// when every attempt crosses too often, verified or not), the smallest size
// per orientation, or the verifier's findings. Nothing is truncated silently.
import { runAttempt, prepare, type AttemptGeometry } from './attempt.ts'
import { breakCycles, foldReturns } from './cycles.ts'
import { findCrossings, drawingSegments, gapsByEdge } from './crossings.ts'
import type { DiagramGraph, DiagramLayoutResult, DiagramProfile, DiagramViolation, RoutedEdge } from './diagram.ts'
import { ORIENTATIONS } from './geometry.ts'
import { geometryHash } from './hash.ts'
import { forcedCrossings } from './bound.ts'
import { assignLayers, layerNodes, plainLayering, type LayeringOptions } from './layering.ts'
import { buildModel, validateProfile, type Model } from './model.ts'
import { orderLayers, type HubSide } from './ordering.ts'
import { keptLines } from './shapes.ts'
import { analyseStructure } from './structure.ts'
import { verifyLayout } from './verify.ts'

export * from './diagram.ts'

type Reason = Extract<DiagramLayoutResult, { ok: false }>['reasons'][number]

interface Judged {
  /** Index of the arrangement it was drawn in. */
  readonly arrangement: number
  readonly geometry: AttemptGeometry
  readonly edges: ReadonlyArray<RoutedEdge>
  readonly crossings: number
  /** The verifier's findings, computed when first asked for. */
  readonly violations: () => ReadonlyArray<DiagramViolation>
  readonly fits: boolean
}

const densityReasons = (model: Model, profile: DiagramProfile): Reason[] => {
  const symbol = (role: string): boolean => role === 'device' || role === 'hub'
  const symbols = model.nodes.filter(node => symbol(node.role))
  const perLane = model.lanes.map((_, lane) => symbols.filter(node => node.lane === lane).length)
  const counts: Array<[keyof DiagramProfile['limits'], number]> = [
    ['symbols', symbols.length],
    ['symbolsPerLane', Math.max(0, ...perLane)],
    ['sharedSymbols', symbols.filter(node => node.lane === null).length],
    ['lanes', model.lanes.length],
  ]
  return counts.filter(([limit, count]) => count > profile.limits[limit]).map(([limit, count]) => ({ kind: 'density', limit, count, max: profile.limits[limit] }))
}

const judge = (model: Model, net: ReadonlyArray<number>, profile: DiagramProfile, arrangement: number, geometry: AttemptGeometry): Judged => {
  const bare: RoutedEdge[] = model.edges.map((edge, e) => ({ id: edge.id, points: geometry.paths[e]!, gaps: [] }))
  const crossings = findCrossings(drawingSegments(model, net, geometry.nodes, bare))
  const gaps = gapsByEdge(model.edges.length, crossings, bare)
  const edges = bare.map((edge, e) => ({ ...edge, gaps: gaps[e]! }))
  let violations: ReadonlyArray<DiagramViolation> | null = null
  return {
    arrangement,
    geometry,
    edges,
    crossings: crossings.length,
    violations: () => (violations ??= verifyLayout({ model, net, profile, width: geometry.width, height: geometry.height, nodes: geometry.nodes, edges })),
    fits: geometry.width <= profile.maxWidth && geometry.height <= profile.maxHeight,
  }
}

const overflow = (profile: DiagramProfile, judged: Judged): number => Math.max(judged.geometry.width / profile.maxWidth, judged.geometry.height / profile.maxHeight)

/** How far over the crossing limit an arrangement's first drawings may be and still be drawn at the leaner rungs. */
const ARRANGEMENT_SLACK = 2

interface Arrangement {
  readonly reversed: ReadonlyArray<boolean>
  readonly layering: LayeringOptions
  readonly hubSide: HubSide
  /** Order refined by swaps that cross less, stubs beside their symbols, strands before the axis where ordered there. */
  readonly refine: boolean
}

/**
 * The arrangements a graph allows, the plain one first: hubs beside lane 0
 * reaching each item through the channel before it, no fold, no refinement.
 * Then refined ones: with hubs, beside lane 0 or after the last lane, reaching
 * near or from the outer channel; with a return leg through shared symbols,
 * each also folded.
 */
const arrangements = (model: Model): ReadonlyArray<Arrangement> => {
  const reversed = breakCycles(model)
  const plain = plainLayering(model)
  const fold = foldReturns(model, reversed, layerNodes(model, reversed))
  const hubs = model.nodes.some(node => node.role === 'hub') && model.lanes.length > 0
  const placements: ReadonlyArray<{ readonly hubSide: HubSide; readonly hubReach: LayeringOptions['hubReach'] }> = hubs
    ? [{ hubSide: 'low', hubReach: 'near' }, { hubSide: 'low', hubReach: 'outer' }, { hubSide: 'high', hubReach: 'near' }, { hubSide: 'high', hubReach: 'outer' }]
    : [{ hubSide: 'low', hubReach: 'near' }]
  return [
    { reversed, layering: plain, hubSide: 'low', refine: false },
    ...placements.map(({ hubSide, hubReach }) => ({ reversed, layering: { ...plain, hubReach }, hubSide, refine: true })),
    ...(fold === null ? [] : placements.map(({ hubSide, hubReach }) => ({ reversed: fold.reversed, layering: { flipped: fold.flipped, folded: fold.folded, hubReach }, hubSide, refine: true }))),
  ]
}

export const layoutDiagram = (graph: DiagramGraph, profile: DiagramProfile): DiagramLayoutResult => {
  validateProfile(profile)
  const model = buildModel(graph)
  const density = densityReasons(model, profile)
  if (density.length > 0) return { ok: false, reasons: density }

  const forced = forcedCrossings(model)
  const allowed = Math.min(profile.limits.crossings, forced + profile.limits.crossingsOverBound)
  const crossingLimit = allowed === profile.limits.crossings ? 'crossings' as const : 'crossingsOverBound' as const
  const structure = analyseStructure(model)
  const prepared = arrangements(model).map(({ reversed, layering, hubSide, refine }) => {
    const layered = assignLayers(model, structure, reversed, layering)
    return prepare(model, structure, layered, orderLayers(model, layered, hubSide, refine ? { net: structure.net } : null), layering.flipped, refine)
  })
  const optional = model.nodes.some(node => keptLines(node, 'required') < node.lines.length)
  const rungs = profile.fit
    .filter(rung => (optional || rung.detail === 'full') && (model.lanes.length > 0 || rung.text !== 'lanesBelow'))
    .map(rung => ({ detail: rung.detail, policy: rung.text }))
  const attempts: Judged[] = []
  // Arrangements far over the crossing limit in the first rung are not drawn again (the plain one always is).
  let drawn = prepared.map((_, index) => index)
  for (const [rung, { detail, policy }] of rungs.entries()) {
    const round = drawn.flatMap(index => ORIENTATIONS.map(orientation => judge(model, structure.net, profile, index, runAttempt(prepared[index]!, profile, orientation, detail, policy))))
    attempts.push(...round)
    if (rung === 0) drawn = drawn.filter(index => index === 0 || Math.min(...round.filter(judged => judged.arrangement === index).map(judged => judged.crossings)) <= allowed + ARRANGEMENT_SLACK)
    const best = round
      .filter(judged => judged.crossings <= allowed && judged.fits)
      .sort((a, b) => (a.crossings - b.crossings) || (a.arrangement - b.arrangement) || (overflow(profile, a) - overflow(profile, b)))
      .find(judged => judged.violations().length === 0)
    if (best === undefined) continue
    const { geometry, edges } = best
    return {
      ok: true,
      width: geometry.width,
      height: geometry.height,
      nodes: geometry.nodes,
      edges,
      zones: geometry.zones,
      hash: geometryHash(model, geometry.width, geometry.height, geometry.nodes, edges, geometry.zones),
      crossings: best.crossings,
      forcedCrossings: forced,
    }
  }

  // Too many crossings in every attempt, verified or not, is the reason to
  // give: no drawing of this graph would be accepted whatever else is wrong.
  const verified = attempts.filter(judged => judged.violations().length === 0)
  const fewestCrossings = Math.min(...(verified.length > 0 ? verified : attempts).map(judged => judged.crossings))
  if (fewestCrossings > allowed) {
    return { ok: false, reasons: [{ kind: 'density', limit: crossingLimit, count: fewestCrossings, max: allowed }] }
  }
  if (verified.length === 0) {
    const fewest = [...attempts].sort((a, b) => a.violations().length - b.violations().length)[0]!
    return { ok: false, reasons: [{ kind: 'unverifiable', violations: fewest.violations() }] }
  }
  const withinCrossings = verified.filter(judged => judged.crossings <= allowed)
  // Per orientation, the drawing that comes closest to the box.
  const reasons: Reason[] = ORIENTATIONS.flatMap(orientation => {
    const smallest = withinCrossings
      .filter(judged => judged.geometry.orientation === orientation)
      .sort((a, b) => (overflow(profile, a) - overflow(profile, b)) || (a.geometry.width * a.geometry.height - b.geometry.width * b.geometry.height))[0]
    return smallest === undefined ? [] : [{ kind: 'size' as const, width: smallest.geometry.width, height: smallest.geometry.height }]
  })
  return { ok: false, reasons }
}

/** Runs the verifier on a result of `layoutDiagram` for the same graph and profile. */
export const verifyDiagram = (graph: DiagramGraph, profile: DiagramProfile, result: Extract<DiagramLayoutResult, { ok: true }>): DiagramViolation[] => {
  const model = buildModel(graph)
  const byId = <T extends { readonly id: string }>(list: ReadonlyArray<T>): Map<string, T> => new Map(list.map(entry => [entry.id, entry]))
  const nodes = byId(result.nodes)
  const edges = byId(result.edges)
  return verifyLayout({
    model,
    net: analyseStructure(model).net,
    profile,
    width: result.width,
    height: result.height,
    nodes: model.nodes.map(node => nodes.get(node.id)!),
    edges: model.edges.map(edge => edges.get(edge.id)!),
  })
}
