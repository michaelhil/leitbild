import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color.pure'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import type { Scene } from '@babylonjs/core/scene'
import { sceneryRoadTileSchema, type SceneryRoadTile } from '../../map/scenery.ts'
import type { DroneWorldCenter } from './drone-map-world.ts'
import { roadTileUrlFromModelUrl, type DroneRoadSurfaceMeshData } from './drone-road-overlay-geometry.ts'
import type { RoadOverlayWorkerBuildRequest, RoadOverlayWorkerBuildResponse } from './drone-road-overlay-worker-protocol.ts'

interface RoadTileRuntimeEntry {
  readonly key: string
  readonly controller: AbortController
  meshes: Mesh[]
  materials: StandardMaterial[]
  triangleCount: number
  byteLength: number
  loaded: boolean
}

export interface DroneRoadOverlayMetrics {
  readonly loadedRoadTiles: number
  readonly pendingRoadTiles: number
  readonly roadMeshTriangles: number
  readonly roadMeshBytes: number
}

export interface DroneRoadOverlayRenderer {
  readonly attachTileForModelUrl: (modelUrl: string) => void
  readonly disposeTileForModelUrl: (modelUrl: string) => void
  readonly metrics: () => DroneRoadOverlayMetrics
  readonly dispose: () => void
}

interface PendingRoadOverlayWorkerBuild {
  readonly resolve: (surfaces: ReadonlyArray<DroneRoadSurfaceMeshData>) => void
  readonly reject: (error: unknown) => void
  readonly release: () => void
}

