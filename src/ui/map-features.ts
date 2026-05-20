import type { GeoJsonLineString, GeoJsonPoint, GeoJsonPolygon, OperationalObject } from '../core/model/index.ts'
import type { PackMapAreaFeature, PackObjectStatusTone, PackObjectPresentation } from '../core/packs/protocol.ts'
import { remainingRouteGeometry } from '../core/model/index.ts'
import { statusToneColor } from './status-presentation.ts'

export const mapSourceIds = {
  objects: 'objects',
  plannedRoutes: 'planned-route-source',
  weatherLines: 'weather-line-source',
  weatherBaseGrid: 'weather-base-grid-source',
  weatherCells: 'weather-cell-source',
  weatherInfluences: 'weather-influence-source',
  trafficLines: 'traffic-line-source',
  trafficAreas: 'traffic-area-source',
  placementPreview: 'placement-preview-source',
} as const

export const mapLayerIds = {
  weatherBaseGridOutline: 'weather-base-grid-outline',
  weatherCellFill: 'weather-cell-fill',
  weatherCellOutline: 'weather-cell-outline',
  weatherInfluenceFill: 'weather-influence-fill',
  weatherInfluenceOutline: 'weather-influence-outline',
  weatherLineCasing: 'weather-line-casing',
  weatherLine: 'weather-lines',
  trafficAreaFill: 'traffic-area-fill',
  trafficAreaOutline: 'traffic-area-outline',
  trafficLineCasing: 'traffic-line-casing',
  routeCasing: 'planned-route-casing',
  routeLine: 'planned-route-lines',
  trafficLine: 'traffic-lines',
  objectHitArea: 'object-hit-area',
  objectHalos: 'object-halos',
  objectIcons: 'object-icons',
  objectNewInfo: 'object-new-info',
  placementPreview: 'placement-preview',
} as const

interface GeoJsonFeature<G, P> {
  readonly type: 'Feature'
  readonly id?: string
  readonly geometry: G
  readonly properties: P
}

interface GeoJsonFeatureCollection<G, P> {
  readonly type: 'FeatureCollection'
  readonly features: ReadonlyArray<GeoJsonFeature<G, P>>
}

interface ObjectFeatureProperties {
  readonly id: string
  readonly color: string
  readonly icon: string
  readonly muted: boolean
  readonly selected: boolean
  readonly highlighted: boolean
  readonly hasNewInfo: boolean
}

interface RouteFeatureProperties {
  readonly selected: boolean
}

interface ZoneFeatureProperties {
  readonly id: string
  readonly color: string
  readonly summary: string
  readonly opacity?: number
  readonly lineColor?: string
  readonly lineOpacity?: number
  readonly lineWidth?: number
  readonly sortKey?: number
}

type ZonePresentation = Pick<PackObjectPresentation, 'categoryId' | 'color' | 'summary'>

export const pointOf = (object: OperationalObject): GeoJsonPoint | null =>
  object.spatial.position?.point ?? null

export const createObjectFeatureCollection = (
  objects: ReadonlyArray<OperationalObject>,
  selectedObjectId: string | null,
  highlightedObjectIds: ReadonlyArray<string>,
  hasNewInfo: (object: OperationalObject) => boolean,
  presentObject: (object: OperationalObject) => { readonly icon: string; readonly color: string; readonly muted?: boolean; readonly status?: { readonly tone: PackObjectStatusTone } },
): GeoJsonFeatureCollection<GeoJsonPoint, ObjectFeatureProperties> => ({
  type: 'FeatureCollection',
  features: objects
    .filter(object => pointOf(object))
    .map(object => {
      const presentation = presentObject(object)
      const statusTone = presentation.status?.tone ?? 'idle'
      return {
        type: 'Feature',
        id: object.id,
        geometry: pointOf(object)!,
        properties: {
          id: object.id,
          color: statusToneColor(statusTone),
          icon: `object-${presentation.icon}-${statusTone}`,
          muted: presentation.muted === true,
          selected: object.id === selectedObjectId,
          highlighted: highlightedObjectIds.includes(object.id),
          hasNewInfo: hasNewInfo(object),
        },
      }
    }),
})

export const createRouteFeatureCollection = (
  objects: ReadonlyArray<OperationalObject>,
  selectedObjectId: string | null,
): GeoJsonFeatureCollection<GeoJsonLineString, RouteFeatureProperties> => ({
  type: 'FeatureCollection',
  features: objects
    .filter(object => object.kind === 'mobile_entity' && object.spatial.route?.planned)
    .flatMap(object => {
      const route = object.spatial.route?.planned
      if (!route) return []
      const point = pointOf(object)
      const geometry = point && object.spatial.route?.progress
        ? remainingRouteGeometry(route, point, object.spatial.route.progress.segmentIndex)
        : route
      if (!geometry) return []
      return [{
        type: 'Feature',
        id: object.id,
        geometry,
        properties: {
          selected: object.id === selectedObjectId,
        },
      }]
    }),
})

