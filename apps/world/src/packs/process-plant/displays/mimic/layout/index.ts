// The diagram engine's entry point. Density limits are checked first, from
// the graph alone. Then a ladder of drawings runs from richest to leanest:
// full text, then only required lines (when any node has optional trailing
// lines); at each, text stacks right of symbols, then below the symbols of
// lanes, then below every symbol. Each rung is laid out in both orientations,
// and the first rung with an attempt that verifies, keeps within the crossing
// limit and fits the box wins; within it, fewer crossings, then the better
// fit. Without one, the result says why: density (crossings, when every
// attempt crosses too often, verified or not), the smallest size per
// orientation, or the verifier's findings. Nothing is truncated silently.
import { runAttempt, prepare, type AttemptGeometry, type Detail, type TextPolicy } from './attempt.ts'
import { breakCycles } from './cycles.ts'
import { findCrossings, drawingSegments, gapsByEdge } from './crossings.ts'
import type { DiagramGraph, DiagramLayoutResult, DiagramProfile, DiagramViolation, RoutedEdge } from './diagram.ts'
import { ORIENTATIONS } from './geometry.ts'
import { geometryHash } from './hash.ts'
import { assignLayers } from './layering.ts'
import { buildModel, validateProfile, type Model } from './model.ts'
import { orderLayers } from './ordering.ts'
import { keptLines } from './shapes.ts'
import { analyseStructure } from './structure.ts'
import { verifyLayout } from './verify.ts'

export * from './diagram.ts'

type Reason = Extract<DiagramLayoutResult, { ok: false }>['reasons'][number]

interface Judged {
  readonly geometry: AttemptGeometry
  readonly edges: ReadonlyArray<RoutedEdge>
  readonly crossings: number
  readonly violations: ReadonlyArray<DiagramViolation>
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

const judge = (model: Model, net: ReadonlyArray<number>, profile: DiagramProfile, geometry: AttemptGeometry): Judged => {
  const bare: RoutedEdge[] = model.edges.map((edge, e) => ({ id: edge.id, points: geometry.paths[e]!, gaps: [] }))
  const crossings = findCrossings(drawingSegments(model, net, geometry.nodes, bare))
  const gaps = gapsByEdge(model.edges.length, crossings, bare)
  const edges = bare.map((edge, e) => ({ ...edge, gaps: gaps[e]! }))
  const violations = verifyLayout({ model, net, profile, width: geometry.width, height: geometry.height, nodes: geometry.nodes, edges })
  return { geometry, edges, crossings: crossings.length, violations, fits: geometry.width <= profile.maxWidth && geometry.height <= profile.maxHeight }
}

const overflow = (profile: DiagramProfile, judged: Judged): number => Math.max(judged.geometry.width / profile.maxWidth, judged.geometry.height / profile.maxHeight)

export const layoutDiagram = (graph: DiagramGraph, profile: DiagramProfile): DiagramLayoutResult => {
  validateProfile(profile)
  const model = buildModel(graph)
  const density = densityReasons(model, profile)
  if (density.length > 0) return { ok: false, reasons: density }

  const structure = analyseStructure(model)
  const layering = assignLayers(model, structure, breakCycles(model))
  const prepared = prepare(model, structure, layering, orderLayers(model, layering))
  const details: Detail[] = model.nodes.some(node => keptLines(node, 'required') < node.lines.length) ? ['full', 'required'] : ['full']
  const policies: TextPolicy[] = model.lanes.length > 0 ? ['right', 'lanesBelow', 'allBelow'] : ['right', 'allBelow']
  const rungs = details.flatMap(detail => policies.map(policy => ({ detail, policy })))
  const acceptable = (judged: Judged): boolean => judged.violations.length === 0 && judged.crossings <= profile.limits.crossings && judged.fits
  const attempts: Judged[] = []
  for (const { detail, policy } of rungs) {
    const round = ORIENTATIONS.map(orientation => judge(model, structure.net, profile, runAttempt(prepared, profile, orientation, detail, policy)))
    attempts.push(...round)
    const best = round
      .filter(acceptable)
      .sort((a, b) => (a.crossings - b.crossings) || (overflow(profile, a) - overflow(profile, b)))[0]
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
    }
  }

  // Too many crossings in every attempt, verified or not, is the reason to
  // give: no drawing of this graph would be accepted whatever else is wrong.
  const verified = attempts.filter(judged => judged.violations.length === 0)
  const fewestCrossings = Math.min(...(verified.length > 0 ? verified : attempts).map(judged => judged.crossings))
  if (fewestCrossings > profile.limits.crossings) {
    return { ok: false, reasons: [{ kind: 'density', limit: 'crossings', count: fewestCrossings, max: profile.limits.crossings }] }
  }
  if (verified.length === 0) {
    const fewest = [...attempts].sort((a, b) => a.violations.length - b.violations.length)[0]!
    return { ok: false, reasons: [{ kind: 'unverifiable', violations: fewest.violations }] }
  }
  const withinCrossings = verified.filter(judged => judged.crossings <= profile.limits.crossings)
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
