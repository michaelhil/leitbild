import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color.pure'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import type { Scene } from '@babylonjs/core/scene'
import type { DroneWorldCenter } from './drone-map-world.ts'
import { roadTileUrlFromModelUrl, type DroneRoadSurfaceMeshData } from './drone-road-overlay-geometry.ts'
import type { RoadOverlayWorkerBuildRequest, RoadOverlayWorkerBuildResponse } from './drone-road-overlay-worker-protocol.ts'

interface RoadTileRuntimeEntry {
  readonly key: string
  readonly controller: AbortController
  meshes: Mesh[]
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

interface RoadMeshUploadJob {
  readonly entry: RoadTileRuntimeEntry
  readonly surfaces: ReadonlyArray<DroneRoadSurfaceMeshData>
  nextSurfaceIndex: number
}

const roadMeshUploadBudgetMs = 2.5
const roadMeshUploadSurfaceLimitPerFrame = 2

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
        worker.postMessage({ type: 'cancel', id })
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
  material.freeze()
  return material
}

const createRoadMesh = (
  scene: Scene,
  surface: DroneRoadSurfaceMeshData,
  material: StandardMaterial,
): Mesh => {
  const mesh = new Mesh(`drone-road-surface:${surface.key}`, scene)
  const vertexData = new VertexData()
  vertexData.positions = surface.positions
  vertexData.normals = surface.normals
  vertexData.indices = surface.indices
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

export const createDroneRoadOverlayRenderer = (config: {
  readonly scene: Scene
  readonly center: DroneWorldCenter
  readonly roadTileTemplate: string
  readonly onError?: (message: string) => void
}): DroneRoadOverlayRenderer => {
  if (typeof requestAnimationFrame === 'undefined') throw new Error('road overlay mesh upload scheduler is unavailable')
  const entries = new Map<string, RoadTileRuntimeEntry>()
  const materials = new Map<string, StandardMaterial>()
  const uploadJobs: RoadMeshUploadJob[] = []
  const geometryWorker = createRoadOverlayGeometryWorker()
  let disposed = false
  let uploadFrameId: number | null = null

  const materialFor = (surface: DroneRoadSurfaceMeshData): StandardMaterial => {
    const key = `${surface.materialKey}:${surface.colorHex}`
    const material = materials.get(key) ?? createRoadMaterial(config.scene, surface)
    if (!materials.has(key)) materials.set(key, material)
    return material
  }

  const scheduleUploadFrame = (): void => {
    if (disposed || uploadFrameId !== null) return
    uploadFrameId = requestAnimationFrame(flushUploadJobs)
  }

  const removeUploadJobsForEntry = (entry: RoadTileRuntimeEntry): void => {
    for (let index = uploadJobs.length - 1; index >= 0; index -= 1) {
      if (uploadJobs[index]?.entry === entry) uploadJobs.splice(index, 1)
    }
  }

  const flushUploadJobs = (): void => {
    uploadFrameId = null
    if (disposed) return
    const startedAtMs = performance.now()
    let uploadedSurfaces = 0
    while (uploadJobs.length > 0) {
      const job = uploadJobs[0]
      if (!job) break
      if (job.entry.controller.signal.aborted || !entries.has(job.entry.key)) {
        uploadJobs.shift()
        continue
      }
      const surface = job.surfaces[job.nextSurfaceIndex]
      if (!surface) {
        job.entry.loaded = true
        uploadJobs.shift()
        continue
      }
      const mesh = createRoadMesh(config.scene, surface, materialFor(surface))
      job.entry.meshes.push(mesh)
      job.entry.triangleCount += surface.triangleCount
      job.entry.byteLength += roadSurfaceByteLength(surface)
      job.nextSurfaceIndex += 1
      uploadedSurfaces += 1
      if (
        uploadedSurfaces >= roadMeshUploadSurfaceLimitPerFrame
        || performance.now() - startedAtMs >= roadMeshUploadBudgetMs
      ) break
    }
    if (uploadJobs.length > 0) scheduleUploadFrame()
  }

  const disposeEntry = (entry: RoadTileRuntimeEntry): void => {
    entry.controller.abort()
    removeUploadJobsForEntry(entry)
    for (const mesh of entry.meshes) mesh.dispose(false, true)
    entries.delete(entry.key)
  }

  const loadEntry = async (
    entry: RoadTileRuntimeEntry,
    roadTileUrl: string,
  ): Promise<void> => {
    try {
      if (entry.controller.signal.aborted || !entries.has(entry.key)) return
      const surfaces = await geometryWorker.build({ type: 'build', roadTileUrl, center: config.center }, entry.controller.signal)
      if (entry.controller.signal.aborted || !entries.has(entry.key)) return
      if (surfaces.length === 0) {
        entries.delete(entry.key)
        return
      }
      uploadJobs.push({ entry, surfaces, nextSurfaceIndex: 0 })
      scheduleUploadFrame()
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
      disposed = true
      if (uploadFrameId !== null) cancelAnimationFrame(uploadFrameId)
      uploadFrameId = null
      geometryWorker.dispose()
      for (const entry of [...entries.values()]) disposeEntry(entry)
      for (const material of materials.values()) material.dispose(false, true)
      materials.clear()
      uploadJobs.splice(0, uploadJobs.length)
    },
  }
}
