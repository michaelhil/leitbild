import type { GeoJsonLineString, GeoJsonPoint, GeoJsonPolygon, OperationalObject } from '../core/model/index.ts'
import type { PackObjectStatusTone, PackObjectPresentation } from '../core/packs/protocol.ts'
import { remainingRouteGeometry } from '../core/model/index.ts'
import { statusToneColor } from './status-presentation.ts'

export const mapSourceIds = {
  objects: 'objects',
  plannedRoutes: 'planned-route-source',
  weatherLines: 'weather-line-source',
  weatherAreas: 'weather-area-source',
  trafficLines: 'traffic-line-source',
  trafficAreas: 'traffic-area-source',
  placementPreview: 'placement-preview-source',
} as const

export const mapLayerIds = {
  weatherAreaFill: 'weather-area-fill',
  weatherAreaOutline: 'weather-area-outline',
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
}

type ZonePresentation = Pick<PackObjectPresentation, 'categoryId' | 'color' | 'summary' | 'mapAreaGeometries'>

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

export const createWeatherAreaFeatureCollection = (
  objects: ReadonlyArray<OperationalObject>,
  presentObject: (object: OperationalObject) => ZonePresentation,
): GeoJsonFeatureCollection<GeoJsonPolygon, ZoneFeatureProperties> => ({
  type: 'FeatureCollection',
  features: objects
    .filter(object => object.kind === 'zone' && object.spatial.geometry?.type === 'Polygon' && presentObject(object).categoryId === 'weather')
    .flatMap(object => {
      const presentation = presentObject(object)
      const geometries = presentation.mapAreaGeometries ?? [object.spatial.geometry as GeoJsonPolygon]
      return geometries.map((geometry, index) => ({
        type: 'Feature',
        id: `${object.id}:area:${index}`,
        geometry,
        properties: {
          id: object.id,
          color: presentation.color,
          summary: presentation.summary,
        },
      }))
    }),
})
