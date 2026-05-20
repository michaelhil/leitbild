import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { GeoJSON } from 'geojson'
import type { GeoJsonPoint, OperationalObject } from '../../core/model/index.ts'
import type { PackMapAreaFeature, PackObjectPresentation } from '../../core/packs/protocol.ts'
import {
  createObjectFeatureCollection,
  createRouteFeatureCollection,
  createTrafficAreaFeatureCollection,
  createTrafficLineFeatureCollection,
  createWeatherBaseGridFeatureCollection,
  createWeatherCellFeatureCollection,
  createWeatherInfluenceFeatureCollection,
  createWeatherLineFeatureCollection,
  mapSourceIds,
} from '../map-features.ts'

export interface MapSourceDirty {
  readonly objects?: boolean
  readonly routes?: boolean
  readonly traffic?: boolean
  readonly weather?: boolean
}

export interface MapSourceController {
  readonly refreshAll: () => void
  readonly refreshObjects: (sourceObjects?: ReadonlyArray<OperationalObject>) => void
  readonly refreshRoutes: () => void
  readonly refreshTraffic: () => void
  readonly refreshWeather: () => void
  readonly refreshWeatherInfluences: () => void
  readonly refreshPlacementPreview: () => void
  readonly schedule: (dirty: MapSourceDirty) => void
  readonly stop: () => void
}

interface MapSourceControllerConfig {
  readonly getMap: () => MapLibreMap | null
  readonly isLoaded: () => boolean
  readonly getObjects: () => ReadonlyArray<OperationalObject>
  readonly getDisplayObjects: () => ReadonlyArray<OperationalObject>
  readonly getSelectedControllerId: () => string | null
  readonly getHighlightedObjectIds: () => ReadonlyArray<string>
  readonly getPlacementPoints: () => ReadonlyArray<GeoJsonPoint>
  readonly hasNewInfo: (object: OperationalObject) => boolean
  readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
  readonly getPackMapAreaFeatures: () => ReadonlyArray<PackMapAreaFeature>
  readonly updateMarkerPopup: (sourceObjects: ReadonlyArray<OperationalObject>) => void
}

const getGeoJsonSource = (
  current: MapLibreMap,
  sourceId: string,
): GeoJSONSource | undefined =>
  current.getSource(sourceId) as GeoJSONSource | undefined

const asMapLibreGeoJson = (data: unknown): GeoJSON =>
  data as GeoJSON

