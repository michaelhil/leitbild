import type { OperationalObject } from '../../core/model/index.ts'
import type { DroneMotionFrame } from '../../packs/drone/realtime.ts'
import type { DroneScenePerformanceSnapshot } from './drone-performance.ts'

export type DroneSceneViewMode = '3d' | '2d' | 'fpv'

export interface DroneSceneHandle {
  readonly ingestMotionFrames: (frames: ReadonlyArray<DroneMotionFrame>) => void
  readonly destroy: () => void
}

export interface DroneSceneCameraOrbit {
  readonly yawOffsetRad: number
  readonly pitchOffsetRad: number
  readonly distanceM: number
}

export interface DroneSceneConfig {
  readonly container: HTMLElement
  readonly getFocusDroneId: () => string
  readonly getObjects: () => ReadonlyArray<OperationalObject>
  readonly getViewMode: () => DroneSceneViewMode
  readonly getCameraOrbit: () => DroneSceneCameraOrbit
  readonly onReady?: () => void
  readonly onError?: (message: string) => void
  readonly onWorldStatus?: (message: string) => void
  readonly onPerformance?: (snapshot: DroneScenePerformanceSnapshot) => void
}
