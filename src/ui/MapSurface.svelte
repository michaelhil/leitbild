<script lang="ts">
  import { untrack } from 'svelte'
  import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
  import { Protocol as PmtilesProtocol } from 'pmtiles'
  import type { GeoJsonPoint, OperationalObject } from '../core/model/index.ts'
  import { geoPointFromLonLat } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { iconSvgDataUrl, type IconName } from './icons.ts'
  import {
    createObjectFeatureCollection,
    createRouteFeatureCollection,
    createTrafficAreaFeatureCollection,
    createTrafficLineFeatureCollection,
    mapLayerIds,
    mapSourceIds,
    pointOf,
  } from './map-features.ts'
  import { registerObjectIconVariants } from './map-icon-registry.ts'
  import { addOperationalMapSourcesAndLayers } from './map-layer-setup.ts'
  import {
    createDisplayMotionState,
    displayObjectsFor,
    hasActiveDisplayMotion,
    reconcileDisplayMotionState,
    type DisplayMotionState,
  } from './display-motion.ts'
  import type { ThemeMode } from './theme.ts'

  interface Props {
    readonly objects: ReadonlyArray<OperationalObject>
    readonly selectedControllerId: string | null
    readonly placementMode: PackCreateObjectType | null
    readonly placementCursor: { readonly icon: IconName; readonly color: string } | null
    readonly theme: ThemeMode
    readonly routeRevision: number
    readonly layoutRevision?: number
    readonly hasNewInfo: (object: OperationalObject) => boolean
    readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
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
    theme,
    routeRevision,
    layoutRevision = 0,
    hasNewInfo,
    presentationFor,
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
  let lastRouteRevision = -1
  let lastSelectedControllerId: string | null = null
  let displayMotionState: DisplayMotionState = createDisplayMotionState()
  let previousMotionObjects: ReadonlyArray<OperationalObject> = []
  let displayFrame: number | null = null
  let pmtilesProtocolRegistered = false
  let objectInteractionsAdded = false
  let mapReadyNotified = false
  let appliedTheme: ThemeMode | null = null
  let mapInitialized = false

  const interactiveObjectLayerIds = [
    mapLayerIds.objectHitArea,
    mapLayerIds.objectIcons,
    mapLayerIds.objectHalos,
    mapLayerIds.objectNewInfo,
  ]

  const styleUrlFor = (mode: ThemeMode): string =>
    `/map/style.json?theme=${encodeURIComponent(mode)}`

  const routeCasingColor = (): string =>
    theme === 'dark' ? '#0b111b' : '#ffffff'

  const trafficCasingColor = (): string =>
    theme === 'dark' ? '#111827' : '#ffffff'

  const escapeHtml = (value: string): string =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

  const refreshObjectSource = (sourceObjects: ReadonlyArray<OperationalObject> = objects): void => {
    const current = map
    if (!current || !loaded) return
    const source = current.getSource(mapSourceIds.objects) as GeoJSONSource | undefined
    if (source) source.setData(createObjectFeatureCollection([...sourceObjects], selectedControllerId, hasNewInfo, presentationFor))
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

  const refreshSources = (): void => {
    refreshObjectSource()
    refreshTrafficSource()
    refreshRouteSource()
  }

  const scheduleSourceRefresh = (dirty: { readonly objects?: boolean; readonly routes?: boolean; readonly traffic?: boolean }): void => {
    objectSourceDirty = objectSourceDirty || dirty.objects === true
    routeSourceDirty = routeSourceDirty || dirty.routes === true
    trafficSourceDirty = trafficSourceDirty || dirty.traffic === true
    if (refreshFrame !== null) return
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = null
      const nowMs = performance.now()
      const displayObjects = displayObjectsFor(objects, displayMotionState, nowMs)
      if (objectSourceDirty) refreshObjectSource(displayObjects)
      refreshMarkerPopup(displayObjects)
      if (trafficSourceDirty) refreshTrafficSource()
      if (routeSourceDirty) refreshRouteSource()
      objectSourceDirty = false
      trafficSourceDirty = false
      routeSourceDirty = false
    })
  }

  const stopDisplayAnimation = (): void => {
    if (displayFrame === null) return
    cancelAnimationFrame(displayFrame)
    displayFrame = null
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
      await registerObjectIconVariants(current, 'ambulance')
      await registerObjectIconVariants(current, 'hospital')
      await registerObjectIconVariants(current, 'crash')
      await registerObjectIconVariants(current, 'traffic')
      addOperationalMapSourcesAndLayers({
        map: current,
        objects,
        selectedControllerId,
        hasNewInfo,
        presentationFor,
        routeCasingColor: routeCasingColor(),
        trafficCasingColor: trafficCasingColor(),
        refreshSources,
      })
      addObjectInteractions(current)
      loaded = true
      lastRouteRevision = routeRevision
      lastSelectedControllerId = selectedControllerId
      refreshSources()
      if (!mapReadyNotified) {
        mapReadyNotified = true
        onMapReady()
      }
    } catch (err) {
      onMapError(err instanceof Error ? err.message : String(err))
    }
  }

  $effect(() => {
    if (mapInitialized || !mapElement) return
    mapInitialized = true
    const protocol = new PmtilesProtocol({ metadata: true })
    maplibregl.addProtocol('pmtiles', protocol.tile)
    pmtilesProtocolRegistered = true
    const current = new maplibregl.Map({
      container: mapElement,
      style: styleUrlFor(untrack(() => theme)),
      center: [10.7522, 59.9139],
      zoom: 12,
    })
    appliedTheme = untrack(() => theme)
    map = current
    current.on('error', (event) => {
      const error = event.error
      onMapError(error instanceof Error ? error.message : 'Vector map failed to load')
    })
    current.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
    current.on('click', (event) => {
      if (!placementMode) return
      onPlacementPoint(geoPointFromLonLat(event.lngLat.lng, event.lngLat.lat))
    })
    current.on('style.load', () => {
      void setupOperationalMapStyle(current)
    })
    current.on('load', () => {
      if (!loaded) void setupOperationalMapStyle(current)
    })

    return () => {
      if (refreshFrame !== null) cancelAnimationFrame(refreshFrame)
      stopDisplayAnimation()
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
    }
  })

  $effect(() => {
    objects
    selectedControllerId
    routeRevision
    renderRevision
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
    scheduleSourceRefresh({ objects: true, routes: routesChanged, traffic: true })
    refreshMarkerPopup(displayObjectsFor(objects, displayMotionState, nowMs))
    if (hasActiveDisplayMotion(displayMotionState, nowMs)) {
      scheduleDisplayAnimation()
    }
  })

  $effect(() => {
    placementCursor
    refreshCanvasCursor()
  })

  $effect(() => {
    layoutRevision
    map?.resize()
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
