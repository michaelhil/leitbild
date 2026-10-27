import earcut from 'earcut'
import type { RenderObject } from '../explorer/architecture.ts'
import { elementWorld, type Source, type Element, type V3 } from '../architecture/source.ts'

export interface Foundation {
  readonly offset: readonly [number, number]
  readonly length: number
  readonly width: number
  readonly height: number
  /** Openings are relative to the foundation origin, not the equipment envelope. */
  readonly holes?: ReadonlyArray<{ readonly x: number; readonly y: number; readonly length: number; readonly width: number }>
}
type FoundationElement = Element & { readonly foundation?: Foundation }
type Point = readonly [number, number]
const edgeKey = (a: readonly number[], b: readonly number[]): string => [a.join(','), b.join(',')].sort().join('|')

/** Replace a recipe's embedded foundation with the explicit source occurrence
 * foundation. The casing, ribs, bolts, bearings and material hierarchy survive
 * byte for byte; foundations own real through-apertures, not painted holes. */
export const foundationSolid = (source: Source, element: FoundationElement, prior: RenderObject): RenderObject => {
  const foundation = element.foundation
  if (!foundation) return prior
  const positions: number[] = [], normals: number[] = [], materialIndices: number[] = [], linePositions: number[] = [], removedEdges = new Set<string>(), materials = [...prior.materials]
  let plinth = materials.indexOf('plinth')
  if (plinth < 0) throw Error(`Explicit foundation requires a recipe with a distinct foundation part: ${element.id}`)
  let removed = false
  for (let at = 0; at < prior.positions.length; at += 9) {
    const indices = [at / 3, at / 3 + 1, at / 3 + 2]
    const foundationFace = indices.map(index => prior.materialIndices[index] === plinth)
    if (foundationFace.some(Boolean) && !foundationFace.every(Boolean)) throw Error(`Foundation face has mixed semantic materials: ${element.id}`)
    if (foundationFace.every(Boolean)) {
      removed = true
      for (let edge = 0; edge < 3; edge++) removedEdges.add(edgeKey(prior.positions.slice(at + edge * 3, at + edge * 3 + 3), prior.positions.slice(at + (edge + 1) % 3 * 3, at + (edge + 1) % 3 * 3 + 3)))
    } else {
      positions.push(...prior.positions.slice(at, at + 9)); normals.push(...prior.normals.slice(at, at + 9)); materialIndices.push(...indices.map(index => prior.materialIndices[index]!))
    }
  }
  if (!removed) throw Error(`An explicit foundation cannot replace an unclassified recipe base: ${element.id}`)
  for (let at = 0; at < prior.linePositions.length; at += 6) if (!removedEdges.has(edgeKey(prior.linePositions.slice(at, at + 3), prior.linePositions.slice(at + 3, at + 6)))) linePositions.push(...prior.linePositions.slice(at, at + 6))
  const pose = elementWorld(source, element), c = Math.cos(pose.yaw), s = Math.sin(pose.yaw)
  const point = ([x, y]: Point, z: number): V3 => {
    x += foundation.offset[0]; y += foundation.offset[1]
    return [pose.position[0] + c * x - s * y, pose.position[1] + s * x + c * y, pose.position[2] + z]
  }
  const triangle = (a: V3, b: V3, d: V3, normal: V3): void => {
    positions.push(...a, ...b, ...d)
    const worldNormal = [c * normal[0] - s * normal[1], s * normal[0] + c * normal[1], normal[2]]
    for (let corner = 0; corner < 3; corner++) { normals.push(...worldNormal); materialIndices.push(plinth) }
  }
  const rings: ReadonlyArray<ReadonlyArray<Point>> = [
    [[0, 0], [foundation.length, 0], [foundation.length, foundation.width], [0, foundation.width]],
    ...(foundation.holes ?? []).map(hole => [[hole.x, hole.y], [hole.x + hole.length, hole.y], [hole.x + hole.length, hole.y + hole.width], [hole.x, hole.y + hole.width]] as Point[]),
  ]
  const flat = rings.flat(), holes: number[] = []
  let cursor = rings[0]!.length
  for (const ring of rings.slice(1)) { holes.push(cursor); cursor += ring.length }
  const indices = earcut(flat.flat(), holes, 2)
  for (let at = 0; at < indices.length; at += 3) {
    const [a, b, d] = indices.slice(at, at + 3).map(index => flat[index]!) as [Point, Point, Point]
    triangle(point(d, 0), point(b, 0), point(a, 0), [0, 0, -1])
    triangle(point(a, foundation.height), point(b, foundation.height), point(d, foundation.height), [0, 0, 1])
  }
  rings.forEach((ring, ringIndex) => {
    for (let at = 0; at < ring.length; at++) {
      const a = ring[at]!, b = ring[(at + 1) % ring.length]!, dx = b[0] - a[0], dy = b[1] - a[1], distance = Math.hypot(dx, dy), sign = ringIndex === 0 ? 1 : -1, normal: V3 = [sign * dy / distance, -sign * dx / distance, 0]
      const lowA = point(a, 0), lowB = point(b, 0), highA = point(a, foundation.height), highB = point(b, foundation.height)
      if (ringIndex === 0) { triangle(lowA, lowB, highB, normal); triangle(lowA, highB, highA, normal) }
      else { triangle(lowA, highB, lowB, normal); triangle(lowA, highA, highB, normal) }
      linePositions.push(...lowA, ...lowB, ...highA, ...highB, ...lowA, ...highA)
    }
  })
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity]
  for (let at = 0; at < positions.length; at++) { const axis = at % 3; min[axis] = Math.min(min[axis]!, positions[at]!); max[axis] = Math.max(max[axis]!, positions[at]!) }
  return { ...prior, positions, normals, materialIndices, linePositions, materials, bounds: { min, max } }
}
