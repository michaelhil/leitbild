import type { OperationalObject, StartingMapView } from '../core/model/index.ts'
import type { MapFocusTarget } from './map-view.ts'

/** Exact authored camera view; the map applies its current observed padding. */
export const homeMapTarget = (view: StartingMapView): MapFocusTarget => ({ kind: 'view', center: [view.center.coordinates[0], view.center.coordinates[1]], zoom: view.zoom, bearing: 0, fitToAvailableArea: true })

/** Fit only available point positions. Absent positions are not guessed from labels. */
export const fitObjectsTarget = (objects: ReadonlyArray<Pick<OperationalObject, 'spatial'>>): MapFocusTarget | null => {
  let count = 0, west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
  for (const object of objects) {
    const point = object.spatial.position?.point.coordinates
    if (!point) continue
    count++
    west = Math.min(west, point[0]); east = Math.max(east, point[0])
    south = Math.min(south, point[1]); north = Math.max(north, point[1])
  }
  if (count === 0) return null
  if (count === 1) return { kind: 'point', center: [west, south] }
  return { kind: 'bounds', bounds: [[west, south], [east, north]] }
}

export interface RunViewChoice {
  readonly id: string
  readonly label: string
  readonly visible: boolean
  readonly disabledReason?: string
}
