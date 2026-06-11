import { buildRoadSurfaceMeshes } from './drone-road-overlay-geometry.ts'
import type { RoadOverlayWorkerBuildFailure, RoadOverlayWorkerBuildRequest, RoadOverlayWorkerBuildSuccess } from './drone-road-overlay-worker-protocol.ts'

interface WorkerRuntimeScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage: (message: RoadOverlayWorkerBuildSuccess | RoadOverlayWorkerBuildFailure) => void
}

const workerScope = globalThis as unknown as WorkerRuntimeScope

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseBuildRequest = (value: unknown): RoadOverlayWorkerBuildRequest | null => {
  if (!isRecord(value)) return null
  if (value.type !== 'build') return null
  if (typeof value.id !== 'number') return null
  if (!isRecord(value.tile)) return null
  return value as unknown as RoadOverlayWorkerBuildRequest
}

workerScope.onmessage = (event: MessageEvent<unknown>): void => {
  const request = parseBuildRequest(event.data)
  if (!request) return
  try {
    const surfaces = buildRoadSurfaceMeshes(request.center
      ? { tile: request.tile, center: request.center }
      : { tile: request.tile })
    workerScope.postMessage({ type: 'built', id: request.id, surfaces })
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export {}
