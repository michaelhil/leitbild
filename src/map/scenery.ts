import { z } from 'zod'

export const sceneryTileEncoding = 'leitbild-scenery-json-v1' as const
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
  tileEncoding: z.literal(sceneryTileEncoding),
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
  tileEncoding: sceneryTileEncoding,
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
