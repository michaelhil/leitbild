import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Material } from '@babylonjs/core/Materials/material'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { Color3 } from '@babylonjs/core/Maths/math.color.pure'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.pure'
import type { ICanvasRenderingContext } from '@babylonjs/core/Engines/ICanvas'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import type { Scene } from '@babylonjs/core/scene'
import {
  sceneryRoadTileSchema,
  type SceneryRoadFeature,
  type SceneryRoadTile,
  type SceneryTileCoord,
} from '../../map/scenery.ts'
import { localPointFromLonLat, type DroneWorldCenter } from './drone-map-world.ts'

interface RoadTileRuntimeEntry {
  readonly key: string
  readonly controller: AbortController
  mesh: Mesh | null
  material: StandardMaterial | null
  texture: DynamicTexture | null
}

interface RoadTileBounds {
  readonly west: number
  readonly south: number
  readonly east: number
  readonly north: number
}

type RoadCanvasContext = ICanvasRenderingContext & {
  lineCap: string
}

export interface DroneRoadOverlayMetrics {
  readonly loadedRoadTiles: number
  readonly pendingRoadTiles: number
  readonly roadTextureBytes: number
}

export interface DroneRoadOverlayRenderer {
  readonly attachTileForModelUrl: (modelUrl: string) => void
  readonly disposeTileForModelUrl: (modelUrl: string) => void
  readonly metrics: () => DroneRoadOverlayMetrics
  readonly dispose: () => void
}

const roadTextureSizePx = 512
const roadPlaneY = 1.46
const metersPerDegreeLat = 111_320

const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

const tileXToLon = (x: number, z: number): number =>
  x / 2 ** z * 360 - 180

const tileYToLat = (y: number, z: number): number => {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z
  return Math.atan(Math.sinh(n)) * 180 / Math.PI
}

const tileBounds = (
  coord: SceneryTileCoord,
): RoadTileBounds => ({
  west: tileXToLon(coord.x, coord.z),
  east: tileXToLon(coord.x + 1, coord.z),
  north: tileYToLat(coord.y, coord.z),
  south: tileYToLat(coord.y + 1, coord.z),
})

export const roadTileUrlFromModelUrl = (
  modelUrl: string,
  roadTileTemplate: string,
): string | null => {
  const baseUrl = typeof window === 'undefined' ? 'http://leitbild.local/' : window.location.href
  const url = new URL(modelUrl, baseUrl)
  const match = url.pathname.match(/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.glb$/)
  if (!match) return null
  const [, recipeId, z, x, y] = match
  if (!recipeId || !z || !x || !y) return null
  return roadTileTemplate
    .replace('{recipeId}', recipeId)
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y)
}

const roadPriority = (className: string): number => {
  if (className === 'motorway' || className === 'motorway_link') return 90
  if (className === 'trunk' || className === 'trunk_link') return 80
  if (className === 'primary') return 70
  if (className === 'secondary') return 60
  if (className === 'tertiary') return 50
  if (className === 'minor' || className === 'residential' || className === 'unclassified') return 40
  return 30
}

const roadFillColor = (feature: SceneryRoadFeature): string => {
  const priority = roadPriority(feature.className)
  if (feature.isTunnel) return 'rgba(88, 94, 98, 0.72)'
  if (priority >= 70) return '#4a5057'
  if (priority >= 50) return '#555a5d'
  return '#62676a'
}

const roadCasingColor = (feature: SceneryRoadFeature): string =>
  feature.isTunnel ? 'rgba(38, 45, 52, 0.58)' : '#26313a'

const roadShoulderColor = (feature: SceneryRoadFeature): string =>
  feature.isBridge ? '#c8c2b0' : '#d2ccb8'

const orderedRoads = (
  roads: ReadonlyArray<SceneryRoadFeature>,
): ReadonlyArray<SceneryRoadFeature> =>
  [...roads].sort((left, right) =>
    roadPriority(left.className) - roadPriority(right.className)
      || left.widthM - right.widthM
      || left.id.localeCompare(right.id),
  )

const pixelsPerMeterFor = (
  tile: SceneryRoadTile,
  bounds: RoadTileBounds,
): number => {
  const centerLat = (bounds.north + bounds.south) / 2
  const widthM = Math.abs(bounds.east - bounds.west) * metersPerDegreeLonAt(centerLat)
  const heightM = Math.abs(bounds.north - bounds.south) * metersPerDegreeLat
  return roadTextureSizePx / Math.max(widthM, heightM, 1)
}

