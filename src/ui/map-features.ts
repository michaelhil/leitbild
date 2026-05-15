import type { GeoJsonLineString, GeoJsonPoint, OperationalObject } from '../core/model/index.ts'

export const mapSourceIds = {
  objects: 'objects',
  ambulanceRoutes: 'ambulance-route-source',
} as const

export const mapLayerIds = {
  routeCasing: 'ambulance-route-casing',
  routeLine: 'ambulance-route-lines',
  objectHitArea: 'object-hit-area',
  objectHalos: 'object-halos',
  objectIcons: 'object-icons',
  objectNewInfo: 'object-new-info',
} as const

export type MapObjectIconName = 'ambulance' | 'hospital' | 'crash'

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
  readonly selected: boolean
  readonly hasNewInfo: boolean
}

interface RouteFeatureProperties {
  readonly selected: boolean
}

export const pointOf = (object: OperationalObject): GeoJsonPoint | null =>
  object.spatial.position?.point ?? null

export const colorForMapObject = (object: OperationalObject): string => {
  if (object.kind === 'mobile_entity') return '#22845d'
  if (object.kind === 'facility') return '#245b9f'
  return '#c7352b'
}

export const iconForMapObject = (object: OperationalObject): MapObjectIconName => {
  if (object.kind === 'mobile_entity') return 'ambulance'
  if (object.kind === 'facility') return 'hospital'
  return 'crash'
}

export const createObjectFeatureCollection = (
  objects: ReadonlyArray<OperationalObject>,
  selectedAmbulanceId: string | null,
  hasNewInfo: (object: OperationalObject) => boolean,
): GeoJsonFeatureCollection<GeoJsonPoint, ObjectFeatureProperties> => ({
  type: 'FeatureCollection',
  features: objects
    .filter(object => pointOf(object))
    .map(object => ({
      type: 'Feature',
      id: object.id,
      geometry: pointOf(object)!,
      properties: {
        id: object.id,
        color: colorForMapObject(object),
        icon: `object-${iconForMapObject(object)}`,
        selected: object.id === selectedAmbulanceId,
        hasNewInfo: hasNewInfo(object),
      },
    })),
})

export const createRouteFeatureCollection = (
  objects: ReadonlyArray<OperationalObject>,
  selectedAmbulanceId: string | null,
): GeoJsonFeatureCollection<GeoJsonLineString, RouteFeatureProperties> => ({
  type: 'FeatureCollection',
  features: objects
    .filter(object => object.kind === 'mobile_entity' && object.spatial.route?.planned)
    .map(object => ({
      type: 'Feature',
      id: object.id,
      geometry: object.spatial.route!.planned as GeoJsonLineString,
      properties: {
        selected: object.id === selectedAmbulanceId,
      },
    })),
})
