import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { GeoJSON } from 'geojson'
import type { GeoJsonLineString, GeoJsonPoint, OperationalObject } from '../../core/model/index.ts'
import type { PackMapAreaFeature, PackObjectPresentation } from '../../core/packs/protocol.ts'
import {
  createObjectFeatureCollection,
  createGridLineFeatureCollection,
  createRouteFeatureCollection,
  createTrafficAreaFeatureCollection,
  createTrafficLineFeatureCollection,
  createWeatherBaseGridFeatureCollection,
  createWeatherCellFeatureCollection,
  createWeatherInfluenceFeatureCollection,
  createWeatherInfluenceSymbolFeatureCollection,
  createWeatherLineFeatureCollection,
  mapSourceIds,
} from './map-features.ts'

export interface MapSourceDirty {
  readonly objects?: boolean
  readonly routes?: boolean
  readonly traffic?: boolean
  readonly grid?: boolean
  readonly weather?: boolean
}

export type MapSourceLayer = 'objects' | 'routes' | 'traffic' | 'grid' | 'weather'

export interface MapSourceController {
  readonly refreshAll: () => void
  readonly refreshObjects: (sourceObjects?: ReadonlyArray<OperationalObject>) => void
  readonly refreshRoutes: () => void
  readonly refreshTraffic: () => void
  readonly refreshGrid: () => void
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
  readonly isLayerEnabled: (layer: MapSourceLayer) => boolean
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
  let refreshRetryTimer: ReturnType<typeof setTimeout> | null = null
  let objectSourceDirty = false
  let routeSourceDirty = false
  let trafficSourceDirty = false
  let gridSourceDirty = false
  let weatherSourceDirty = false
  let gridGeometryById = new Map<string, GeoJsonLineString>()
  let gridVisualStateById = new Map<string, string>()

  const currentMapForSourceUpdate = (): MapLibreMap | null => {
    const current = config.getMap()
    return current && config.isLoaded() ? current : null
  }

  const hasDirtySources = (): boolean =>
    objectSourceDirty || routeSourceDirty || trafficSourceDirty || gridSourceDirty || weatherSourceDirty

  const gridGeometryChanged = (features: ReturnType<typeof createGridLineFeatureCollection>['features']): boolean => {
    if (features.length !== gridGeometryById.size) return true
    for (const feature of features) {
      if (feature.id === undefined) return true
      if (gridGeometryById.get(String(feature.id)) !== feature.geometry) return true
    }
    return false
  }

  const gridVisualStateKey = (properties: {
    readonly color: string
    readonly lineWidth?: number
    readonly lineOpacity?: number
  }): string =>
    `${properties.color}:${properties.lineWidth ?? ''}:${properties.lineOpacity ?? ''}`

  const applyGridFeatureState = (
    current: MapLibreMap,
    features: ReturnType<typeof createGridLineFeatureCollection>['features'],
  ): void => {
    const nextState = new Map<string, string>()
    for (const feature of features) {
      if (feature.id === undefined) continue
      const id = String(feature.id)
      const key = gridVisualStateKey(feature.properties)
      nextState.set(id, key)
      if (gridVisualStateById.get(id) === key) continue
      current.setFeatureState({
        source: mapSourceIds.gridLines,
        id,
      }, {
        color: feature.properties.color,
        lineWidth: feature.properties.lineWidth ?? 3.2,
        lineOpacity: feature.properties.lineOpacity ?? 0.84,
      })
    }
    for (const id of gridVisualStateById.keys()) {
      if (nextState.has(id)) continue
      current.removeFeatureState({ source: mapSourceIds.gridLines, id })
    }
    gridVisualStateById = nextState
  }

