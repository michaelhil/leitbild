import { sceneryRoadTileSchema, type SceneryRoadTile } from '../../map/scenery.ts'
import { buildRoadSurfaceMeshes } from './drone-road-overlay-geometry.ts'
import type {
  RoadOverlayWorkerBuildFailure,
  RoadOverlayWorkerBuildRequest,
  RoadOverlayWorkerBuildSuccess,
  RoadOverlayWorkerRequest,
} from './drone-road-overlay-worker-protocol.ts'

interface WorkerRuntimeScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage: (message: RoadOverlayWorkerBuildSuccess | RoadOverlayWorkerBuildFailure, transfer?: Transferable[]) => void
}

const workerScope = globalThis as unknown as WorkerRuntimeScope

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseWorkerRequest = (value: unknown): RoadOverlayWorkerRequest | null => {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'number') return null
  if (value.type === 'cancel') return { type: 'cancel', id: value.id }
  if (value.type === 'build' && typeof value.roadTileUrl === 'string' && value.roadTileUrl.length > 0) {
    return value as unknown as RoadOverlayWorkerBuildRequest
  }
  return null
}

const abortControllers = new Map<number, AbortController>()

const fetchRoadTile = async (
  url: string,
  signal: AbortSignal,
): Promise<SceneryRoadTile> => {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`road overlay tile query failed with HTTP ${response.status}`)
  const parsed = sceneryRoadTileSchema.safeParse(await response.json())
  if (!parsed.success) throw new Error(`road overlay tile failed schema validation: ${parsed.error.message}`)
  return parsed.data
}

const transferableSurfaces = (
  surfaces: ReadonlyArray<ReturnType<typeof buildRoadSurfaceMeshes>[number]>,
): {
  readonly surfaces: RoadOverlayWorkerBuildSuccess['surfaces']
  readonly transfer: Transferable[]
} => {
  const transfer: Transferable[] = []
  const typedSurfaces = surfaces.map(surface => {
    const positions = new Float32Array(surface.positions)
    const normals = new Float32Array(surface.normals)
    const indices = new Uint32Array(surface.indices)
    transfer.push(positions.buffer, normals.buffer, indices.buffer)
    return {
      key: surface.key,
      materialKey: surface.materialKey,
      colorHex: surface.colorHex,
      y: surface.y,
      positions,
      normals,
      indices,
      triangleCount: surface.triangleCount,
    }
  })
  return { surfaces: typedSurfaces, transfer }
}

const handleBuildRequest = async (
  request: RoadOverlayWorkerBuildRequest,
): Promise<void> => {
  const controller = new AbortController()
  abortControllers.set(request.id, controller)
  try {
    const tile = await fetchRoadTile(request.roadTileUrl, controller.signal)
    if (controller.signal.aborted) return
    const builtSurfaces = buildRoadSurfaceMeshes(request.center
      ? { tile, center: request.center }
      : { tile })
    if (controller.signal.aborted) return
    const { surfaces, transfer } = transferableSurfaces(builtSurfaces)
    workerScope.postMessage({ type: 'built', id: request.id, surfaces }, transfer)
  } catch (error) {
    if (controller.signal.aborted) return
    workerScope.postMessage({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    abortControllers.delete(request.id)
  }
}

workerScope.onmessage = (event: MessageEvent<unknown>): void => {
  const request = parseWorkerRequest(event.data)
  if (!request) return
  if (request.type === 'cancel') {
    abortControllers.get(request.id)?.abort()
    abortControllers.delete(request.id)
    return
  }
  void handleBuildRequest(request)
}

export {}
