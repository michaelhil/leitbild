import type { Map as MapLibreMap } from 'maplibre-gl'
import type { SurfaceMapLayer } from '../../core/model/index.ts'
import { mapLayerIds } from './map-features.ts'

const layerIdsForSurfaceLayer = (layer: SurfaceMapLayer): ReadonlyArray<string> => {
  if (layer === 'objects') return [
    mapLayerIds.objectHitArea,
    mapLayerIds.objectIcons,
    mapLayerIds.objectNewInfo,
    mapLayerIds.placementPreview,
  ]
  if (layer === 'routes') return [
    mapLayerIds.routeCasing,
    mapLayerIds.routeLine,
  ]
  if (layer === 'traffic') return [
    mapLayerIds.trafficAreaFill,
    mapLayerIds.trafficAreaOutline,
    mapLayerIds.trafficLineCasing,
    mapLayerIds.trafficLine,
  ]
  if (layer === 'weather') return [
    mapLayerIds.weatherBaseGridOutline,
    mapLayerIds.weatherCellFill,
    mapLayerIds.weatherCellOutline,
    mapLayerIds.weatherInfluenceFill,
    mapLayerIds.weatherInfluenceOutline,
    mapLayerIds.weatherInfluenceSymbols,
    mapLayerIds.weatherLineCasing,
    mapLayerIds.weatherLine,
  ]
  if (layer === 'grid') return [
    mapLayerIds.gridLineCasing,
    mapLayerIds.gridLine,
  ]
  return [mapLayerIds.objectHalos]
}

export const applyConfiguredMapLayerVisibility = (config: {
  readonly map: MapLibreMap
  readonly enabledLayers: ReadonlyArray<SurfaceMapLayer>
}): void => {
  const enabledLayers = new Set<SurfaceMapLayer>(config.enabledLayers)
  const surfaceLayers: ReadonlyArray<SurfaceMapLayer> = ['objects', 'routes', 'traffic', 'weather', 'grid', 'highlights']
  for (const surfaceLayer of surfaceLayers) {
    const visibility = enabledLayers.has(surfaceLayer) ? 'visible' : 'none'
    for (const layerId of layerIdsForSurfaceLayer(surfaceLayer)) {
      if (config.map.getLayer(layerId)) config.map.setLayoutProperty(layerId, 'visibility', visibility)
    }
  }
}