interface RoadOverlayGeometryWorker {
  readonly build: (config: Omit<RoadOverlayWorkerBuildRequest, 'id'>, signal: AbortSignal) => Promise<ReadonlyArray<DroneRoadSurfaceMeshData>>
  readonly dispose: () => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseWorkerBuildResponse = (value: unknown): RoadOverlayWorkerBuildResponse | null => {
  if (!isRecord(value) || typeof value.id !== 'number') return null
  if (value.type === 'built' && Array.isArray(value.surfaces)) {
    return { type: 'built', id: value.id, surfaces: value.surfaces as ReadonlyArray<DroneRoadSurfaceMeshData> }
  }
  if (value.type === 'error' && typeof value.message === 'string') {
    return { type: 'error', id: value.id, message: value.message }
  }
  return null
}

const createRoadOverlayGeometryWorker = (): RoadOverlayGeometryWorker => {
  if (typeof Worker === 'undefined') throw new Error('road overlay geometry worker is unavailable')
  const worker = new Worker(new URL('./drone-road-overlay-worker.ts', import.meta.url), {
    type: 'module',
    name: 'leitbild-road-overlay-geometry',
  })
  const pending = new Map<number, PendingRoadOverlayWorkerBuild>()
  let disposed = false
  let sequence = 0

  const rejectPending = (error: unknown): void => {
    for (const [id, build] of pending) {
      build.release()
      build.reject(error)
      pending.delete(id)
    }
  }

  worker.onmessage = (event: MessageEvent<unknown>): void => {
    const message = parseWorkerBuildResponse(event.data)
    if (!message) return
    const build = pending.get(message.id)
    if (!build) return
    pending.delete(message.id)
    build.release()
    if (message.type === 'built') build.resolve(message.surfaces)
    else build.reject(new Error(message.message))
  }
  worker.onerror = (event): void => {
    rejectPending(new Error('road overlay geometry worker failed: ' + event.message))
  }

  const build = async (config: Omit<RoadOverlayWorkerBuildRequest, 'id'>, signal: AbortSignal): Promise<ReadonlyArray<DroneRoadSurfaceMeshData>> =>
    await new Promise<ReadonlyArray<DroneRoadSurfaceMeshData>>((resolve, reject): void => {
      if (disposed) {
        reject(new Error('road overlay geometry worker was disposed'))
        return
      }
      if (signal.aborted) {
        reject(new Error('road overlay geometry build was aborted'))
        return
      }
      const id = ++sequence
      const onAbort = (): void => {
        const build = pending.get(id)
        if (!build) return
        pending.delete(id)
        build.release()
        build.reject(new Error('road overlay geometry build was aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      pending.set(id, {
        resolve,
        reject,
        release: () => signal.removeEventListener('abort', onAbort),
      })
      worker.postMessage({ ...config, id })
    })

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    rejectPending(new Error('road overlay geometry worker was disposed'))
    worker.terminate()
  }

  return { build, dispose }
}

const createRoadMaterial = (
  scene: Scene,
  surface: DroneRoadSurfaceMeshData,
): StandardMaterial => {
  const material = new StandardMaterial(`drone-${surface.materialKey}`, scene)
  const color = Color3.FromHexString(surface.colorHex)
  material.diffuseColor = color
  material.ambientColor = color.scale(0.28)
  material.specularColor = new Color3(0.04, 0.04, 0.04)
  material.backFaceCulling = false
  material.alpha = 1
  return material
}

const createRoadMesh = (
  scene: Scene,
  surface: DroneRoadSurfaceMeshData,
  material: StandardMaterial,
): Mesh => {
  const mesh = new Mesh(`drone-road-surface:${surface.key}`, scene)
  const vertexData = new VertexData()
  vertexData.positions = [...surface.positions]
  vertexData.normals = [...surface.normals]
  vertexData.indices = [...surface.indices]
  vertexData.applyToMesh(mesh)
  mesh.material = material
  mesh.isPickable = false
  mesh.freezeWorldMatrix()
  return mesh
}

const roadSurfaceByteLength = (
  surface: DroneRoadSurfaceMeshData,
): number =>
  (surface.positions.length + surface.normals.length + surface.indices.length) * 4

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

export const createDroneRoadOverlayRenderer = (config: {
  readonly scene: Scene
  readonly center: DroneWorldCenter
  readonly roadTileTemplate: string
  readonly onError?: (message: string) => void
}): DroneRoadOverlayRenderer => {
  const entries = new Map<string, RoadTileRuntimeEntry>()
  const geometryWorker = createRoadOverlayGeometryWorker()

  const disposeEntry = (entry: RoadTileRuntimeEntry): void => {
    entry.controller.abort()
    for (const mesh of entry.meshes) mesh.dispose(false, true)
    for (const material of entry.materials) material.dispose(false, true)
    entries.delete(entry.key)
  }

  const loadEntry = async (
    entry: RoadTileRuntimeEntry,
    roadTileUrl: string,
  ): Promise<void> => {
    try {
      const tile = await fetchRoadTile(roadTileUrl, entry.controller.signal)
      if (entry.controller.signal.aborted || !entries.has(entry.key)) return
      const surfaces = await geometryWorker.build({ type: 'build', tile, center: config.center }, entry.controller.signal)
      if (surfaces.length === 0) {
        entries.delete(entry.key)
        return
      }
      for (const surface of surfaces) {
        const material = createRoadMaterial(config.scene, surface)
        const mesh = createRoadMesh(config.scene, surface, material)
        entry.materials.push(material)
        entry.meshes.push(mesh)
        entry.triangleCount += surface.triangleCount
        entry.byteLength += roadSurfaceByteLength(surface)
      }
      entry.loaded = true
    } catch (error) {
      if (entry.controller.signal.aborted) return
      config.onError?.(error instanceof Error ? error.message : String(error))
      disposeEntry(entry)
    }
  }

  return {
    attachTileForModelUrl: (modelUrl: string): void => {
      const roadTileUrl = roadTileUrlFromModelUrl(modelUrl, config.roadTileTemplate)
      if (!roadTileUrl || entries.has(roadTileUrl)) return
      const entry: RoadTileRuntimeEntry = {
        key: roadTileUrl,
        controller: new AbortController(),
        meshes: [],
        materials: [],
        triangleCount: 0,
        byteLength: 0,
        loaded: false,
      }
      entries.set(roadTileUrl, entry)
      void loadEntry(entry, roadTileUrl)
    },
    disposeTileForModelUrl: (modelUrl: string): void => {
      const roadTileUrl = roadTileUrlFromModelUrl(modelUrl, config.roadTileTemplate)
      if (!roadTileUrl) return
      const entry = entries.get(roadTileUrl)
      if (entry) disposeEntry(entry)
    },
    metrics: (): DroneRoadOverlayMetrics => ({
      loadedRoadTiles: [...entries.values()].filter(entry => entry.loaded).length,
      pendingRoadTiles: [...entries.values()].filter(entry => !entry.loaded).length,
      roadMeshTriangles: [...entries.values()].reduce((sum, entry) => sum + entry.triangleCount, 0),
      roadMeshBytes: [...entries.values()].reduce((sum, entry) => sum + entry.byteLength, 0),
    }),
    dispose: (): void => {
      geometryWorker.dispose()
      for (const entry of [...entries.values()]) disposeEntry(entry)
    },
  }
}
