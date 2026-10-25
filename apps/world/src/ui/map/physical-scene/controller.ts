import { MercatorCoordinate } from 'maplibre-gl'
import { createMapPhysicalViewport } from './map-viewport.ts'
import { createPhysicalSceneControllerForViewport } from './scene-controller.ts'
import { boundsCorners, localMercatorMatrix, transform } from './math.ts'
import type { PhysicalSceneControllerOptions, PhysicalSceneDescriptor } from './types.ts'

export const physicalSceneExtent = (descriptor: PhysicalSceneDescriptor, project: (point: { lng: number; lat: number }) => { x: number; y: number }, width: number, height: number) => {
  const matrix = localMercatorMatrix(descriptor.anchor, descriptor.bearing), points = boundsCorners(descriptor.bounds).map(point => { const p = transform(matrix, point); return project(new MercatorCoordinate(p[0], p[1]).toLngLat()) }), xs = points.map(p => p.x), ys = points.map(p => p.y)
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys)
  return { pixels: Math.max(right - left, bottom - top), intersects: right >= 0 && left <= width && bottom >= 0 && top <= height, distance: Math.hypot((left + right - width) / 2, (top + bottom - height) / 2) }
}
/** Explicit display-quality policy. Object/scene counts are never admission criteria. */
export const detailEligible = (projectedError: number, intersects: boolean, _wasEligible: boolean, targetPixelError = 1): boolean => intersects && projectedError > targetPixelError
export const createPhysicalSceneController = (options: PhysicalSceneControllerOptions) => createPhysicalSceneControllerForViewport(createMapPhysicalViewport(options.map, options.beforeId), options)
export type PhysicalSceneController = ReturnType<typeof createPhysicalSceneControllerForViewport>