const drawRoadPath = (
  context: RoadCanvasContext,
  feature: SceneryRoadFeature,
  widthPx: number,
  extent: number,
): void => {
  if (feature.path.length < 2) return
  context.beginPath()
  for (const [index, point] of feature.path.entries()) {
    const x = point[0] / extent * roadTextureSizePx
    const y = point[1] / extent * roadTextureSizePx
    if (index === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  }
  context.lineWidth = Math.max(1, widthPx)
  context.stroke()
}

const drawRoadLayer = (
  context: RoadCanvasContext,
  roads: ReadonlyArray<SceneryRoadFeature>,
  pixelsPerMeter: number,
  widthFor: (feature: SceneryRoadFeature) => number,
  colorFor: (feature: SceneryRoadFeature) => string,
  extent: number,
): void => {
  context.setLineDash([])
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (const feature of roads) {
    context.strokeStyle = colorFor(feature)
    drawRoadPath(context, feature, widthFor(feature) * pixelsPerMeter, extent)
  }
}

const drawRoadMarkings = (
  context: RoadCanvasContext,
  roads: ReadonlyArray<SceneryRoadFeature>,
  pixelsPerMeter: number,
  extent: number,
): void => {
  context.lineCap = 'butt'
  context.lineJoin = 'round'
  context.strokeStyle = 'rgba(248, 246, 220, 0.82)'
  for (const feature of roads) {
    if (feature.widthM < 8 || roadPriority(feature.className) < 50 || feature.isTunnel) continue
    context.setLineDash([Math.max(5, 7 * pixelsPerMeter), Math.max(8, 12 * pixelsPerMeter)])
    drawRoadPath(context, feature, Math.max(1.1, 0.38 * pixelsPerMeter), extent)
  }
  context.setLineDash([])
}

const paintRoadTexture = (
  texture: DynamicTexture,
  tile: SceneryRoadTile,
): void => {
  const context = texture.getContext() as RoadCanvasContext
  context.clearRect(0, 0, roadTextureSizePx, roadTextureSizePx)
  const bounds = tileBounds(tile.tile)
  const pixelsPerMeter = pixelsPerMeterFor(tile, bounds)
  const roads = orderedRoads(tile.roads)
  drawRoadLayer(context, roads, pixelsPerMeter, feature => feature.widthM + Math.max(6.5, feature.widthM * 0.28), roadShoulderColor, tile.tile.extent)
  drawRoadLayer(context, roads, pixelsPerMeter, feature => feature.widthM + Math.max(3.5, feature.widthM * 0.16), roadCasingColor, tile.tile.extent)
  drawRoadLayer(context, roads, pixelsPerMeter, feature => feature.widthM, roadFillColor, tile.tile.extent)
  drawRoadMarkings(context, roads, pixelsPerMeter, tile.tile.extent)
  texture.update(false)
}

const createRoadMaterial = (
  scene: Scene,
  texture: DynamicTexture,
): StandardMaterial => {
  const material = new StandardMaterial('drone-road-overlay-material', scene)
  texture.hasAlpha = true
  texture.wrapU = Texture.CLAMP_ADDRESSMODE
  texture.wrapV = Texture.CLAMP_ADDRESSMODE
  material.diffuseTexture = texture
  material.useAlphaFromDiffuseTexture = true
  material.transparencyMode = Material.MATERIAL_ALPHATEST
  material.alphaCutOff = 0.04
  material.diffuseColor = Color3.White()
  material.ambientColor = Color3.White()
  material.specularColor = Color3.Black()
  material.backFaceCulling = false
  return material
}

const createRoadMesh = (
  scene: Scene,
  tile: SceneryRoadTile,
  center: DroneWorldCenter,
  material: StandardMaterial,
): Mesh => {
  const bounds = tileBounds(tile.tile)
  const westSouth = localPointFromLonLat(bounds.west, bounds.south, center)
  const eastNorth = localPointFromLonLat(bounds.east, bounds.north, center)
  const tileCenter = localPointFromLonLat((bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2, center)
  const mesh = MeshBuilder.CreateGround('drone-road-overlay-tile', {
    width: Math.max(1, Math.abs(eastNorth.x - westSouth.x)),
    height: Math.max(1, Math.abs(eastNorth.z - westSouth.z)),
    subdivisions: 1,
  }, scene)
  mesh.position = new Vector3(tileCenter.x, roadPlaneY, tileCenter.z)
  mesh.material = material
  mesh.isPickable = false
  return mesh
}

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

  const disposeEntry = (entry: RoadTileRuntimeEntry): void => {
    entry.controller.abort()
    entry.mesh?.dispose(false, true)
    entry.material?.dispose(false, true)
    entry.texture?.dispose()
    entries.delete(entry.key)
  }

  const loadEntry = async (
    entry: RoadTileRuntimeEntry,
    roadTileUrl: string,
  ): Promise<void> => {
    try {
      const tile = await fetchRoadTile(roadTileUrl, entry.controller.signal)
      if (entry.controller.signal.aborted || !entries.has(entry.key)) return
      if (tile.roads.length === 0) {
        entries.delete(entry.key)
        return
      }
      const texture = new DynamicTexture(`drone-road-overlay:${entry.key}`, { width: roadTextureSizePx, height: roadTextureSizePx }, config.scene, false)
      paintRoadTexture(texture, tile)
      const material = createRoadMaterial(config.scene, texture)
      const mesh = createRoadMesh(config.scene, tile, config.center, material)
      entry.texture = texture
      entry.material = material
      entry.mesh = mesh
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
        mesh: null,
        material: null,
        texture: null,
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
      loadedRoadTiles: [...entries.values()].filter(entry => entry.mesh !== null).length,
      pendingRoadTiles: [...entries.values()].filter(entry => entry.mesh === null).length,
      roadTextureBytes: [...entries.values()].filter(entry => entry.texture !== null).length * roadTextureSizePx * roadTextureSizePx * 4,
    }),
    dispose: (): void => {
      for (const entry of [...entries.values()]) disposeEntry(entry)
    },
  }
}
