import type { SceneryRoadTile } from '../../map/scenery.ts'
import type { DroneWorldCenter } from './drone-map-world.ts'
import type { DroneRoadSurfaceMeshData } from './drone-road-overlay-geometry.ts'

export interface RoadOverlayWorkerBuildRequest {
  readonly type: 'build'
  readonly id: number
  readonly tile: SceneryRoadTile
  readonly center?: DroneWorldCenter
}

export interface RoadOverlayWorkerBuildSuccess {
  readonly type: 'built'
  readonly id: number
  readonly surfaces: ReadonlyArray<DroneRoadSurfaceMeshData>
}

export interface RoadOverlayWorkerBuildFailure {
  readonly type: 'error'
  readonly id: number
  readonly message: string
}

export type RoadOverlayWorkerBuildResponse = RoadOverlayWorkerBuildSuccess | RoadOverlayWorkerBuildFailure
