import { z } from 'zod'

export type Longitude = number & { readonly __brand: 'Longitude' }
export type Latitude = number & { readonly __brand: 'Latitude' }
export type Meters = number & { readonly __brand: 'Meters' }

export type GeoJsonPosition2D = readonly [Longitude, Latitude]

export interface GeoJsonPoint {
  readonly type: 'Point'
  readonly coordinates: GeoJsonPosition2D
}

export interface GeoJsonLineString {
  readonly type: 'LineString'
  readonly coordinates: ReadonlyArray<GeoJsonPosition2D>
}

export interface GeoJsonPolygon {
  readonly type: 'Polygon'
  readonly coordinates: ReadonlyArray<ReadonlyArray<GeoJsonPosition2D>>
}

export type GeoJsonGeometry = GeoJsonPoint | GeoJsonLineString | GeoJsonPolygon

const longitudeSchema = z.number().finite().min(-180).max(180).transform(value => value as Longitude)
const latitudeSchema = z.number().finite().min(-90).max(90).transform(value => value as Latitude)

export const geoJsonPosition2DSchema = z.tuple([longitudeSchema, latitudeSchema])

export const geoJsonPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: geoJsonPosition2DSchema,
})

export const geoJsonLineStringSchema = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(geoJsonPosition2DSchema).min(2),
})

export const geoJsonPolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(geoJsonPosition2DSchema).min(4)).min(1),
})

export const geoJsonGeometrySchema = z.discriminatedUnion('type', [
  geoJsonPointSchema,
  geoJsonLineStringSchema,
  geoJsonPolygonSchema,
])

export const metersSchema = z.number().finite().nonnegative().transform(value => value as Meters)

export const lon = (value: number): Longitude => longitudeSchema.parse(value)
export const lat = (value: number): Latitude => latitudeSchema.parse(value)
export const meters = (value: number): Meters => metersSchema.parse(value)

export const geoPointFromLonLat = (longitude: number, latitude: number): GeoJsonPoint => ({
  type: 'Point',
  coordinates: [lon(longitude), lat(latitude)],
})

export const coordinatesToLatLng = (position: GeoJsonPosition2D): readonly [number, number] => [
  position[1],
  position[0],
]