  const refreshObjects = (
    sourceObjects: ReadonlyArray<OperationalObject> = config.getObjects(),
  ): void => {
    if (!config.isLayerEnabled('objects')) return
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
    if (!config.isLayerEnabled('routes')) return
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
    if (!config.isLayerEnabled('traffic')) return
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

  const refreshGrid = (): void => {
    if (!config.isLayerEnabled('grid')) return
    const current = currentMapForSourceUpdate()
    if (!current) return
    const lineSource = getGeoJsonSource(current, mapSourceIds.gridLines)
    if (lineSource) {
      const collection = createGridLineFeatureCollection([...config.getObjects()], config.presentationFor)
      const shouldResetGeometry = gridGeometryChanged(collection.features)
      if (shouldResetGeometry) {
        lineSource.setData(asMapLibreGeoJson(collection))
        gridGeometryById = new Map(collection.features.flatMap(feature =>
          feature.id === undefined ? [] : [[String(feature.id), feature.geometry] as const],
        ))
      }
      applyGridFeatureState(current, collection.features)
    }
  }

  const refreshWeatherInfluences = (): void => {
    if (!config.isLayerEnabled('weather')) return
    const current = currentMapForSourceUpdate()
    if (!current) return
    const influenceSource = getGeoJsonSource(current, mapSourceIds.weatherInfluences)
    const areaFeatures = config.getPackMapAreaFeatures()
    if (influenceSource) {
      influenceSource.setData(asMapLibreGeoJson(createWeatherInfluenceFeatureCollection(areaFeatures)))
    }
    const symbolSource = getGeoJsonSource(current, mapSourceIds.weatherInfluenceSymbols)
    if (symbolSource) {
      symbolSource.setData(asMapLibreGeoJson(createWeatherInfluenceSymbolFeatureCollection(areaFeatures)))
    }
  }

  const refreshWeather = (): void => {
    if (!config.isLayerEnabled('weather')) return
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
    refreshGrid()
    refreshRoutes()
    refreshPlacementPreview()
  }

  const runScheduledRefresh = (): void => {
    refreshFrame = null
    if (!currentMapForSourceUpdate()) {
      if (hasDirtySources() && refreshRetryTimer === null) {
        refreshRetryTimer = setTimeout(() => {
          refreshRetryTimer = null
          if (hasDirtySources()) schedule({})
        }, 50)
      }
      return
    }
    const displayObjects = config.getDisplayObjects()
    if (objectSourceDirty) refreshObjects(displayObjects)
    config.updateMarkerPopup(displayObjects)
    if (weatherSourceDirty) refreshWeather()
    if (trafficSourceDirty) refreshTraffic()
    if (gridSourceDirty) refreshGrid()
    if (routeSourceDirty) refreshRoutes()
    refreshPlacementPreview()
    objectSourceDirty = false
    weatherSourceDirty = false
    trafficSourceDirty = false
    gridSourceDirty = false
    routeSourceDirty = false
  }

  const schedule = (dirty: MapSourceDirty): void => {
    objectSourceDirty = objectSourceDirty || dirty.objects === true
    routeSourceDirty = routeSourceDirty || dirty.routes === true
    trafficSourceDirty = trafficSourceDirty || (dirty.traffic === true && config.isLayerEnabled('traffic'))
    gridSourceDirty = gridSourceDirty || (dirty.grid === true && config.isLayerEnabled('grid'))
    weatherSourceDirty = weatherSourceDirty || (dirty.weather === true && config.isLayerEnabled('weather'))
    if (!hasDirtySources()) return
    if (refreshFrame !== null) return
    refreshFrame = requestAnimationFrame(runScheduledRefresh)
  }

  const stop = (): void => {
    if (refreshFrame !== null) {
      cancelAnimationFrame(refreshFrame)
      refreshFrame = null
    }
    if (refreshRetryTimer !== null) {
      clearTimeout(refreshRetryTimer)
      refreshRetryTimer = null
    }
    objectSourceDirty = false
    routeSourceDirty = false
    trafficSourceDirty = false
    gridSourceDirty = false
    weatherSourceDirty = false
    gridGeometryById = new Map()
    gridVisualStateById = new Map()
  }

  return {
    refreshAll,
    refreshObjects,
    refreshRoutes,
    refreshTraffic,
    refreshGrid,
    refreshWeather,
    refreshWeatherInfluences,
    refreshPlacementPreview,
    schedule,
    stop,
  }
}
