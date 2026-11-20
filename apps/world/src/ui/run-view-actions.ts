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

export type RunCameraActionId = 'home' | 'fit-visible' | 'fit-selected'

export interface RunCameraButton {
  readonly id: RunCameraActionId
  /** Names the button's target: its accessible name and hover text. */
  readonly label: string
  /** Why a press does nothing now; null when it acts. */
  readonly disabledReason: string | null
}

/**
 * The map's camera buttons, in row order. Home and Fit all visible are always
 * in reach; Fit selection is present only while an object with a map position
 * is selected.
 */
export const runCameraButtons = (input: { readonly visiblePositions: boolean; readonly selectionOnMap: boolean }): ReadonlyArray<RunCameraButton> => [
  { id: 'home', label: 'Home: the scenario\u2019s starting view', disabledReason: null },
  { id: 'fit-visible', label: 'Fit everything visible', disabledReason: input.visiblePositions ? null : 'No visible object positions' },
  ...(input.selectionOnMap ? [{ id: 'fit-selected' as const, label: 'Fit the selected object', disabledReason: null }] : []),
]
