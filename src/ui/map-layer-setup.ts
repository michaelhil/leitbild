import type { Map as MapLibreMap } from 'maplibre-gl'
import type { GeoJSON } from 'geojson'
import type { OperationalObject } from '../core/model/index.ts'
import type { PackObjectPresentation } from '../core/packs/protocol.ts'
import {
  createObjectFeatureCollection,
  createRouteFeatureCollection,
  createTrafficAreaFeatureCollection,
  createTrafficLineFeatureCollection,
  mapLayerIds,
  mapSourceIds,
} from './map-features.ts'

const asMutableGeoJson = (data: GeoJSON): GeoJSON => data

export const addOperationalMapSourcesAndLayers = (config: {
  readonly map: MapLibreMap
  readonly objects: ReadonlyArray<OperationalObject>
  readonly selectedControllerId: string | null
  readonly highlightedObjectIds: ReadonlyArray<string>
  readonly hasNewInfo: (object: OperationalObject) => boolean
  readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
  readonly routeCasingColor: string
  readonly trafficCasingColor: string
  readonly refreshSources: () => void
}): void => {
  const current = config.map
  if (current.getSource(mapSourceIds.objects)) {
    config.refreshSources()
    return
  }
  current.addSource(mapSourceIds.plannedRoutes, {
    type: 'geojson',
    data: asMutableGeoJson(createRouteFeatureCollection([...config.objects], config.selectedControllerId) as unknown as GeoJSON),
  })
  current.addSource(mapSourceIds.trafficLines, {
    type: 'geojson',
    data: asMutableGeoJson(createTrafficLineFeatureCollection([...config.objects], config.presentationFor) as unknown as GeoJSON),
  })
  current.addSource(mapSourceIds.trafficAreas, {
    type: 'geojson',
    data: asMutableGeoJson(createTrafficAreaFeatureCollection([...config.objects], config.presentationFor) as unknown as GeoJSON),
  })
  current.addLayer({
    id: mapLayerIds.trafficAreaFill,
    type: 'fill',
    source: mapSourceIds.trafficAreas,
    paint: {
      'fill-color': ['get', 'color'],
      'fill-opacity': 0.20,
    },
  })
  current.addLayer({
    id: mapLayerIds.trafficAreaOutline,
    type: 'line',
    source: mapSourceIds.trafficAreas,
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 2,
      'line-opacity': 0.82,
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  })
  current.addLayer({
    id: mapLayerIds.trafficLineCasing,
    type: 'line',
    source: mapSourceIds.trafficLines,
    paint: {
      'line-color': config.trafficCasingColor,
      'line-width': 7,
      'line-opacity': 0.64,
      'line-blur': 0.35,
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  })
  current.addLayer({
    id: mapLayerIds.trafficLine,
    type: 'line',
    source: mapSourceIds.trafficLines,
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 4,
      'line-opacity': 0.76,
      'line-blur': 0.15,
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  })
  current.addLayer({
    id: mapLayerIds.routeCasing,
    type: 'line',
    source: mapSourceIds.plannedRoutes,
    paint: {
      'line-color': config.routeCasingColor,
      'line-width': ['case', ['get', 'selected'], 7, 5],
      'line-opacity': 0.72,
      'line-blur': 0.35,
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  })
  current.addLayer({
    id: mapLayerIds.routeLine,
    type: 'line',
    source: mapSourceIds.plannedRoutes,
    paint: {
      'line-color': ['case', ['get', 'selected'], '#1d66d2', '#3977d6'],
      'line-width': ['case', ['get', 'selected'], 3.5, 2.5],
      'line-opacity': ['case', ['get', 'selected'], 0.92, 0.72],
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  })
  current.addSource(mapSourceIds.objects, {
    type: 'geojson',
    data: asMutableGeoJson(createObjectFeatureCollection([...config.objects], config.selectedControllerId, config.highlightedObjectIds, config.hasNewInfo, config.presentationFor) as unknown as GeoJSON),
  })
  current.addSource(mapSourceIds.placementPreview, {
    type: 'geojson',
    data: asMutableGeoJson({ type: 'FeatureCollection', features: [] } as GeoJSON),
  })
  current.addLayer({
    id: mapLayerIds.placementPreview,
    type: 'circle',
    source: mapSourceIds.placementPreview,
    paint: {
      'circle-radius': 7,
      'circle-color': '#1d66d2',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 3,
      'circle-opacity': 0.92,
    },
  })
  current.addLayer({
    id: mapLayerIds.objectHitArea,
    type: 'circle',
    source: mapSourceIds.objects,
    paint: {
      'circle-radius': 22,
      'circle-color': '#ffffff',
      'circle-opacity': 0,
    },
  })
  current.addLayer({
    id: mapLayerIds.objectHalos,
    type: 'circle',
    source: mapSourceIds.objects,
    filter: ['any', ['==', ['get', 'selected'], true], ['==', ['get', 'highlighted'], true]],
    paint: {
      'circle-radius': 22,
      'circle-color': '#ffffff',
      'circle-stroke-color': ['case', ['get', 'selected'], '#1d66d2', '#c17a13'],
      'circle-stroke-width': 3,
      'circle-opacity': 0.82,
    },
  })
  current.addLayer({
    id: mapLayerIds.objectIcons,
    type: 'symbol',
    source: mapSourceIds.objects,
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': 1,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-opacity': ['case', ['get', 'muted'], 0.44, 1],
    },
  })
  current.addLayer({
    id: mapLayerIds.objectNewInfo,
    type: 'circle',
    source: mapSourceIds.objects,
    filter: ['==', ['get', 'hasNewInfo'], true],
    paint: {
      'circle-radius': 6,
      'circle-color': '#c7352b',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
      'circle-translate': [12, -12],
    },
  })
}
