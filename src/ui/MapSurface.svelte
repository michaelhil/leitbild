<script lang="ts">
  import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
  import { Protocol as PmtilesProtocol } from 'pmtiles'
  import type { GeoJsonPoint, GeoJsonPolygon, IsoTimestamp, OperationalObject, SimulationClockState, SurfaceMapLayer, SurfaceMapRegionConfig } from '../core/model/index.ts'
  import { geoPointFromLonLat } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackMapAreaFeature, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { iconSvgDataUrl, type IconName } from './icons.ts'
  import {
    createObjectFeatureCollection,
    createRouteFeatureCollection,
    createTrafficAreaFeatureCollection,
    createTrafficLineFeatureCollection,
    createWeatherAreaFeatureCollection,
    createWeatherLineFeatureCollection,
    mapLayerIds,
    mapSourceIds,
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
    readonly layoutRevision?: number
    readonly debugMapInput?: boolean
    readonly highlightedObjectIds?: ReadonlyArray<string>
    readonly hasNewInfo: (object: OperationalObject) => boolean
    readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
    readonly mapAreaFeaturesFor: (context: { readonly viewport: GeoJsonPolygon; readonly zoom: number; readonly currentTime?: IsoTimestamp }) => ReadonlyArray<PackMapAreaFeature>
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
    layoutRevision = 0,
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
  let refreshFrame = $state<number | null>(null)
  let objectSourceDirty = false
  let routeSourceDirty = false
  let trafficSourceDirty = false
  let weatherSourceDirty = false
  let lastRouteRevision = -1
  let lastSelectedControllerId: string | null = null
  let displayMotionState: DisplayMotionState = createDisplayMotionState()
  let previousMotionObjects: ReadonlyArray<OperationalObject> = []
  let displayFrame: number | null = null
  let packAreaRefreshInterval: ReturnType<typeof setInterval> | null = null
  let pmtilesProtocolRegistered = false
  let objectInteractionsAdded = false
  let mapReadyNotified = false
  let appliedTheme: ThemeMode | null = null
  let mapInitialized = false
  let appliedCameraKey: string | null = null
  let mapGestureActive = false
  let viewportActivationFrame: number | null = null
  let mapInputDebugEntries = $state<ReadonlyArray<string>>([])
  let mapInputDebugSummary = $state('Waiting for map input')
  let stopMapInputDebug: (() => void) | null = null

  interface CameraInteractionHandler {
    readonly enable: () => void
    readonly isEnabled: () => boolean
  }

  type InputDebugEvent = Event & {
    readonly clientX?: number
    readonly clientY?: number
    readonly deltaX?: number
    readonly deltaY?: number
    readonly deltaMode?: number
    readonly ctrlKey?: boolean
    readonly metaKey?: boolean
    readonly shiftKey?: boolean
    readonly altKey?: boolean
    readonly pointerType?: string
    readonly button?: number
    readonly buttons?: number
    readonly scale?: number
    readonly rotation?: number
  }

  const targetDescription = (target: EventTarget | Element | null): string => {
    if (!(target instanceof Element)) return target === window ? 'window' : target === document ? 'document' : 'unknown'
    const id = target.id ? `#${target.id}` : ''
    const classes = target.classList.length > 0 ? `.${[...target.classList].slice(0, 4).join('.')}` : ''
    return `${target.tagName.toLowerCase()}${id}${classes}`
  }

  const topElementDescription = (event: InputDebugEvent): string => {
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return 'n/a'
    return targetDescription(document.elementFromPoint(event.clientX!, event.clientY!))
  }

  const cameraInteractionDebug = (current: MapLibreMap | null): string => {
    if (!current) return 'handlers=no-map'
    return cameraInteractionHandlers(current)
      .map(({ name, handler }) => `${name}:${handler.isEnabled() ? 'on' : 'off'}`)
      .join(' ')
  }

  const cameraStateDebug = (current: MapLibreMap | null): string => {
    if (!current) return 'camera=no-map'
    const center = current.getCenter()
    return `z=${current.getZoom().toFixed(2)} c=${center.lng.toFixed(5)},${center.lat.toFixed(5)} moving=${current.isMoving()}`
  }

  const eventModifierDebug = (event: InputDebugEvent): string => {
    const modifiers = [
      event.ctrlKey ? 'ctrl' : '',
      event.metaKey ? 'meta' : '',
      event.shiftKey ? 'shift' : '',
      event.altKey ? 'alt' : '',
    ].filter(Boolean)
    return modifiers.length > 0 ? modifiers.join('+') : 'no-mod'
  }

  const eventDetailDebug = (event: InputDebugEvent): string => {
    const details = [
      event.pointerType ? `pointer=${event.pointerType}` : '',
      typeof event.button === 'number' ? `button=${event.button}` : '',
      typeof event.buttons === 'number' ? `buttons=${event.buttons}` : '',
      typeof event.deltaY === 'number' ? `d=${Math.round(event.deltaX ?? 0)},${Math.round(event.deltaY)} mode=${event.deltaMode ?? 'n/a'}` : '',
      typeof event.scale === 'number' ? `scale=${event.scale.toFixed(3)}` : '',
      typeof event.rotation === 'number' ? `rotation=${event.rotation.toFixed(1)}` : '',
    ].filter(Boolean)
    return details.length > 0 ? details.join(' ') : 'no-detail'
  }

  const recordMapInputDebug = (label: string, event?: Event): void => {
    if (!debugMapInput) return
    const inputEvent = event as InputDebugEvent | undefined
    const entry = [
      `${performance.now().toFixed(0)}ms`,
      label,
      inputEvent ? `type=${inputEvent.type}` : 'type=note',
      inputEvent ? `target=${targetDescription(inputEvent.target)}` : '',
      inputEvent ? `top=${topElementDescription(inputEvent)}` : '',
      inputEvent ? `default=${inputEvent.defaultPrevented}` : '',
      inputEvent ? eventModifierDebug(inputEvent) : '',
      inputEvent ? eventDetailDebug(inputEvent) : '',
      cameraInteractionDebug(map),
      cameraStateDebug(map),
    ].filter(Boolean).join(' | ')
    mapInputDebugSummary = entry
    mapInputDebugEntries = [...mapInputDebugEntries.slice(-17), entry]
  }

  const addDebugListener = (
    cleanups: Array<() => void>,
    target: EventTarget,
    targetName: string,
    eventType: string,
  ): void => {
    const listener = (event: Event): void => recordMapInputDebug(`${targetName}:${eventType}`, event)
    target.addEventListener(eventType, listener, { capture: true, passive: true })
    cleanups.push(() => target.removeEventListener(eventType, listener, { capture: true }))
  }

  const installMapInputDebug = (current: MapLibreMap): void => {
    if (!debugMapInput) return
    stopMapInputDebug?.()
    const cleanups: Array<() => void> = []
    const canvas = current.getCanvas()
    const container = current.getContainer()
    const canvasContainer = current.getCanvasContainer()
    for (const eventType of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'touchstart', 'touchmove', 'touchend', 'gesturestart', 'gesturechange', 'gestureend']) {
      addDebugListener(cleanups, window, 'window', eventType)
      addDebugListener(cleanups, document, 'document', eventType)
      addDebugListener(cleanups, container, 'container', eventType)
      addDebugListener(cleanups, canvasContainer, 'canvas-container', eventType)
      addDebugListener(cleanups, canvas, 'canvas', eventType)
    }
    for (const eventType of ['dragstart', 'drag', 'dragend', 'zoomstart', 'zoom', 'zoomend', 'movestart', 'move', 'moveend']) {
      const listener = (event: unknown): void => recordMapInputDebug(`maplibre:${eventType}`, event instanceof Event ? event : undefined)
      current.on(eventType, listener)
      cleanups.push(() => current.off(eventType, listener))
    }
    stopMapInputDebug = () => {
      for (const cleanup of cleanups) cleanup()
      stopMapInputDebug = null
    }
    recordMapInputDebug('debug:installed')
  }

  const interactiveObjectLayerIds = [
    mapLayerIds.objectHitArea,
    mapLayerIds.objectIcons,
    mapLayerIds.objectHalos,
    mapLayerIds.objectNewInfo,
  ]

  const cameraInteractionHandlers = (current: MapLibreMap): ReadonlyArray<{
    readonly name: string
    readonly handler: CameraInteractionHandler
  }> => [
    { name: 'dragPan', handler: current.dragPan },
    { name: 'scrollZoom', handler: current.scrollZoom },
    { name: 'boxZoom', handler: current.boxZoom },
    { name: 'doubleClickZoom', handler: current.doubleClickZoom },
    { name: 'touchZoomRotate', handler: current.touchZoomRotate },
    { name: 'keyboard', handler: current.keyboard },
  ]

  const assertCameraInteractionContract = (current: MapLibreMap): void => {
    if (current.cooperativeGestures.isEnabled()) current.cooperativeGestures.disable()
    for (const { handler } of cameraInteractionHandlers(current)) {
      if (!handler.isEnabled()) handler.enable()
    }
    const disabled = cameraInteractionHandlers(current)
      .filter(({ handler }) => !handler.isEnabled())
      .map(({ name }) => name)
    if (disabled.length > 0) {
      throw new Error(`Map camera interactions disabled: ${disabled.join(', ')}`)
    }
  }

  const cancelViewportActivation = (): void => {
    if (viewportActivationFrame === null) return
    cancelAnimationFrame(viewportActivationFrame)
    viewportActivationFrame = null
  }

  const activateMapViewport = (current: MapLibreMap): void => {
    // MapLibre controls call camera methods that clear stale handler state; do the same once our Svelte layout has settled.
    recordMapInputDebug('activation:viewport')
    assertCameraInteractionContract(current)
    current.stop()
    current.resize({ source: 'leitbild-map-viewport-activation' })
  }

  const scheduleViewportActivation = (): void => {
    const current = map
    if (!current) return
    cancelViewportActivation()
    viewportActivationFrame = requestAnimationFrame(() => {
      viewportActivationFrame = requestAnimationFrame(() => {
        viewportActivationFrame = null
        if (map !== current) return
        activateMapViewport(current)
      })
    })
  }

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
      mapLayerIds.weatherAreaFill,
      mapLayerIds.weatherAreaOutline,
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

  const currentPackMapAreaFeatures = (): ReadonlyArray<PackMapAreaFeature> => {
    const current = map
    const viewport = currentViewport()
    if (!current || !viewport) return []
    return mapAreaFeaturesFor({ viewport, zoom: current.getZoom(), currentTime: currentDisplayTime() })
  }

  const escapeHtml = (value: string): string =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

  const refreshObjectSource = (sourceObjects: ReadonlyArray<OperationalObject> = objects): void => {
    const current = map
    if (!current || !loaded) return
    const source = current.getSource(mapSourceIds.objects) as GeoJSONSource | undefined
    if (source) source.setData(createObjectFeatureCollection([...sourceObjects], selectedControllerId, highlightedObjectIds, hasNewInfo, presentationFor))
  }

  const objectById = (
    objectId: string | null,
    sourceObjects: ReadonlyArray<OperationalObject> = objects,
  ): OperationalObject | null => (
    objectId === null
      ? null
      : sourceObjects.find(candidate => candidate.id === objectId) ?? null
  )

  const refreshRouteSource = (): void => {
    const current = map
    if (!current || !loaded) return
    const source = current.getSource(mapSourceIds.plannedRoutes) as GeoJSONSource | undefined
    if (source) source.setData(createRouteFeatureCollection([...objects], selectedControllerId))
  }

  const refreshTrafficSource = (): void => {
    const current = map
    if (!current || !loaded) return
    const lineSource = current.getSource(mapSourceIds.trafficLines) as GeoJSONSource | undefined
    const areaSource = current.getSource(mapSourceIds.trafficAreas) as GeoJSONSource | undefined
    if (lineSource) lineSource.setData(createTrafficLineFeatureCollection([...objects], presentationFor))
    if (areaSource) areaSource.setData(createTrafficAreaFeatureCollection([...objects], presentationFor))
  }

  const refreshWeatherSource = (): void => {
    const current = map
    if (!current || !loaded) return
    const lineSource = current.getSource(mapSourceIds.weatherLines) as GeoJSONSource | undefined
    const areaSource = current.getSource(mapSourceIds.weatherAreas) as GeoJSONSource | undefined
    if (lineSource) lineSource.setData(createWeatherLineFeatureCollection([...objects], presentationFor))
    if (areaSource) areaSource.setData(createWeatherAreaFeatureCollection(currentPackMapAreaFeatures()))
  }

  const refreshPlacementPreviewSource = (): void => {
    const current = map
    if (!current || !loaded) return
    const source = current.getSource(mapSourceIds.placementPreview) as GeoJSONSource | undefined
    if (!source) return
    source.setData({
      type: 'FeatureCollection',
      features: placementPoints.map((point, index) => ({
        type: 'Feature',
        id: `placement:${index}`,
        geometry: point,
        properties: {},
      })),
    })
  }

  const refreshSources = (): void => {
    refreshObjectSource()
    refreshWeatherSource()
    refreshTrafficSource()
    refreshRouteSource()
    refreshPlacementPreviewSource()
  }

  const scheduleSourceRefresh = (dirty: { readonly objects?: boolean; readonly routes?: boolean; readonly traffic?: boolean; readonly weather?: boolean }): void => {
    objectSourceDirty = objectSourceDirty || dirty.objects === true
    routeSourceDirty = routeSourceDirty || dirty.routes === true
    trafficSourceDirty = trafficSourceDirty || dirty.traffic === true
    weatherSourceDirty = weatherSourceDirty || dirty.weather === true
    if (refreshFrame !== null) return
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = null
      const nowMs = performance.now()
      const displayObjects = displayObjectsFor(objects, displayMotionState, nowMs)
      if (objectSourceDirty) refreshObjectSource(displayObjects)
      refreshMarkerPopup(displayObjects)
      if (weatherSourceDirty) refreshWeatherSource()
      if (trafficSourceDirty) refreshTrafficSource()
      if (routeSourceDirty) refreshRouteSource()
      refreshPlacementPreviewSource()
      objectSourceDirty = false
      weatherSourceDirty = false
      trafficSourceDirty = false
      routeSourceDirty = false
    })
  }

  const stopDisplayAnimation = (): void => {
    if (displayFrame === null) return
    cancelAnimationFrame(displayFrame)
    displayFrame = null
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
      if (mapGestureActive) return
      scheduleSourceRefresh({ weather: true })
    }, 2_000)
  }

  const scheduleDisplayAnimation = (): void => {
    if (displayFrame !== null) return
    displayFrame = requestAnimationFrame(() => {
      displayFrame = null
      const nowMs = performance.now()
      const displayObjects = displayObjectsFor(objects, displayMotionState, nowMs)
      refreshObjectSource(displayObjects)
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
        packMapAreaFeatures: currentPackMapAreaFeatures(),
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
      startPackAreaRefresh()
      scheduleViewportActivation()
      if (!mapReadyNotified) {
        mapReadyNotified = true
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
    const protocol = new PmtilesProtocol({ metadata: true })
    maplibregl.addProtocol('pmtiles', protocol.tile)
    pmtilesProtocolRegistered = true
    const current = new maplibregl.Map({
      container: mapElement,
      style: styleUrlFor(theme),
      center: mapConfig.center.coordinates,
      zoom: mapConfig.zoom,
      interactive: true,
      dragPan: true,
      scrollZoom: true,
      boxZoom: true,
      doubleClickZoom: true,
      touchZoomRotate: true,
      keyboard: true,
      cooperativeGestures: false,
    })
    assertCameraInteractionContract(current)
    installMapInputDebug(current)
    appliedTheme = theme
    appliedCameraKey = cameraKeyFor(mapConfig)
    map = current
    scheduleViewportActivation()
    current.on('error', (event) => {
      const error = event.error
      onMapError(error instanceof Error ? error.message : 'Vector map failed to load')
    })
    current.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
    current.on('click', (event) => {
      if (!placementMode) return
      onPlacementPoint(geoPointFromLonLat(event.lngLat.lng, event.lngLat.lat))
    })
    current.on('movestart', () => {
      mapGestureActive = true
    })
    current.on('moveend', () => {
      mapGestureActive = false
      scheduleSourceRefresh({ weather: true })
    })
    current.on('style.load', () => {
      void setupOperationalMapStyle(current)
    })
    current.on('load', () => {
      if (!loaded) void setupOperationalMapStyle(current)
    })

    return () => {
      stopMapInputDebug?.()
      cancelViewportActivation()
      if (refreshFrame !== null) cancelAnimationFrame(refreshFrame)
      stopDisplayAnimation()
      stopPackAreaRefresh()
      hideMarkerPopup()
      map?.remove()
      if (pmtilesProtocolRegistered) {
        maplibregl.removeProtocol('pmtiles')
        pmtilesProtocolRegistered = false
      }
      map = null
      loaded = false
      objectInteractionsAdded = false
      mapReadyNotified = false
      mapInitialized = false
      appliedCameraKey = null
      mapGestureActive = false
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
    scheduleSourceRefresh({ objects: true, routes: routesChanged, traffic: true, weather: true })
    refreshMarkerPopup(displayObjectsFor(objects, displayMotionState, nowMs))
    if (hasActiveDisplayMotion(displayMotionState, nowMs)) {
      scheduleDisplayAnimation()
    }
  })

  $effect(() => {
    clock
    if (!mapConfig.layers.includes('weather') || mapGestureActive) return
    scheduleSourceRefresh({ weather: true })
  })

  $effect(() => {
    renderRevision
    scheduleSourceRefresh({ objects: true })
  })

  $effect(() => {
    placementPoints
    refreshPlacementPreviewSource()
  })

  $effect(() => {
    placementCursor
    refreshCanvasCursor()
  })

  $effect(() => {
    layoutRevision
    const current = map
    if (!current) return
    recordMapInputDebug('effect:layout-resize')
    current.resize({ source: 'leitbild-layout-resize' })
    scheduleViewportActivation()
  })

  $effect(() => {
    const current = map
    if (!current) return
    recordMapInputDebug('effect:scenario-camera')
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