export const createMapSourceController = (config: MapSourceControllerConfig): MapSourceController => {
  let refreshFrame: number | null = null
  let objectSourceDirty = false
  let routeSourceDirty = false
  let trafficSourceDirty = false
  let weatherSourceDirty = false

  const currentMapForSourceUpdate = (): MapLibreMap | null => {
    const current = config.getMap()
    return current && config.isLoaded() ? current : null
  }

  const refreshObjects = (
    sourceObjects: ReadonlyArray<OperationalObject> = config.getObjects(),
  ): void => {
    const current = currentMapForSourceUpdate()
    if (!current) return
    const source = getGeoJsonSource(current, mapSourceIds.objects)
    if (source) {
      source.setData(asMapLibreGeoJson(createObjectFeatureCollection(
        [...sourceObjects],
        config.getSelectedControllerId(),
        config.getHighlightedObjectIds(),
        config.hasNewInfo,
        config.presentationFor,
      )))
    }
  }

  const refreshRoutes = (): void => {
    const current = currentMapForSourceUpdate()
    if (!current) return
    const source = getGeoJsonSource(current, mapSourceIds.plannedRoutes)
    if (source) {
      source.setData(asMapLibreGeoJson(createRouteFeatureCollection(
        [...config.getObjects()],
        config.getSelectedControllerId(),
      )))
    }
  }

  const refreshTraffic = (): void => {
    const current = currentMapForSourceUpdate()
    if (!current) return
    const lineSource = getGeoJsonSource(current, mapSourceIds.trafficLines)
    const areaSource = getGeoJsonSource(current, mapSourceIds.trafficAreas)
    if (lineSource) {
      lineSource.setData(asMapLibreGeoJson(createTrafficLineFeatureCollection([...config.getObjects()], config.presentationFor)))
    }
    if (areaSource) {
      areaSource.setData(asMapLibreGeoJson(createTrafficAreaFeatureCollection([...config.getObjects()], config.presentationFor)))
    }
  }

  const refreshWeatherInfluences = (): void => {
    const current = currentMapForSourceUpdate()
    if (!current) return
    const influenceSource = getGeoJsonSource(current, mapSourceIds.weatherInfluences)
    const areaFeatures = config.getPackMapAreaFeatures()
    if (influenceSource) {
      influenceSource.setData(asMapLibreGeoJson(createWeatherInfluenceFeatureCollection(areaFeatures)))
    }
  }

  const refreshWeather = (): void => {
    const current = currentMapForSourceUpdate()
    if (!current) return
    const lineSource = getGeoJsonSource(current, mapSourceIds.weatherLines)
    const baseGridSource = getGeoJsonSource(current, mapSourceIds.weatherBaseGrid)
    const cellSource = getGeoJsonSource(current, mapSourceIds.weatherCells)
    const areaFeatures = config.getPackMapAreaFeatures()
    if (lineSource) {
      lineSource.setData(asMapLibreGeoJson(createWeatherLineFeatureCollection([...config.getObjects()], config.presentationFor)))
    }
    if (baseGridSource) {
      baseGridSource.setData(asMapLibreGeoJson(createWeatherBaseGridFeatureCollection(areaFeatures)))
    }
    if (cellSource) {
      cellSource.setData(asMapLibreGeoJson(createWeatherCellFeatureCollection(areaFeatures)))
    }
    refreshWeatherInfluences()
  }

  const refreshPlacementPreview = (): void => {
    const current = currentMapForSourceUpdate()
    if (!current) return
    const source = getGeoJsonSource(current, mapSourceIds.placementPreview)
    if (!source) return
    source.setData(asMapLibreGeoJson({
      type: 'FeatureCollection',
      features: config.getPlacementPoints().map((point, index) => ({
        type: 'Feature',
        id: `placement:${index}`,
        geometry: point,
        properties: {},
      })),
    }))
  }

  const refreshAll = (): void => {
    refreshObjects()
    refreshWeather()
    refreshTraffic()
    refreshRoutes()
    refreshPlacementPreview()
  }

  const schedule = (dirty: MapSourceDirty): void => {
    objectSourceDirty = objectSourceDirty || dirty.objects === true
    routeSourceDirty = routeSourceDirty || dirty.routes === true
    trafficSourceDirty = trafficSourceDirty || dirty.traffic === true
    weatherSourceDirty = weatherSourceDirty || dirty.weather === true
    if (refreshFrame !== null) return
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = null
      const displayObjects = config.getDisplayObjects()
      if (objectSourceDirty) refreshObjects(displayObjects)
      config.updateMarkerPopup(displayObjects)
      if (weatherSourceDirty) refreshWeather()
      if (trafficSourceDirty) refreshTraffic()
      if (routeSourceDirty) refreshRoutes()
      refreshPlacementPreview()
      objectSourceDirty = false
      weatherSourceDirty = false
      trafficSourceDirty = false
      routeSourceDirty = false
    })
  }

  const stop = (): void => {
    if (refreshFrame !== null) {
      cancelAnimationFrame(refreshFrame)
      refreshFrame = null
    }
    objectSourceDirty = false
    routeSourceDirty = false
    trafficSourceDirty = false
    weatherSourceDirty = false
  }

  return {
    refreshAll,
    refreshObjects,
    refreshRoutes,
    refreshTraffic,
    refreshWeather,
    refreshWeatherInfluences,
    refreshPlacementPreview,
    schedule,
    stop,
  }
}
