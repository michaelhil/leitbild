import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import { boundsCorners, type Vector3 } from './math.ts'

export const overlapsPhysicalFootprint = (bounds: PhysicalSceneBounds, footprint: PhysicalSceneBounds | null): boolean => footprint === null || bounds.max[0] >= footprint.min[0] && bounds.min[0] <= footprint.max[0] && bounds.max[1] >= footprint.min[1] && bounds.min[1] <= footprint.max[1]

/** A public ground footprint bounds all downward camera rays. Height planes
 * below the eye are affine sections of that ray pyramid; eye/horizon crossing
 * is deliberately retained when a finite footprint cannot establish exclusion. */
export const physicalHeightFootprint = (ground: PhysicalSceneBounds, eye: Vector3, low: number, high: number): PhysicalSceneBounds | null => {
  if (![...ground.min, ...ground.max, ...eye, low, high].every(Number.isFinite) || !(eye[2] > 0) || high >= eye[2]) return null
  const points = [low, high].flatMap(z => {
    const fraction = 1 - z / eye[2]
    return [[ground.min[0], ground.min[1]], [ground.max[0], ground.max[1]]].map(([x, y]) => [eye[0] + fraction * (x! - eye[0]), eye[1] + fraction * (y! - eye[1])])
  })
  return { min: [Math.min(...points.map(point => point[0]!)), Math.min(...points.map(point => point[1]!)), low], max: [Math.max(...points.map(point => point[0]!)), Math.max(...points.map(point => point[1]!)), high] }
}

/** Conservative homogeneous frustum test, including camera-inside and tall boxes. */
export const intersectsPhysicalFrustum = (matrix: ArrayLike<number>, bounds: PhysicalSceneBounds): boolean => {
  const corners = boundsCorners(bounds).map(point => [0, 1, 2, 3].map(row => matrix[row]! * point[0] + matrix[row + 4]! * point[1] + matrix[row + 8]! * point[2] + matrix[row + 12]!))
  if (corners.some(point => !point.every(Number.isFinite))) return true
  for (const [axis, sign] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]] as const) {
    // Eight ulps bound the four products/additions used by a clip-plane test.
    if (corners.every(point => point[3]! + sign * point[axis]! < -Number.EPSILON * 8 * Math.max(1, Math.abs(point[3]!), Math.abs(point[axis]!)))) return false
  }
  return true
}
