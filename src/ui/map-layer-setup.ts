import type { Map as MapLibreMap } from 'maplibre-gl'
import type { GeoJSON } from 'geojson'
import type { OperationalObject } from '../core/model/index.ts'
import type { PackMapAreaFeature, PackObjectPresentation } from '../core/packs/protocol.ts'
import {
  createObjectFeatureCollection,
  createRouteFeatureCollection,
  createTrafficAreaFeatureCollection,
  createTrafficLineFeatureCollection,
  createWeatherBaseGridFeatureCollection,
  createWeatherCellFeatureCollection,
  createWeatherInfluenceFeatureCollection,
  createWeatherInfluenceSymbolFeatureCollection,
  createWeatherLineFeatureCollection,
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
  readonly packMapAreaFeatures: ReadonlyArray<PackMapAreaFeature>
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
  current.addSource(mapSourceIds.weatherLines, {
    type: 'geojson',
    data: asMutableGeoJson(createWeatherLineFeatureCollection([...config.objects], config.presentationFor) as unknown as GeoJSON),
  })
  current.addSource(mapSourceIds.weatherBaseGrid, {
    type: 'geojson',
    data: asMutableGeoJson(createWeatherBaseGridFeatureCollection(config.packMapAreaFeatures) as unknown as GeoJSON),
  })
  current.addSource(mapSourceIds.weatherCells, {
    type: 'geojson',
    data: asMutableGeoJson(createWeatherCellFeatureCollection(config.packMapAreaFeatures) as unknown as GeoJSON),
  })
  current.addSource(mapSourceIds.weatherInfluences, {
    type: 'geojson',
    data: asMutableGeoJson(createWeatherInfluenceFeatureCollection(config.packMapAreaFeatures) as unknown as GeoJSON),
  })
  current.addSource(mapSourceIds.weatherInfluenceSymbols, {
    type: 'geojson',
    data: asMutableGeoJson(createWeatherInfluenceSymbolFeatureCollection(config.packMapAreaFeatures) as unknown as GeoJSON),
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
    id: mapLayerIds.weatherBaseGridOutline,
    type: 'line',
    source: mapSourceIds.weatherBaseGrid,
    paint: {
      'line-color': ['coalesce', ['get', 'lineColor'], ['get', 'color']],
      'line-width': ['coalesce', ['get', 'lineWidth'], 0.35],
      'line-opacity': ['coalesce', ['get', 'lineOpacity'], 0.12],
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  })
  current.addLayer({
    id: mapLayerIds.weatherCellFill,
    type: 'fill',
    source: mapSourceIds.weatherCells,
    layout: {
      'fill-sort-key': ['coalesce', ['get', 'sortKey'], 0],
    },
    paint: {
      'fill-color': ['get', 'color'],
      'fill-opacity': ['coalesce', ['get', 'opacity'], 0.12],
    },
  })
  current.addLayer({
    id: mapLayerIds.weatherCellOutline,
    type: 'line',
    source: mapSourceIds.weatherCells,
    paint: {
      'line-color': ['coalesce', ['get', 'lineColor'], ['get', 'color']],
      'line-width': ['coalesce', ['get', 'lineWidth'], 0.45],
      'line-opacity': ['coalesce', ['get', 'lineOpacity'], 0.10],
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  })
  current.addLayer({
    id: mapLayerIds.weatherInfluenceFill,
    type: 'fill',
    source: mapSourceIds.weatherInfluences,
    layout: {
      'fill-sort-key': ['coalesce', ['get', 'sortKey'], 0],
    },
    paint: {
      'fill-color': ['get', 'color'],
      'fill-opacity': ['coalesce', ['get', 'opacity'], 0.10],
    },
  })
  current.addLayer({
    id: mapLayerIds.weatherInfluenceOutline,
    type: 'line',
    source: mapSourceIds.weatherInfluences,
    paint: {
      'line-color': ['coalesce', ['get', 'lineColor'], ['get', 'color']],
      'line-width': ['coalesce', ['get', 'lineWidth'], 0.6],
      'line-opacity': ['coalesce', ['get', 'lineOpacity'], 0.16],
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  })
  current.addLayer({
    id: mapLayerIds.weatherInfluenceSymbols,
    type: 'symbol',
    source: mapSourceIds.weatherInfluenceSymbols,
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': ['coalesce', ['get', 'size'], 0.82],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-opacity': ['coalesce', ['get', 'opacity'], 0.92],
    },
  })
  current.addLayer({
    id: mapLayerIds.weatherLineCasing,
    type: 'line',
    source: mapSourceIds.weatherLines,
    paint: {
      'line-color': config.trafficCasingColor,
      'line-width': 5,
      'line-opacity': 0.36,
      'line-blur': 0.4,
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  })
  current.addLayer({
    id: mapLayerIds.weatherLine,
    type: 'line',
    source: mapSourceIds.weatherLines,
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 2.5,
      'line-opacity': 0.62,
      'line-blur': 0.1,
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
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
