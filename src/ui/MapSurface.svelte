<script lang="ts">
  import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl'
  import type { GeoJsonPoint, GeoJsonPolygon, IsoTimestamp, OperationalObject, SimulationClockState, SurfaceMapLayer, SurfaceMapRegionConfig } from '../core/model/index.ts'
  import { geoPointFromLonLat } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackMapAreaFeature, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { iconSvgDataUrl, type IconName } from './icons.ts'
  import {
    animatePackMapAreaFeatures,
    hasActivePackMapAreaFeatureAnimation,
    mapLayerIds,
    pointOf,
  } from './map-features.ts'
  import { registerObjectIconVariants } from './map-icon-registry.ts'
  import { addOperationalMapSourcesAndLayers } from './map-layer-setup.ts'
  import { simulationTimeAt } from './simulation-clock.ts'
  import {
    createDisplayMotionState,
    displayObjectsFor,
    hasActiveDisplayMotion,
    reconcileDisplayMotionState,
    type DisplayMotionState,
  } from './display-motion.ts'
  import { assertCameraInteractionContract } from './map/map-camera.ts'
  import { createMapInputDebugController } from './map/map-input-debug.ts'
  import { createMapLifecycle, type MapLifecycle } from './map/map-lifecycle.ts'
  import { createMapSourceController } from './map/map-source-controller.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import type { ThemeMode } from './theme.ts'

  interface Props {
    readonly objects: ReadonlyArray<OperationalObject>
    readonly selectedControllerId: string | null
    readonly placementMode: PackCreateObjectType | null
    readonly placementCursor: { readonly icon: IconName; readonly color: string } | null
    readonly placementPoints: ReadonlyArray<GeoJsonPoint>
    readonly theme: ThemeMode
    readonly mapConfig: SurfaceMapRegionConfig
    readonly clock?: SimulationClockState
    readonly routeRevision: number
    readonly debugMapInput?: boolean
    readonly highlightedObjectIds?: ReadonlyArray<string>
    readonly hasNewInfo: (object: OperationalObject) => boolean
    readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
    readonly mapAreaFeaturesFor: (context: { readonly viewport: GeoJsonPolygon; readonly zoom: number; readonly currentTime?: IsoTimestamp }) => Promise<ReadonlyArray<PackMapAreaFeature>>
    readonly onObjectSelected: (object: OperationalObject) => void
    readonly onPlacementPoint: (point: GeoJsonPoint) => void
    readonly onObjectSeen: (object: OperationalObject) => void
    readonly onMapReady: () => void
    readonly onMapError: (message: string) => void
  }

  const {
    objects,
    selectedControllerId,
    placementMode,
    placementCursor,
    placementPoints,
    theme,
    mapConfig,
    clock,
    routeRevision,
    debugMapInput = false,
    highlightedObjectIds = [],
    hasNewInfo,
    presentationFor,
    mapAreaFeaturesFor,
    onObjectSelected,
    onPlacementPoint,
    onObjectSeen,
    onMapReady,
    onMapError,
  }: Props = $props()

  let mapElement = $state<HTMLDivElement | null>(null)
  let map = $state<MapLibreMap | null>(null)
  let markerPopup = $state<maplibregl.Popup | null>(null)
  let hoveredObjectId = $state<string | null>(null)
  let loaded = $state(false)
  let renderRevision = $state(0)
  let lastRouteRevision = -1
  let lastSelectedControllerId: string | null = null
  let displayMotionState: DisplayMotionState = createDisplayMotionState()
  let previousMotionObjects: ReadonlyArray<OperationalObject> = []
  let displayFrame: number | null = null
  let packAreaAnimationFrame: number | null = null
  let packAreaRefreshInterval: ReturnType<typeof setInterval> | null = null
  let packAreaFeatureRequestSerial = 0
  let cachedPackMapAreaFeatures = $state<ReadonlyArray<PackMapAreaFeature>>([])
  let objectInteractionsAdded = false
  let mapReadyNotified = false
  let appliedTheme: ThemeMode | null = null
  let mapInitialized = false
  let appliedCameraKey: string | null = null
  let mapCameraGestureActive = false
  let mapLifecycle: MapLifecycle | null = null
  let mapInputDebugEntries = $state<ReadonlyArray<string>>([])
  let mapInputDebugSummary = $state('Waiting for map input')
  const mapInputDebugController = createMapInputDebugController({
    enabled: () => debugMapInput,
    getMap: () => map,
    setSummary: (summary) => {
      mapInputDebugSummary = summary
    },
    appendEntry: (entry) => {
      mapInputDebugEntries = [...mapInputDebugEntries.slice(-17), entry]
    },
  })

  const interactiveObjectLayerIds = [
    mapLayerIds.objectHitArea,
    mapLayerIds.objectIcons,
    mapLayerIds.objectHalos,
    mapLayerIds.objectNewInfo,
  ]

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
      mapLayerIds.weatherLineCasing,
      mapLayerIds.weatherLine,
    ]
    return [mapLayerIds.objectHalos]
  }

  const applyConfiguredLayerVisibility = (): void => {
    const current = map
    if (!current || !loaded) return
    const enabledLayers = new Set<SurfaceMapLayer>(mapConfig.layers)
    const surfaceLayers: ReadonlyArray<SurfaceMapLayer> = ['objects', 'routes', 'traffic', 'weather', 'highlights']
    for (const surfaceLayer of surfaceLayers) {
      const visibility = enabledLayers.has(surfaceLayer) ? 'visible' : 'none'
      for (const layerId of layerIdsForSurfaceLayer(surfaceLayer)) {
        if (current.getLayer(layerId)) current.setLayoutProperty(layerId, 'visibility', visibility)
      }
    }
  }

  const styleUrlFor = (mode: ThemeMode): string =>
    `/map/style.json?theme=${encodeURIComponent(mode)}`

  const routeCasingColor = (): string =>
    theme === 'dark' ? '#0b111b' : '#ffffff'

  const trafficCasingColor = (): string =>
    theme === 'dark' ? '#111827' : '#ffffff'

  const cameraKeyFor = (config: SurfaceMapRegionConfig): string => {
    const [lon, lat] = config.center.coordinates
    return `${lon}:${lat}:${config.zoom}`
  }

  const applyScenarioCameraDefault = (): void => {
    const current = map
    if (!current) return
    const cameraKey = cameraKeyFor(mapConfig)
    if (cameraKey === appliedCameraKey) return
    appliedCameraKey = cameraKey
    mapInputDebugController.record('camera:apply-scenario-default')
    current.jumpTo({
      center: mapConfig.center.coordinates,
      zoom: mapConfig.zoom,
    })
  }

  const currentViewport = (): GeoJsonPolygon | null => {
    const current = map
    if (!current) return null
    const bounds = current.getBounds()
    const west = bounds.getWest()
    const east = bounds.getEast()
    const south = bounds.getSouth()
    const north = bounds.getNorth()
    return {
      type: 'Polygon',
      coordinates: [[
        geoPointFromLonLat(west, south).coordinates,
        geoPointFromLonLat(east, south).coordinates,
        geoPointFromLonLat(east, north).coordinates,
        geoPointFromLonLat(west, north).coordinates,
        geoPointFromLonLat(west, south).coordinates,
      ]],
    }
  }

  const currentDisplayTime = (): IsoTimestamp | undefined =>
    simulationTimeAt(clock)

  const refreshPackMapAreaFeatures = async (): Promise<void> => {
    const current = map
    const viewport = currentViewport()
    if (!current || !viewport) {
      cachedPackMapAreaFeatures = []
      return
    }
    const serial = ++packAreaFeatureRequestSerial
    try {
      const features = await mapAreaFeaturesFor({ viewport, zoom: current.getZoom(), currentTime: currentDisplayTime() })
      if (serial !== packAreaFeatureRequestSerial) return
      cachedPackMapAreaFeatures = features
      sourceController.schedule({ weather: true })
      schedulePackAreaFeatureAnimation()
    } catch (err) {
      onMapError(err instanceof Error ? err.message : String(err))
    }
  }

  const escapeHtml = (value: string): string =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

  const sourceController = createMapSourceController({
    getMap: () => map,
    isLoaded: () => loaded,
    getObjects: () => objects,
    getDisplayObjects: () => displayObjectsFor(objects, displayMotionState, performance.now()),
    getSelectedControllerId: () => selectedControllerId,
    getHighlightedObjectIds: () => highlightedObjectIds,
    getPlacementPoints: () => placementPoints,
    hasNewInfo: (object) => hasNewInfo(object),
    presentationFor: (object) => presentationFor(object),
    getPackMapAreaFeatures: () => animatePackMapAreaFeatures(cachedPackMapAreaFeatures, currentDisplayTime()),
    updateMarkerPopup: (sourceObjects) => {
      refreshMarkerPopup(sourceObjects)
    },
  })

  const objectById = (
    objectId: string | null,
    sourceObjects: ReadonlyArray<OperationalObject> = objects,
  ): OperationalObject | null => (
    objectId === null
      ? null
      : sourceObjects.find(candidate => candidate.id === objectId) ?? null
  )

  const refreshSources = (): void => {
    sourceController.refreshAll()
  }

  const stopDisplayAnimation = (): void => {
    if (displayFrame === null) return
    cancelAnimationFrame(displayFrame)
    displayFrame = null
  }

  const packAreaFeatureAnimationActive = (): boolean =>
    hasActivePackMapAreaFeatureAnimation(cachedPackMapAreaFeatures, currentDisplayTime())

  const stopPackAreaFeatureAnimation = (): void => {
    if (packAreaAnimationFrame === null) return
    cancelAnimationFrame(packAreaAnimationFrame)
    packAreaAnimationFrame = null
  }

  const schedulePackAreaFeatureAnimation = (): void => {
    if (packAreaAnimationFrame !== null) return
    if (!packAreaFeatureAnimationActive()) return
    packAreaAnimationFrame = requestAnimationFrame(() => {
      packAreaAnimationFrame = null
      sourceController.refreshWeatherInfluences()
      if (packAreaFeatureAnimationActive()) schedulePackAreaFeatureAnimation()
    })
  }

  const stopPackAreaRefresh = (): void => {
    if (packAreaRefreshInterval === null) return
    clearInterval(packAreaRefreshInterval)
    packAreaRefreshInterval = null
  }

  const startPackAreaRefresh = (): void => {
    if (packAreaRefreshInterval !== null) return
    packAreaRefreshInterval = setInterval(() => {
      if (!loaded || !mapConfig.layers.includes('weather')) return
      if (mapCameraGestureActive) return
      void refreshPackMapAreaFeatures()
    }, 2_000)
  }

  const scheduleDisplayAnimation = (): void => {
    if (displayFrame !== null) return
    displayFrame = requestAnimationFrame(() => {
      displayFrame = null
      const nowMs = performance.now()
      const displayObjects = displayObjectsFor(objects, displayMotionState, nowMs)
      sourceController.refreshObjects(displayObjects)
      refreshMarkerPopup(displayObjects)
      if (hasActiveDisplayMotion(displayMotionState, nowMs)) {
        scheduleDisplayAnimation()
      }
    })
  }

  const placementCursorCss = (): string => {
    if (!placementCursor) return ''
    const url = iconSvgDataUrl(placementCursor.icon, { stroke: placementCursor.color, size: 32, strokeWidth: 2.6 })
    return `url("${url}") 16 16, pointer`
  }

  const refreshCanvasCursor = (): void => {
    const canvas = map?.getCanvas()
    if (!canvas) return
    canvas.style.cursor = placementCursorCss()
  }

  const hoverCardHtml = (object: OperationalObject): string => {
    const lines = presentationFor(object).fields
      .map(field => `<div>${escapeHtml(field.label)}: ${escapeHtml(field.value)}</div>`)
      .join('')
    const newInfo = hasNewInfo(object) ? '<div class="hover-new-info">New information</div>' : ''
    return `<strong>${escapeHtml(object.label)}</strong>${newInfo}${lines}`
  }

  const showMarkerPopup = (object: OperationalObject): void => {
    const current = map
    const point = pointOf(object)
    if (!current || !point) return
    hoveredObjectId = object.id
    const [lon, lat] = point.coordinates
    markerPopup = markerPopup ?? new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 26,
      className: 'object-popup',
    })
    markerPopup
      .setLngLat([lon, lat])
      .setHTML(hoverCardHtml(object))
      .addTo(current)
  }

  const hideMarkerPopup = (): void => {
    hoveredObjectId = null
    markerPopup?.remove()
    markerPopup = null
  }

  const refreshMarkerPopup = (sourceObjects: ReadonlyArray<OperationalObject> = objects): void => {
    const object = objectById(hoveredObjectId, sourceObjects)
    const point = object ? pointOf(object) : null
    if (!markerPopup || !object || !point) return
    const [lon, lat] = point.coordinates
    markerPopup
      .setLngLat([lon, lat])
      .setHTML(hoverCardHtml(object))
  }

  const objectFromMapEvent = (event: maplibregl.MapLayerMouseEvent): OperationalObject | null => {
    const objectId = String(event.features?.[0]?.properties?.id ?? '')
    return objects.find(candidate => candidate.id === objectId) ?? null
  }

  const addObjectInteractions = (current: MapLibreMap): void => {
    if (objectInteractionsAdded) return
    for (const layerId of interactiveObjectLayerIds) {
      current.on('click', layerId, (event) => {
        const object = objectFromMapEvent(event)
        if (object) onObjectSelected(object)
      })
      current.on('mouseenter', layerId, (event) => {
        current.getCanvas().style.cursor = placementCursor ? placementCursorCss() : 'pointer'
        const object = objectFromMapEvent(event)
        if (!object) return
        onObjectSeen(object)
        renderRevision += 1
        showMarkerPopup(object)
      })
      current.on('mouseleave', layerId, () => {
        refreshCanvasCursor()
        hideMarkerPopup()
      })
    }
    objectInteractionsAdded = true
  }

  const setupOperationalMapStyle = async (current: MapLibreMap): Promise<void> => {
    try {
      mapInputDebugController.record('style:setup-start')
      loaded = false
      assertCameraInteractionContract(current)
      await registerObjectIconVariants(current, 'ambulance')
      await registerObjectIconVariants(current, 'hospital')
      await registerObjectIconVariants(current, 'crash')
      await registerObjectIconVariants(current, 'traffic')
      await registerObjectIconVariants(current, 'weather')
      addOperationalMapSourcesAndLayers({
        map: current,
        objects,
        selectedControllerId,
        highlightedObjectIds,
        hasNewInfo,
        presentationFor,
        packMapAreaFeatures: cachedPackMapAreaFeatures,
        routeCasingColor: routeCasingColor(),
        trafficCasingColor: trafficCasingColor(),
        refreshSources,
      })
      addObjectInteractions(current)
      loaded = true
      lastRouteRevision = routeRevision
      lastSelectedControllerId = selectedControllerId
      applyConfiguredLayerVisibility()
      refreshSources()
      void refreshPackMapAreaFeatures()
      startPackAreaRefresh()
      if (!mapReadyNotified) {
        mapReadyNotified = true
        mapInputDebugController.record('style:map-ready')
        onMapReady()
      }
    } catch (err) {
      onMapError(err instanceof Error ? err.message : String(err))
    }
  }

  runOnMount(() => {
    if (!mapElement) throw new Error('Map surface element was not bound before map initialization')
    if (mapInitialized) return
    mapInitialized = true
    const lifecycle = createMapLifecycle({
      element: mapElement,
      styleUrl: styleUrlFor(theme),
      center: mapConfig.center,
      zoom: mapConfig.zoom,
      placementActive: () => placementMode !== null,
      recordDebug: mapInputDebugController.record,
      onError: onMapError,
      onPlacementPoint,
      onMoveStart: () => {
        mapCameraGestureActive = true
      },
      onMoveEnd: () => {
        mapCameraGestureActive = false
        void refreshPackMapAreaFeatures()
      },
      onStyleLoad: (styleMap) => {
        void setupOperationalMapStyle(styleMap)
      },
      onLoad: (loadedMap) => {
        if (!loaded) void setupOperationalMapStyle(loadedMap)
      },
    })
    mapLifecycle = lifecycle
    const current = lifecycle.map
    mapInputDebugController.install(current)
    appliedTheme = theme
    appliedCameraKey = cameraKeyFor(mapConfig)
    map = current

    return () => {
      mapInputDebugController.stop()
      sourceController.stop()
      stopDisplayAnimation()
      stopPackAreaFeatureAnimation()
      stopPackAreaRefresh()
      hideMarkerPopup()
      mapLifecycle?.destroy()
      mapLifecycle = null
      map = null
      loaded = false
      objectInteractionsAdded = false
      mapReadyNotified = false
      mapInitialized = false
      appliedCameraKey = null
      mapCameraGestureActive = false
    }
  })

  $effect(() => {
    objects
    selectedControllerId
    highlightedObjectIds
    routeRevision
    const nowMs = performance.now()
    displayMotionState = reconcileDisplayMotionState({
      previousState: displayMotionState,
      previousObjects: previousMotionObjects,
      nextObjects: objects,
      nowMs,
    })
    previousMotionObjects = objects
    const routesChanged = routeRevision !== lastRouteRevision || selectedControllerId !== lastSelectedControllerId
    lastRouteRevision = routeRevision
    lastSelectedControllerId = selectedControllerId
    sourceController.schedule({ objects: true, routes: routesChanged, traffic: true, weather: true })
    refreshMarkerPopup(displayObjectsFor(objects, displayMotionState, nowMs))
    if (hasActiveDisplayMotion(displayMotionState, nowMs)) {
      scheduleDisplayAnimation()
    }
    schedulePackAreaFeatureAnimation()
  })

  $effect(() => {
    clock
    if (!mapConfig.layers.includes('weather') || mapCameraGestureActive) return
    schedulePackAreaFeatureAnimation()
    void refreshPackMapAreaFeatures()
  })

  $effect(() => {
    renderRevision
    sourceController.schedule({ objects: true })
  })

  $effect(() => {
    placementPoints
    sourceController.refreshPlacementPreview()
  })

  $effect(() => {
    placementCursor
    refreshCanvasCursor()
  })

  $effect(() => {
    const current = map
    if (!current) return
    applyScenarioCameraDefault()
  })

  $effect(() => {
    const current = map
    if (!current) return
    mapConfig.layers
    applyConfiguredLayerVisibility()
  })

  $effect(() => {
    const current = map
    if (current && appliedTheme !== null && theme !== appliedTheme) {
      appliedTheme = theme
      loaded = false
      hideMarkerPopup()
      current.setStyle(styleUrlFor(theme))
    }
  })
</script>

<div class="map" bind:this={mapElement}></div>
{#if debugMapInput}
  <aside class="map-input-debug" aria-live="polite">
    <strong>Map Input Trace</strong>
    <span>{mapInputDebugSummary}</span>
    <ol>
      {#each mapInputDebugEntries as entry}
        <li>{entry}</li>
      {/each}
    </ol>
  </aside>
{/if}
