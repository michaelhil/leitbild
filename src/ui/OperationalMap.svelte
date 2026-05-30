<script lang="ts">
  import 'maplibre-gl/dist/maplibre-gl.css'
  import { untrack } from 'svelte'
  import type {
    GeoJsonPoint,
    GeoJsonPolygon,
    IsoTimestamp,
    OperationalObject,
    SimulationClockState,
    SurfaceMapLayer,
    SurfaceMapRegionConfig,
  } from '../core/model/index.ts'
  import { geoPointFromLonLat } from '../core/model/index.ts'
  import type {
    PackCreateObjectType,
    PackMapAreaFeature,
    PackMapLayerGroup,
    PackObjectPresentation,
  } from '../core/packs/protocol.ts'
  import {
    createDisplayMotionState,
    displayObjectsFor,
    hasActiveDisplayMotion,
    reconcileDisplayMotionState,
    type DisplayMotionState,
  } from './display-motion.ts'
  import { createMapPopupController } from './map/map-popup-controller.ts'
  import type { MapInputDebugController } from './map/map-input-debug.ts'
  import {
    disabledSamsinnScreenshotConfig,
    fetchSamsinnScreenshotConfig,
  } from './samsinn-screenshot-config.ts'
  import type { SamsinnScreenshotConfig } from '../core/api/client-config.ts'
  import { simulationTimeAt } from './simulation-clock.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import type { ThemeMode } from './theme.ts'
  import { createMapFeatureStore } from './map-runtime/map-feature-store.ts'
  import { createMapLayerRegistry, type MapLayerRegistry } from './map-runtime/map-layer-registry.ts'
  import { createMapRuntime } from './map-runtime/map-runtime.ts'
  import { createMapUpdateScheduler } from './map-runtime/map-update-scheduler.ts'
  import { createOperationalDeckLayers } from './map-runtime/operational-deck-layers.ts'
  import type {
    MapRuntimeDiagnosticsSnapshot,
    MapRuntimeHandle,
    RenderFamily,
  } from './map-runtime/types.ts'

  interface Props {
    readonly objects: ReadonlyArray<OperationalObject>
    readonly selectedControllerId: string | null
    readonly placementMode: PackCreateObjectType | null
    readonly placementCursor: { readonly icon: string; readonly color: string } | null
    readonly placementPoints: ReadonlyArray<GeoJsonPoint>
    readonly theme: ThemeMode
    readonly mapConfig: SurfaceMapRegionConfig
    readonly clock?: SimulationClockState
    readonly routeRevision: number
    readonly debugMapInput?: boolean
    readonly highlightedObjectIds?: ReadonlyArray<string>
    readonly hasNewInfo: (object: OperationalObject) => boolean
    readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
    readonly mapAreaFeaturesFor: (context: {
      readonly viewport: GeoJsonPolygon
      readonly zoom: number
      readonly currentTime?: IsoTimestamp
      readonly signal?: AbortSignal
    }) => Promise<ReadonlyArray<PackMapAreaFeature>>
    readonly onObjectSelected: (object: OperationalObject) => void
    readonly onPlacementPoint: (point: GeoJsonPoint) => void
    readonly onObjectSeen: (object: OperationalObject) => void
    readonly onMapReady: () => void
    readonly onMapError: (message: string) => void
    readonly onMapDiagnostic?: (snapshot: MapRuntimeDiagnosticsSnapshot) => void
    readonly controlInstanceId?: string | null
    readonly activePackIds?: ReadonlyArray<string>
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
    onMapDiagnostic = () => undefined,
    controlInstanceId = null,
    activePackIds = [],
    mapLayerGroups = [],
    mapLayerGroupVisibility = {},
    referenceDatasetIds = [],
  }: Props = $props()

  let mapElement = $state<HTMLDivElement | null>(null)
  let runtime = $state<MapRuntimeHandle | null>(null)
  let mapInputDebugEntries = $state<ReadonlyArray<string>>([])
  let mapInputDebugSummary = $state('Waiting for map input')
  let cachedPackMapAreaFeatures = $state<ReadonlyArray<PackMapAreaFeature>>([])
  let displayMotionState: DisplayMotionState = createDisplayMotionState()
  let previousMotionObjects: ReadonlyArray<OperationalObject> = []
  let displayFrame: number | null = null
  let packAreaRefreshInterval: ReturnType<typeof setInterval> | null = null
  let packAreaFeatureRequestSerial = 0
  let packAreaFeatureRequestInFlight = false
  let packAreaFeatureRefreshQueued = false
  let packAreaFeatureAbortController: AbortController | null = null
  let mapCameraGestureActive = false
  let appliedTheme: ThemeMode | null = null
  let appliedCameraKey: string | null = null
  let mapReadyNotified = false
  let screenshotResponderCleanup: (() => void) | null = null
  let layerRegistry: MapLayerRegistry | null = null
  let referenceRegistrationSerial = 0
  let registeredReferenceKey: string | null = null

  const featureStore = createMapFeatureStore()
  const updateScheduler = createMapUpdateScheduler({ frameBudgetMs: 6 })

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
      getMap: () => runtime?.map ?? null,
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

  const popupController = createMapPopupController({
    getMap: () => runtime?.map ?? null,
    presentationFor: (object) => presentationFor(object),
    hasNewInfo: (object) => hasNewInfo(object),
  })

  const styleUrlFor = (mode: ThemeMode): string =>
    `/map/style.json?theme=${encodeURIComponent(mode)}`

  const cameraKeyFor = (config: SurfaceMapRegionConfig): string => {
    const [lon, lat] = config.center.coordinates
    return `${lon}:${lat}:${config.zoom}`
  }

  const currentDisplayTime = (): IsoTimestamp | undefined =>
    simulationTimeAt(clock)

  const visibleFamilies = (): ReadonlySet<string> => {
    const enabled = new Set<string>()
    for (const layer of mapConfig.layers) {
      if (layer === 'traffic' && !activePackIds.includes('traffic')) continue
      if (layer === 'weather' && !activePackIds.includes('weather')) continue
      if (layer === 'grid' && !activePackIds.includes('electric-grid')) continue
      enabled.add(layer)
    }
    return enabled
  }

  const mapLayerEnabled = (layer: SurfaceMapLayer): boolean =>
    visibleFamilies().has(layer)

  const currentViewport = (): GeoJsonPolygon | null => {
    const current = runtime?.map
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

  const isAbortError = (err: unknown): boolean =>
    err instanceof DOMException && err.name === 'AbortError'

  const abortPackAreaFeatureRequest = (reason: string): void => {
    if (!packAreaFeatureAbortController) return
    packAreaFeatureRequestSerial += 1
    packAreaFeatureAbortController.abort(new Error(reason))
    packAreaFeatureAbortController = null
  }

  const flushOperationalRender = (): void => {
    const currentRuntime = runtime
    if (!currentRuntime) return
    const nowMs = performance.now()
    const displayObjects = displayObjectsFor(objects, displayMotionState, nowMs)
    const snapshot = featureStore.update({
      objects: displayObjects,
      selectedControllerId,
      highlightedObjectIds,
      placementPoints,
      packAreaFeatures: cachedPackMapAreaFeatures,
      hasNewInfo,
      presentationFor,
    })
    currentRuntime.updateLayers({
      deckLayers: createOperationalDeckLayers({
        snapshot,
        visibleFamilies: visibleFamilies(),
        onObjectSelected: point => {
          onObjectSelected(point.object)
        },
        onObjectSeen: point => {
          onObjectSeen(point.object)
        },
        onObjectHover: point => {
          const canvas = runtime?.map.getCanvas()
          if (!point) {
            if (canvas) canvas.style.cursor = placementCursor ? 'crosshair' : ''
            popupController.hide()
            return
          }
          if (canvas) canvas.style.cursor = placementCursor ? 'crosshair' : 'pointer'
          onObjectSeen(point.object)
          popupController.show(point.object)
        },
      }),
    })
    popupController.refresh(displayObjects)
  }

  const scheduleOperationalRender = (
    family: RenderFamily,
    priority = 60,
    minIntervalMs = 0,
  ): void => {
    updateScheduler.schedule({
      family,
      priority,
      minIntervalMs,
      run: flushOperationalRender,
    })
  }

  const flushOperationalRenderNow = (): void => {
    scheduleOperationalRender('operational-points', 100)
    updateScheduler.flushNow()
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
      scheduleOperationalRender('operational-points', 85)
      if (hasActiveDisplayMotion(displayMotionState, nowMs)) {
        scheduleDisplayAnimation()
      }
    })
  }

  const stopPackAreaRefresh = (): void => {
    if (packAreaRefreshInterval === null) return
    clearInterval(packAreaRefreshInterval)
    packAreaRefreshInterval = null
  }

  const refreshPackMapAreaFeatures = async (): Promise<void> => {
    if (!mapLayerEnabled('weather')) {
      cachedPackMapAreaFeatures = []
      scheduleOperationalRender('operational-areas', 45)
      return
    }
    if (packAreaFeatureRequestInFlight) {
      packAreaFeatureRefreshQueued = true
      return
    }
    const current = runtime?.map
    const viewport = currentViewport()
    if (!current || !viewport) return

    const serial = ++packAreaFeatureRequestSerial
    const abortController = new AbortController()
    packAreaFeatureAbortController = abortController
    packAreaFeatureRequestInFlight = true
    try {
      const features = await mapAreaFeaturesFor({
        viewport,
        zoom: current.getZoom(),
        currentTime: currentDisplayTime(),
        signal: abortController.signal,
      })
      if (serial !== packAreaFeatureRequestSerial) return
      cachedPackMapAreaFeatures = features
      scheduleOperationalRender('operational-areas', 50)
    } catch (err) {
      if (serial !== packAreaFeatureRequestSerial || isAbortError(err)) return
      onMapError(err instanceof Error ? err.message : String(err))
    } finally {
      if (packAreaFeatureAbortController === abortController) {
        packAreaFeatureAbortController = null
      }
      packAreaFeatureRequestInFlight = false
      if (packAreaFeatureRefreshQueued) {
        packAreaFeatureRefreshQueued = false
        window.setTimeout(() => { void refreshPackMapAreaFeatures() }, 0)
      }
    }
  }

  const startPackAreaRefresh = (): void => {
    if (packAreaRefreshInterval !== null) return
    packAreaRefreshInterval = setInterval(() => {
      if (!mapLayerEnabled('weather') || mapCameraGestureActive) return
      void refreshPackMapAreaFeatures()
    }, 2_000)
  }

  const registerReferenceLayers = (): void => {
    const currentRuntime = runtime
    const registry = layerRegistry
    if (!currentRuntime || !registry) return
    const referenceKey = [
      controlInstanceId ?? 'no-control-instance',
      referenceDatasetIds.join(','),
      mapLayerGroups.map(group => `${group.id}:${group.layerIdPattern}:${group.defaultVisible}`).join(','),
    ].join('|')
    if (registeredReferenceKey === referenceKey) return
    registeredReferenceKey = referenceKey
    const serial = ++referenceRegistrationSerial
    registry.reset()
    if (referenceDatasetIds.length === 0 && mapLayerGroups.length === 0) return
    const run = async (): Promise<void> => {
      try {
        const registration = await registry.registerReferenceLayers({
          map: currentRuntime.map,
          datasetIds: referenceDatasetIds,
          layerGroups: mapLayerGroups,
          visibility: mapLayerGroupVisibility,
          logger: message => {
            console.warn(message)
          },
        })
        if (serial !== referenceRegistrationSerial) return
        currentRuntime.diagnostics()
        onMapDiagnostic({
          ...currentRuntime.diagnostics(),
          phases: currentRuntime.diagnostics().phases.map(phase =>
            phase.phase === 'reference'
              ? {
                  ...phase,
                  status: 'ready',
                  message: 'Reference layers registered',
                  completedAtMs: performance.now(),
                  details: [
                    { label: 'Sources', value: String(registration.sourceIds.length) },
                    { label: 'Layers', value: String(registration.layerIds.length) },
                  ],
                }
              : phase,
          ),
        })
      } catch (err) {
        onMapError(`Reference map overlay failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      window.requestIdleCallback(() => { void run() }, { timeout: 1_500 })
      return
    }
    window.setTimeout(() => { void run() }, 120)
  }

  const applyScenarioCameraDefault = (): void => {
    const current = runtime?.map
    if (!current) return
    const cameraKey = cameraKeyFor(mapConfig)
    if (cameraKey === appliedCameraKey) return
    appliedCameraKey = cameraKey
    current.jumpTo({
      center: mapConfig.center.coordinates,
      zoom: mapConfig.zoom,
    })
  }

  const notifyMapReady = (): void => {
    if (mapReadyNotified) return
    mapReadyNotified = true
    onMapReady()
  }

  const loadScreenshotConfig = async (): Promise<SamsinnScreenshotConfig> => {
    try {
      return await fetchSamsinnScreenshotConfig()
    } catch (err) {
      mapInputDebugController.record(`screenshot-config:failed:${err instanceof Error ? err.message : String(err)}`)
      return disabledSamsinnScreenshotConfig()
    }
  }

  runOnMount(() => {
    if (!mapElement) throw new Error('Operational map element was not bound before map initialization')
    let cancelled = false

    const initializeMap = async (): Promise<void> => {
      await installMapInputDebugController()
      if (cancelled || !mapElement) return
      const screenshotConfig = await loadScreenshotConfig()
      if (cancelled || !mapElement) return
      const nextRuntime = await createMapRuntime({
        element: mapElement,
        styleUrl: styleUrlFor(theme),
        center: mapConfig.center,
        zoom: mapConfig.zoom,
        preserveDrawingBuffer: screenshotConfig.enabled,
        placementActive: () => placementMode !== null,
        onPlacementPoint,
        onMoveStart: () => {
          mapCameraGestureActive = true
          abortPackAreaFeatureRequest('map camera moved before pack map-area query completed')
          popupController.hide()
        },
        onMoveEnd: () => {
          mapCameraGestureActive = false
          void refreshPackMapAreaFeatures()
        },
        onError: error => {
          onMapError(error.message)
        },
        onDiagnostics: onMapDiagnostic,
      })
      if (cancelled) {
        nextRuntime.destroy()
        return
      }
      runtime = nextRuntime
      layerRegistry = createMapLayerRegistry()
      appliedTheme = theme
      appliedCameraKey = cameraKeyFor(mapConfig)
      mapInputDebugController.install(nextRuntime.map)
      if (screenshotConfig.enabled) {
        const screenshotModule = await import('./samsinn-screenshot.ts')
        if (cancelled) {
          nextRuntime.destroy()
          return
        }
        screenshotResponderCleanup = screenshotModule.installSamsinnScreenshotResponder({
          enabled: screenshotConfig.enabled,
          allowedParentOrigins: screenshotConfig.allowedParentOrigins,
          maxDataUrlBytes: screenshotConfig.maxDataUrlBytes,
          capture: async options => screenshotModule.captureMapCanvasScreenshot(nextRuntime.map.getCanvas(), options),
        })
      }
      flushOperationalRenderNow()
      notifyMapReady()
      registerReferenceLayers()
      if (mapLayerEnabled('weather')) {
        void refreshPackMapAreaFeatures()
        startPackAreaRefresh()
      }
    }

    const runInitializeMap = async (): Promise<void> => {
      try {
        await initializeMap()
      } catch (err) {
        if (!cancelled) onMapError(err instanceof Error ? err.message : String(err))
      }
    }

    void runInitializeMap()

    return () => {
      cancelled = true
      resetMapInputDebugController()
      updateScheduler.stop()
      stopDisplayAnimation()
      stopPackAreaRefresh()
      abortPackAreaFeatureRequest('operational map was destroyed')
      popupController.hide()
      screenshotResponderCleanup?.()
      screenshotResponderCleanup = null
      referenceRegistrationSerial += 1
      registeredReferenceKey = null
      layerRegistry?.reset()
      layerRegistry = null
      runtime?.destroy()
      runtime = null
      appliedTheme = null
      appliedCameraKey = null
      mapReadyNotified = false
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
    scheduleOperationalRender('operational-points', 75)
    if (hasActiveDisplayMotion(displayMotionState, nowMs)) scheduleDisplayAnimation()
  })

  $effect(() => {
    placementPoints
    scheduleOperationalRender('placement', 70)
  })

  $effect(() => {
    cachedPackMapAreaFeatures
    scheduleOperationalRender('operational-areas', 55)
  })

  $effect(() => {
    mapConfig.layers
    activePackIds
    scheduleOperationalRender('operational-points', 65)
    if (!mapLayerEnabled('weather')) {
      abortPackAreaFeatureRequest('weather layer disabled')
      cachedPackMapAreaFeatures = []
      stopPackAreaRefresh()
      return
    }
    startPackAreaRefresh()
    untrack(() => { void refreshPackMapAreaFeatures() })
  })

  $effect(() => {
    const currentRuntime = runtime
    if (!currentRuntime || appliedTheme === null || theme === appliedTheme) return
    appliedTheme = theme
    abortPackAreaFeatureRequest('map style changed before pack map-area query completed')
    popupController.hide()
    void (async (): Promise<void> => {
      try {
        await currentRuntime.setStyleUrl(styleUrlFor(theme))
        registeredReferenceKey = null
        registerReferenceLayers()
        flushOperationalRenderNow()
      } catch (err) {
        onMapError(err instanceof Error ? err.message : String(err))
      }
    })()
  })

  $effect(() => {
    runtime
    mapConfig.center
    mapConfig.zoom
    applyScenarioCameraDefault()
  })

  $effect(() => {
    layerRegistry
    referenceDatasetIds
    mapLayerGroups
    controlInstanceId
    registerReferenceLayers()
  })

  $effect(() => {
    const registry = layerRegistry
    if (!registry) return
    mapLayerGroupVisibility
    registry.applyLayerGroupVisibility(mapLayerGroupVisibility)
  })
</script>

<div
  class="map"
  class:placing={placementCursor !== null}
  bind:this={mapElement}
></div>
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
