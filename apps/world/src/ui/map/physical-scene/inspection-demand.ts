import { MercatorCoordinate } from 'maplibre-gl'
import type { PackPhysicalSceneDescriptor } from '../../../core/packs/scene.ts'
import { localMercatorMatrix, transform, type Vector3 } from './math.ts'

/** The smallest projected planar scale, independent of an access opening's orientation. */
export const projectedInspectionFeature = (descriptor: PackPhysicalSceneDescriptor, project: (point: { lng: number; lat: number }) => { x: number; y: number }): number => {
  const feature = descriptor.inspectionFeatureMetres
  if (feature === undefined) return 0
  if (!(feature > 0) || !Number.isFinite(feature)) throw new Error('Physical inspection feature must be a finite positive length')
  const center: Vector3 = [(descriptor.bounds.min[0] + descriptor.bounds.max[0]) / 2, (descriptor.bounds.min[1] + descriptor.bounds.max[1]) / 2, 0]
  const matrix = localMercatorMatrix(descriptor.anchor, descriptor.bearing)
  const points = [center, [center[0] + feature, center[1], 0] as Vector3, [center[0], center[1] + feature, 0] as Vector3].map(point => {
    const world = transform(matrix, point); return project(new MercatorCoordinate(world[0], world[1]).toLngLat())
  })
  const x = [points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y], y = [points[2]!.x - points[0]!.x, points[2]!.y - points[0]!.y]
  const a = x[0]! ** 2 + x[1]! ** 2, b = x[0]! * y[0]! + x[1]! * y[1]!, c = y[0]! ** 2 + y[1]! ** 2
  const largest = Math.sqrt((a + c + Math.hypot(a - c, 2 * b)) / 2), determinant = Math.abs(x[0]! * y[1]! - x[1]! * y[0]!)
  return largest > 0 && Number.isFinite(largest) ? determinant / largest : 0
}

/** Inspection legibility is a task gate; geometric approximation error is separate. */
export const automaticInspectionDemand = (inspectionPixels: number, overviewErrorPixels: number, targetPixelError: number): boolean => inspectionPixels >= targetPixelError && overviewErrorPixels > targetPixelError
