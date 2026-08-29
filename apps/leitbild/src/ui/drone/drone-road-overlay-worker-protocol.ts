import type { DroneWorldCenter } from './drone-map-world.ts'
import type { DroneRoadSurfaceMeshData } from './drone-road-overlay-geometry.ts'

export interface RoadOverlayWorkerBuildRequest {
  readonly type: 'build'
  readonly id: number
  readonly roadTileUrl: string
  readonly center?: DroneWorldCenter
}

export interface RoadOverlayWorkerCancelRequest {
  readonly type: 'cancel'
  readonly id: number
}

export type RoadOverlayWorkerRequest = RoadOverlayWorkerBuildRequest | RoadOverlayWorkerCancelRequest

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
