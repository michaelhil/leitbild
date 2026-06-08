import { z } from 'zod'

export const sceneryFeatureTileEncoding = 'leitbild-scenery-feature-json-v1' as const
export const sceneryAssetTileEncoding = 'model/gltf-binary' as const
export const sceneryAssetFormat = 'directory-glb' as const
export const sceneryAssetTileExtension = 'glb' as const
export const defaultSceneryRecipeId = 'drone-urban-flight' as const

export const sceneryTileCoordSchema = z.object({
  z: z.number().int().min(0).max(24),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
})
export type SceneryTileCoord = z.infer<typeof sceneryTileCoordSchema>

export const sceneryPointSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
])
export type SceneryPoint = z.infer<typeof sceneryPointSchema>

export const sceneryPolygonKindSchema = z.enum(['aeroway', 'building', 'water', 'landcover', 'landuse'])
export const sceneryLineKindSchema = z.enum(['aeroway', 'road', 'rail', 'waterway'])
export const sceneryLabelKindSchema = z.enum(['place', 'poi', 'road_label'])

export const sceneryPolygonFeatureSchema = z.object({
  id: z.string().min(1),
  sourceLayer: z.string().min(1),
  sourceRef: z.string().min(1).optional(),
  kind: sceneryPolygonKindSchema,
  className: z.string().min(1),
  name: z.string().min(1).optional(),
  subclass: z.string().min(1).optional(),
  rings: z.array(z.array(sceneryPointSchema).min(3)).min(1),
  heightM: z.number().finite().optional(),
  minHeightM: z.number().finite().optional(),
})
export type SceneryPolygonFeature = z.infer<typeof sceneryPolygonFeatureSchema>

export const sceneryLineFeatureSchema = z.object({
  id: z.string().min(1),
  sourceLayer: z.string().min(1),
  sourceRef: z.string().min(1).optional(),
  kind: sceneryLineKindSchema,
  className: z.string().min(1),
  subclass: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  surface: z.string().min(1).optional(),
  brunnel: z.string().min(1).optional(),
  layer: z.number().finite().optional(),
  service: z.string().min(1).optional(),
  access: z.string().min(1).optional(),
  maxspeedKph: z.number().finite().optional(),
  oneway: z.boolean().optional(),
  isBridge: z.boolean(),
  isTunnel: z.boolean(),
  path: z.array(sceneryPointSchema).min(2),
  widthM: z.number().finite().positive(),
  verticalOffsetM: z.number().finite(),
})
export type SceneryLineFeature = z.infer<typeof sceneryLineFeatureSchema>

export const sceneryLabelFeatureSchema = z.object({
  id: z.string().min(1),
  sourceLayer: z.string().min(1),
  kind: sceneryLabelKindSchema,
  className: z.string().min(1),
  label: z.string().min(1),
  point: sceneryPointSchema,
})
export type SceneryLabelFeature = z.infer<typeof sceneryLabelFeatureSchema>

export const sceneryTileSchema = z.object({
  schemaVersion: z.literal(1),
  tileEncoding: z.literal(sceneryFeatureTileEncoding),
  recipeId: z.string().min(1),
  sourceTilesetId: z.string().min(1),
  tile: sceneryTileCoordSchema.extend({
    extent: z.number().int().positive(),
  }),
  features: z.object({
    polygons: z.array(sceneryPolygonFeatureSchema),
    lines: z.array(sceneryLineFeatureSchema),
    labels: z.array(sceneryLabelFeatureSchema),
  }),
})
export type SceneryTile = z.infer<typeof sceneryTileSchema>

export const emptySceneryTile = (config: {
  readonly recipeId: string
  readonly sourceTilesetId: string
  readonly tile: SceneryTileCoord
  readonly extent?: number
}): SceneryTile => ({
  schemaVersion: 1,
  tileEncoding: sceneryFeatureTileEncoding,
  recipeId: config.recipeId,
  sourceTilesetId: config.sourceTilesetId,
  tile: {
    ...config.tile,
    extent: config.extent ?? 4096,
  },
  features: {
    polygons: [],
    lines: [],
    labels: [],
  },
})

export const sceneryTileHasFeatures = (tile: SceneryTile): boolean =>
  tile.features.polygons.length > 0 || tile.features.lines.length > 0 || tile.features.labels.length > 0

