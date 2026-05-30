<script lang="ts">
  import 'maplibre-gl/dist/maplibre-gl.css'
  import { type Map as MapLibreMap } from 'maplibre-gl'
  import { untrack } from 'svelte'
  import type { GeoJsonPoint, GeoJsonPolygon, IsoTimestamp, OperationalObject, SimulationClockState, SurfaceMapRegionConfig } from '../core/model/index.ts'
  import { geoPointFromLonLat } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackMapAreaFeature, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { iconSvgDataUrl, type IconName } from './icons.ts'
  import {
    animatePackMapAreaFeatures,
    hasActivePackMapAreaFeatureAnimation,
    mapLayerIds,
  } from './map/map-features.ts'
  import { registerObjectIconVariants } from './map-icon-registry.ts'
  import { addOperationalMapSourcesAndLayers } from './map/map-layer-setup.ts'
  import { simulationTimeAt } from './simulation-clock.ts'
  import {
    createDisplayMotionState,
    displayObjectsFor,
    hasActiveDisplayMotion,
    reconcileDisplayMotionState,
    type DisplayMotionState,
  } from './display-motion.ts'
  import { assertCameraInteractionContract } from './map/map-camera.ts'
  import type { MapInputDebugController } from './map/map-input-debug.ts'
  import { applyConfiguredMapLayerVisibility } from './map/map-layer-visibility.ts'
  import { createMapLifecycle, type MapLifecycle } from './map/map-lifecycle.ts'
  import { addObjectInteractions as addMapObjectInteractions } from './map/map-object-interactions.ts'
  import { createMapPopupController } from './map/map-popup-controller.ts'
  import { createMapSourceController } from './map/map-source-controller.ts'
  import {
    fetchSamsinnScreenshotConfig,
    disabledSamsinnScreenshotConfig,
    type SamsinnScreenshotConfig,
  } from './samsinn-screenshot-config.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import type { ThemeMode } from './theme.ts'
  import type { PackMapLayerGroup } from '../core/packs/protocol.ts'
  import {
    createReferenceDataController,
    type ReferenceDatasetController,
  } from './map/reference-data-controller.ts'
  import {
    createPackLayerGroupController,
    type PackLayerGroupController,
  } from './map/pack-layer-group-controller.ts'

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
    readonly controlInstanceId?: string | null
    readonly mapLayerGroups?: ReadonlyArray<PackMapLayerGroup>
    readonly mapLayerGroupVisibility?: Readonly<Record<string, boolean>>
    readonly referenceDatasetIds?: ReadonlyArray<string>
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
    controlInstanceId = null,
    mapLayerGroups = [],
    mapLayerGroupVisibility = {},
    referenceDatasetIds = [],
  }: Props = $props()

  let mapElement = $state<HTMLDivElement | null>(null)
  let map = $state<MapLibreMap | null>(null)
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
  let packAreaFeatureRequestInFlight = false
  let packAreaFeatureRefreshQueued = false
  let cachedPackMapAreaFeatures = $state<ReadonlyArray<PackMapAreaFeature>>([])
  let objectInteractionsAdded = false
  let mapReadyNotified = false
  let appliedTheme: ThemeMode | null = null
  let mapInitialized = false
  let appliedCameraKey: string | null = null
  let mapCameraGestureActive = false
  let mapLifecycle: MapLifecycle | null = null
  let screenshotResponderCleanup: (() => void) | null = null
  let mapInputDebugEntries = $state<ReadonlyArray<string>>([])
  let mapInputDebugSummary = $state('Waiting for map input')
  let referenceController = $state<ReferenceDatasetController | null>(null)
  let packLayerGroupController = $state<PackLayerGroupController | null>(null)
  const createNoopMapInputDebugController = (): MapInputDebugController => ({
    install: () => undefined,
    record: () => undefined,
    stop: () => undefined,
  })

  let mapInputDebugController: MapInputDebugController = createNoopMapInputDebugController()

  const installMapInputDebugController = async (): Promise<void> => {
    if (!debugMapInput) return
    const module = await import('./map/map-input-debug.ts')
    mapInputDebugController.stop()
    mapInputDebugController = module.createMapInputDebugController({
      enabled: () => debugMapInput,
      getMap: () => map,
      setSummary: (summary) => {
        mapInputDebugSummary = summary
      },
      appendEntry: (entry) => {
        mapInputDebugEntries = [...mapInputDebugEntries.slice(-17), entry]
      },
    })
  }

  const resetMapInputDebugController = (): void => {
    mapInputDebugController.stop()
    mapInputDebugController = createNoopMapInputDebugController()
  }

  const interactiveObjectLayerIds = [
    mapLayerIds.objectHitArea,
    mapLayerIds.objectIcons,
    mapLayerIds.objectHalos,
    mapLayerIds.objectNewInfo,
  ]

  const popupController = createMapPopupController({
    getMap: () => map,
    presentationFor: (object) => presentationFor(object),
    hasNewInfo: (object) => hasNewInfo(object),
  })

  const applyConfiguredLayerVisibility = (): void => {
    const current = map
    if (!current || !loaded) return
    applyConfiguredMapLayerVisibility({ map: current, enabledLayers: mapConfig.layers })
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
    if (packAreaFeatureRequestInFlight) {
      packAreaFeatureRefreshQueued = true
      return
    }
    const current = map
    const viewport = currentViewport()
    if (!current || !viewport) {
      cachedPackMapAreaFeatures = []
      return
    }
    const serial = ++packAreaFeatureRequestSerial
    packAreaFeatureRequestInFlight = true
    try {
      const features = await mapAreaFeaturesFor({ viewport, zoom: current.getZoom(), currentTime: currentDisplayTime() })
      if (serial !== packAreaFeatureRequestSerial) return
      cachedPackMapAreaFeatures = features
      sourceController.schedule({ weather: true })
      schedulePackAreaFeatureAnimation()
    } catch (err) {
      onMapError(err instanceof Error ? err.message : String(err))
    } finally {
      packAreaFeatureRequestInFlight = false
      if (packAreaFeatureRefreshQueued) {
        packAreaFeatureRefreshQueued = false
        window.setTimeout(() => { void refreshPackMapAreaFeatures() }, 0)
      }
    }
  }

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
      popupController.refresh(sourceObjects)
    },
  })

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
      popupController.refresh(displayObjects)
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

  const addObjectInteractions = (current: MapLibreMap): void => {
    if (objectInteractionsAdded) return
    addMapObjectInteractions({
      map: current,
      layerIds: interactiveObjectLayerIds,
      objects: () => objects,
      placementCursorActive: () => placementCursor !== null,
      placementCursorCss,
      refreshCanvasCursor,
      onObjectSelected,
      onObjectSeen,
      onRenderRevision: () => {
        renderRevision += 1
      },
      showPopup: popupController.show,
      hidePopup: popupController.hide,
    })
    objectInteractionsAdded = true
  }

  const setupOperationalMapStyle = async (current: MapLibreMap): Promise<void> => {
    try {
      mapInputDebugController.record('style:setup-start')
      loaded = false
      assertCameraInteractionContract(current)
      await Promise.all([
        registerObjectIconVariants(current, 'ambulance'),
        registerObjectIconVariants(current, 'hospital'),
        registerObjectIconVariants(current, 'crash'),
        registerObjectIconVariants(current, 'traffic'),
        registerObjectIconVariants(current, 'weather'),
        registerObjectIconVariants(current, 'plant'),
        registerObjectIconVariants(current, 'aircraft'),
        registerObjectIconVariants(current, 'grid'),
      ])
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
      // Reference-data layers are inserted between the OSM base and the
      // operational layer stack so airspace / airport context renders below
      // routes, weather influences, and operational objects.
      // Reference datasets (e.g. airspace + airports) get their source + layers
      // registered here. Visibility now flows through the pack rail's layer-group
      // controller — there is no free-floating panel any more.
      try {
        referenceController = await createReferenceDataController({
          map: current,
          beforeLayerId: mapLayerIds.weatherBaseGridOutline,
          datasetIds: referenceDatasetIds,
        })
      } catch (err) {
        console.warn('reference-data registration failed:', err)
      }
      if (mapLayerGroups.length > 0) {
        packLayerGroupController = createPackLayerGroupController({
          map: current,
          packs: [{
            // Wrap the supplied groups in a minimal "synthetic pack" — the
            // controller only reads mapLayerGroups, so the rest can be stubs.
            id: 'mapsurface-aggregate',
            name: 'MapSurface aggregate',
            categories: [],
            createObjectTypes: [],
            presentObject: () => { throw new Error('not used') },
            defaultObjectLabel: () => 'unused',
            buildCreateObjectCommand: () => { throw new Error('not used') },
            isController: () => false,
            isTarget: () => false,
            buildSetTargetCommand: () => { throw new Error('not used') },
            buildCancelTargetCommand: () => { throw new Error('not used') },
            mapLayerGroups,
          }],
        })
        packLayerGroupController.apply({ ...packLayerGroupController.defaults, ...mapLayerGroupVisibility })
      }
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
    let cancelled = false

    const initializeMap = async (): Promise<void> => {
      await installMapInputDebugController()
      if (cancelled) return
      let screenshotConfig: SamsinnScreenshotConfig = disabledSamsinnScreenshotConfig()
      try {
        screenshotConfig = await fetchSamsinnScreenshotConfig()
      } catch (err) {
        onMapError(err instanceof Error ? err.message : String(err))
      }
      if (cancelled || !mapElement) return

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
        preserveDrawingBuffer: screenshotConfig.enabled,
      })
      if (cancelled) {
        lifecycle.destroy()
        return
      }
      mapLifecycle = lifecycle
      const current = lifecycle.map
      if (screenshotConfig.enabled) {
        const screenshotModule = await import('./samsinn-screenshot.ts')
        if (cancelled) {
          lifecycle.destroy()
          return
        }
        screenshotResponderCleanup = screenshotModule.installSamsinnScreenshotResponder({
          enabled: screenshotConfig.enabled,
          allowedParentOrigins: screenshotConfig.allowedParentOrigins,
          maxDataUrlBytes: screenshotConfig.maxDataUrlBytes,
          capture: async options => screenshotModule.captureMapCanvasScreenshot(current.getCanvas(), options),
        })
      }
      mapInputDebugController.install(current)
      appliedTheme = theme
      appliedCameraKey = cameraKeyFor(mapConfig)
      map = current
    }

    void initializeMap()

    return () => {
      cancelled = true
      resetMapInputDebugController()
      sourceController.stop()
      stopDisplayAnimation()
      stopPackAreaFeatureAnimation()
      stopPackAreaRefresh()
      popupController.hide()
      screenshotResponderCleanup?.()
      screenshotResponderCleanup = null
      mapLifecycle?.destroy()
      mapLifecycle = null
      map = null
      loaded = false
      referenceController = null
      packLayerGroupController = null
      objectInteractionsAdded = false
      mapReadyNotified = false
      mapInitialized = false
      appliedCameraKey = null
      mapCameraGestureActive = false
      packAreaFeatureRequestInFlight = false
      packAreaFeatureRefreshQueued = false
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
    popupController.refresh(displayObjectsFor(objects, displayMotionState, nowMs))
    if (hasActiveDisplayMotion(displayMotionState, nowMs)) {
      scheduleDisplayAnimation()
    }
    untrack(() => {
      schedulePackAreaFeatureAnimation()
    })
  })

  $effect(() => {
    clock
    if (!mapConfig.layers.includes('weather') || mapCameraGestureActive) return
    untrack(() => {
      schedulePackAreaFeatureAnimation()
    })
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
      popupController.hide()
      current.setStyle(styleUrlFor(theme))
    }
  })

  // Pack-rail layer-group visibility. Re-applies whenever the rail-side state
  // map changes (toggles, scenario overrides, control-instance switch).
  $effect(() => {
    const controller = packLayerGroupController
    if (!controller || !loaded) return
    controller.apply({ ...controller.defaults, ...mapLayerGroupVisibility })
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
