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
  import { createOperationalDeckLayerFactory, visibleFamiliesKey } from './map-runtime/operational-deck-layers.ts'
  import {
    installMapPerformanceDiagnosticsGlobal,
    mapPerformanceDiagnostics,
    startFrameLagMonitor,
  } from './map-runtime/map-performance-diagnostics.ts'
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
  let packAreaFeatureRequestKey: string | null = null
  let packAreaFeatureCacheKey: string | null = null
  let mapCameraGestureActive = false
  let appliedTheme: ThemeMode | null = null
  let appliedCameraKey: string | null = null
  let mapReadyNotified = false
  let screenshotResponderCleanup: (() => void) | null = null
  let layerRegistry: MapLayerRegistry | null = null
  let referenceRegistrationSerial = 0
  let registeredReferenceKey: string | null = null
  let lastPerformanceDiagnosticAtMs = 0

  const featureStore = createMapFeatureStore()
  const updateScheduler = createMapUpdateScheduler({ frameBudgetMs: 6 })
  const deckLayerFactory = createOperationalDeckLayerFactory()
  let lastOperationalRenderSignature: string | null = null

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

  const createRenderPresentationFor = (): ((object: OperationalObject) => PackObjectPresentation) => {
    const cache = new Map<string, PackObjectPresentation>()
    return (object) => {
      const key = `${object.id}:${object.revision}`
      const cached = cache.get(key)
      if (cached) return cached
      const presentation = presentationFor(object)
      cache.set(key, presentation)
      return presentation
    }
  }

  const createRenderHasNewInfo = (): ((object: OperationalObject) => boolean) => {
    const cache = new Map<string, boolean>()
    return (object) => {
      const key = `${object.id}:${object.revision}`
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      const next = hasNewInfo(object)
      cache.set(key, next)
      return next
    }
  }

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

  const roundedKey = (value: number, digits: number): string =>
    value.toFixed(digits)

  const viewportKeyFor = (
    viewport: GeoJsonPolygon,
    zoom: number,
  ): string => {
    const coordinates = viewport.coordinates.flatMap(ring => ring)
    const west = Math.min(...coordinates.map(coordinate => coordinate[0]))
    const east = Math.max(...coordinates.map(coordinate => coordinate[0]))
    const south = Math.min(...coordinates.map(coordinate => coordinate[1]))
    const north = Math.max(...coordinates.map(coordinate => coordinate[1]))
    const digits = zoom < 7 ? 2 : zoom < 10 ? 3 : 4
    return [
      roundedKey(west, digits),
      roundedKey(south, digits),
      roundedKey(east, digits),
      roundedKey(north, digits),
    ].join(',')
  }

  const weatherObjectRevisionKey = (): string => {
    let count = 0
    let checksum = 0
    for (const object of objects) {
      if (object.packId !== 'weather') continue
      count += 1
      for (let index = 0; index < object.id.length; index += 1) {
        checksum = (checksum * 33 + object.id.charCodeAt(index)) >>> 0
      }
      checksum = (checksum * 33 + object.revision) >>> 0
    }
    return `${count}:${checksum}`
  }

  const timeBucketKey = (time: IsoTimestamp | undefined): string => {
    if (!time) return 'none'
    const epochMs = Date.parse(time)
    if (!Number.isFinite(epochMs)) return String(time)
    return String(Math.floor(epochMs / 2_000))
  }

  const packAreaFeatureKeyFor = (
    viewport: GeoJsonPolygon,
    zoom: number,
  ): string => [
    viewportKeyFor(viewport, zoom),
    String(Math.floor(zoom * 4) / 4),
    timeBucketKey(currentDisplayTime()),
    weatherObjectRevisionKey(),
  ].join('|')

  const isAbortError = (err: unknown): boolean =>
    err instanceof DOMException && err.name === 'AbortError'

  const abortPackAreaFeatureRequest = (reason: string): void => {
    if (!packAreaFeatureAbortController) return
    packAreaFeatureRequestSerial += 1
    packAreaFeatureAbortController.abort(new Error(reason))
    packAreaFeatureAbortController = null
    packAreaFeatureRequestKey = null
  }

  const flushOperationalRender = (): void => {
    const currentRuntime = runtime
    if (!currentRuntime) return
    const startedAtMs = performance.now()
    const nowMs = startedAtMs
    const displayObjects = mapPerformanceDiagnostics.measure(
      'operational-dynamic',
      'displayObjectsFor',
      () => displayObjectsFor(objects, displayMotionState, nowMs),
      { objects: objects.length },
    )
    const renderPresentationFor = createRenderPresentationFor()
    const renderHasNewInfo = createRenderHasNewInfo()
    const snapshot = mapPerformanceDiagnostics.measure(
      'operational-dynamic',
      'featureStore.update',
      () => featureStore.update({
        objects: displayObjects,
        selectedControllerId,
        highlightedObjectIds,
        placementPoints,
        packAreaFeatures: cachedPackMapAreaFeatures,
        hasNewInfo: renderHasNewInfo,
        presentationFor: renderPresentationFor,
      }),
      {
        objects: displayObjects.length,
        packAreaFeatures: cachedPackMapAreaFeatures.length,
      },
    )
    const families = visibleFamilies()
    const renderSignature = [
      snapshot.revisions.points,
      snapshot.revisions.paths,
      snapshot.revisions.areas,
      snapshot.revisions.areaSymbols,
      snapshot.revisions.placement,
      visibleFamiliesKey(families),
    ].join('|')
    const deckUpdated = renderSignature !== lastOperationalRenderSignature
    if (deckUpdated) {
      lastOperationalRenderSignature = renderSignature
      const deckLayers = mapPerformanceDiagnostics.measure(
        'operational-dynamic',
        'deckLayerFactory.createLayers',
        () => deckLayerFactory.createLayers({
          snapshot,
          visibleFamilies: families,
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
        {
          points: snapshot.points.length,
          paths: snapshot.paths.length,
          areas: snapshot.areas.length,
          areaSymbols: snapshot.areaSymbols.length,
          placementPoints: snapshot.placementPoints.length,
        },
      )
      mapPerformanceDiagnostics.measure(
        'operational-dynamic',
        'runtime.updateLayers',
        () => currentRuntime.updateLayers({ deckLayers }),
        { deckLayers: deckLayers.length },
      )
    }
    mapPerformanceDiagnostics.measure(
      'ui-overlay',
      'popupController.refresh',
      () => popupController.refresh(displayObjects),
      { objects: displayObjects.length },
    )
    const totalMs = performance.now() - startedAtMs
    mapPerformanceDiagnostics.record('operational-dynamic', 'flushOperationalRender total', totalMs, {
      points: snapshot.points.length,
      paths: snapshot.paths.length,
      areas: snapshot.areas.length,
      deckUpdated,
    })
    emitPerformanceDiagnostic()
  }

  const emitPerformanceDiagnostic = (): void => {
    const currentRuntime = runtime
    if (!currentRuntime) return
    const nowMs = performance.now()
    if (nowMs - lastPerformanceDiagnosticAtMs < 750) return
    lastPerformanceDiagnosticAtMs = nowMs
    onMapDiagnostic(currentRuntime.diagnostics())
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
      packAreaFeatureCacheKey = null
      packAreaFeatureRequestKey = null
      scheduleOperationalRender('operational-areas', 45)
      return
    }
    const current = runtime?.map
    const viewport = currentViewport()
    if (!current || !viewport) return
    const zoom = current.getZoom()
    const requestKey = packAreaFeatureKeyFor(viewport, zoom)
    if (packAreaFeatureCacheKey === requestKey) return
    if (packAreaFeatureRequestInFlight) {
      if (packAreaFeatureRequestKey === requestKey) return
      packAreaFeatureRefreshQueued = true
      return
    }

    const serial = ++packAreaFeatureRequestSerial
    const abortController = new AbortController()
    packAreaFeatureAbortController = abortController
    packAreaFeatureRequestKey = requestKey
    packAreaFeatureRequestInFlight = true
    try {
      const features = await mapPerformanceDiagnostics.measureAsync(
        'operational-static',
        'mapAreaFeaturesFor',
        async () => mapAreaFeaturesFor({
          viewport,
          zoom,
          currentTime: currentDisplayTime(),
          signal: abortController.signal,
        }),
        { zoom: Number(zoom.toFixed(2)) },
      )
      if (serial !== packAreaFeatureRequestSerial) return
      cachedPackMapAreaFeatures = features
      packAreaFeatureCacheKey = requestKey
      scheduleOperationalRender('operational-areas', 50)
    } catch (err) {
      if (serial !== packAreaFeatureRequestSerial || isAbortError(err)) return
      onMapError(err instanceof Error ? err.message : String(err))
    } finally {
      if (packAreaFeatureAbortController === abortController) {
        packAreaFeatureAbortController = null
      }
      if (packAreaFeatureRequestKey === requestKey) packAreaFeatureRequestKey = null
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
        const registration = await mapPerformanceDiagnostics.measureAsync(
          'reference',
          'registerReferenceLayers',
          async () => registry.registerReferenceLayers({
            map: currentRuntime.map,
            datasetIds: referenceDatasetIds,
            layerGroups: mapLayerGroups,
            visibility: mapLayerGroupVisibility,
            logger: message => {
              console.warn(message)
            },
          }),
          {
            datasetIds: referenceDatasetIds.length,
            layerGroups: mapLayerGroups.length,
          },
        )
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
    mapPerformanceDiagnostics.clear()
    const cleanupMapPerformanceGlobal = installMapPerformanceDiagnosticsGlobal()
    const stopFrameLagMonitor = startFrameLagMonitor(mapPerformanceDiagnostics)

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
      lastOperationalRenderSignature = null
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
      stopFrameLagMonitor()
      cleanupMapPerformanceGlobal()
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
      deckLayerFactory.reset()
      lastOperationalRenderSignature = null
      packAreaFeatureCacheKey = null
      packAreaFeatureRequestKey = null
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
      packAreaFeatureCacheKey = null
      packAreaFeatureRequestKey = null
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
        lastOperationalRenderSignature = null
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