export const sceneryAssetBoundsSchema = z.object({
  minLon: z.number().finite(),
  minLat: z.number().finite(),
  maxLon: z.number().finite(),
  maxLat: z.number().finite(),
})
export type SceneryAssetBounds = z.infer<typeof sceneryAssetBoundsSchema>

export const sceneryAssetBoundingSphereSchema = z.object({
  centerLon: z.number().finite(),
  centerLat: z.number().finite(),
  centerHeightM: z.number().finite(),
  radiusM: z.number().finite().positive(),
})
export type SceneryAssetBoundingSphere = z.infer<typeof sceneryAssetBoundingSphereSchema>

export const sceneryAssetLodLevelSchema = z.object({
  zoom: z.number().int().min(0).max(24),
  geometricErrorM: z.number().finite().nonnegative(),
  maxScreenSpaceError: z.number().finite().positive(),
})
export type SceneryAssetLodLevel = z.infer<typeof sceneryAssetLodLevelSchema>

export const sceneryAssetTileSummarySchema = z.object({
  recipeId: z.string().min(1),
  z: z.number().int().min(0).max(24),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  byteLength: z.number().int().nonnegative(),
  centerLon: z.number().finite(),
  centerLat: z.number().finite(),
  bounds: sceneryAssetBoundsSchema,
  boundingSphere: sceneryAssetBoundingSphereSchema,
  lod: sceneryAssetLodLevelSchema,
  minHeightM: z.number().finite(),
  maxHeightM: z.number().finite(),
  featureCounts: z.object({
    polygons: z.number().int().nonnegative(),
    lines: z.number().int().nonnegative(),
    labels: z.number().int().nonnegative(),
    buildings: z.number().int().nonnegative(),
    roads: z.number().int().nonnegative(),
    water: z.number().int().nonnegative(),
    vegetation: z.number().int().nonnegative(),
  }),
})
export type SceneryAssetTileSummary = z.infer<typeof sceneryAssetTileSummarySchema>

export const sceneryAssetTileSummaryResponseSchema = z.object({
  schemaVersion: z.literal(1),
  recipeId: z.string().min(1),
  z: z.number().int().min(0).max(24),
  range: z.object({
    minX: z.number().int().min(0),
    maxX: z.number().int().min(0),
    minY: z.number().int().min(0),
    maxY: z.number().int().min(0),
  }),
  tileTemplate: z.literal('/map/scenery/current/{recipeId}/{z}/{x}/{y}.glb'),
  tiles: z.array(sceneryAssetTileSummarySchema),
})
export type SceneryAssetTileSummaryResponse = z.infer<typeof sceneryAssetTileSummaryResponseSchema>

export const sceneryAssetManifestSchema = z.object({
  schemaVersion: z.literal(1),
  artifactFormat: z.literal(sceneryAssetFormat),
  tileEncoding: z.literal(sceneryAssetTileEncoding),
  tilesetId: z.string().min(1),
  sourceTilesetId: z.string().min(1),
  sourcePmtilesPath: z.string().min(1),
  builtAt: z.string().min(1),
  bounds: sceneryAssetBoundsSchema,
  zooms: z.array(z.number().int().min(0).max(24)).min(1),
  lodLevels: z.array(sceneryAssetLodLevelSchema).min(1),
  inputArtifacts: z.array(z.object({
    kind: z.enum(['base-vector-pmtiles', 'terrain-dem-pmtiles', 'reference-pmtiles', 'reference-sidecar-geojson']),
    id: z.string().min(1),
    path: z.string().min(1),
    required: z.boolean(),
  })).min(1),
  recipes: z.array(z.unknown()).min(1),
  tileTemplate: z.literal('/map/scenery/current/{recipeId}/{z}/{x}/{y}.glb'),
  outputRoot: z.string().min(1),
  counts: z.object({
    decodedTileCount: z.number().int().nonnegative(),
    emptyTileCount: z.number().int().nonnegative(),
    writtenTileCount: z.number().int().nonnegative(),
    polygons: z.number().int().nonnegative(),
    lines: z.number().int().nonnegative(),
    labels: z.number().int().nonnegative(),
    buildings: z.number().int().nonnegative(),
    roads: z.number().int().nonnegative(),
    water: z.number().int().nonnegative(),
    vegetation: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  tiles: z.array(sceneryAssetTileSummarySchema),
})
export type SceneryAssetManifest = z.infer<typeof sceneryAssetManifestSchema>