export const createTrafficLineFeatureCollection = (
  objects: ReadonlyArray<OperationalObject>,
  presentObject: (object: OperationalObject) => ZonePresentation,
): GeoJsonFeatureCollection<GeoJsonLineString, ZoneFeatureProperties> => ({
  type: 'FeatureCollection',
  features: objects
    .filter(object => object.kind === 'zone' && object.spatial.geometry?.type === 'LineString' && presentObject(object).categoryId === 'traffic')
    .map(object => {
      const presentation = presentObject(object)
      return {
        type: 'Feature',
        id: object.id,
        geometry: object.spatial.geometry as GeoJsonLineString,
        properties: {
          id: object.id,
          color: presentation.color,
          summary: presentation.summary,
        },
      }
    }),
})

export const createTrafficAreaFeatureCollection = (
  objects: ReadonlyArray<OperationalObject>,
  presentObject: (object: OperationalObject) => ZonePresentation,
): GeoJsonFeatureCollection<GeoJsonPolygon, ZoneFeatureProperties> => ({
  type: 'FeatureCollection',
  features: objects
    .filter(object => object.kind === 'zone' && object.spatial.geometry?.type === 'Polygon' && presentObject(object).categoryId === 'traffic')
    .map(object => {
      const presentation = presentObject(object)
      return {
        type: 'Feature',
        id: object.id,
        geometry: object.spatial.geometry as GeoJsonPolygon,
        properties: {
          id: object.id,
          color: presentation.color,
          summary: presentation.summary,
        },
      }
    }),
})

export const createWeatherLineFeatureCollection = (
  objects: ReadonlyArray<OperationalObject>,
  presentObject: (object: OperationalObject) => ZonePresentation,
): GeoJsonFeatureCollection<GeoJsonLineString, ZoneFeatureProperties> => ({
  type: 'FeatureCollection',
  features: objects
    .filter(object => object.kind === 'zone' && object.spatial.geometry?.type === 'LineString' && presentObject(object).categoryId === 'weather')
    .map(object => {
      const presentation = presentObject(object)
      return {
        type: 'Feature',
        id: object.id,
        geometry: object.spatial.geometry as GeoJsonLineString,
        properties: {
          id: object.id,
          color: presentation.color,
          summary: presentation.summary,
        },
      }
    }),
})

const weatherAreaFeatureCollection = (
  packAreaFeatures: ReadonlyArray<PackMapAreaFeature>,
  include: (feature: PackMapAreaFeature) => boolean,
): GeoJsonFeatureCollection<GeoJsonPolygon, ZoneFeatureProperties> => ({
  type: 'FeatureCollection',
  features: packAreaFeatures
    .filter(feature => feature.categoryId === 'weather')
    .filter(include)
    .map(feature => ({
      type: 'Feature',
      id: feature.id,
      geometry: feature.geometry,
      properties: {
        id: feature.id,
        color: feature.color,
        summary: feature.summary,
        ...(feature.opacity === undefined ? {} : { opacity: feature.opacity }),
        ...(feature.lineColor === undefined ? {} : { lineColor: feature.lineColor }),
        ...(feature.lineOpacity === undefined ? {} : { lineOpacity: feature.lineOpacity }),
        ...(feature.lineWidth === undefined ? {} : { lineWidth: feature.lineWidth }),
        ...(feature.sortKey === undefined ? {} : { sortKey: feature.sortKey }),
      },
    })),
})

export const createWeatherBaseGridFeatureCollection = (
  packAreaFeatures: ReadonlyArray<PackMapAreaFeature>,
): GeoJsonFeatureCollection<GeoJsonPolygon, ZoneFeatureProperties> =>
  weatherAreaFeatureCollection(packAreaFeatures, feature => feature.id.startsWith('weather-grid:'))

export const createWeatherCellFeatureCollection = (
  packAreaFeatures: ReadonlyArray<PackMapAreaFeature>,
): GeoJsonFeatureCollection<GeoJsonPolygon, ZoneFeatureProperties> =>
  weatherAreaFeatureCollection(packAreaFeatures, feature => feature.id.startsWith('weather-cell:'))

export const createWeatherInfluenceFeatureCollection = (
  packAreaFeatures: ReadonlyArray<PackMapAreaFeature>,
): GeoJsonFeatureCollection<GeoJsonPolygon, ZoneFeatureProperties> =>
  weatherAreaFeatureCollection(packAreaFeatures, feature => feature.id.startsWith('weather:'))
