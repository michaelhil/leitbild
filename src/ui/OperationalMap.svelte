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
  import { createMapRuntime } from './map-runtime/map-runtime.ts'
  import { createOperationalRenderController } from './map-runtime/operational-render-controller.ts'
  import { createReferenceLayerController } from './map-runtime/reference-layer-controller.ts'
  import {
    installMapPerformanceDiagnosticsGlobal,
    mapPerformanceDiagnostics,
    startFrameLagMonitor,
  } from './map-runtime/map-performance-diagnostics.ts'
  import type {
    MapRuntimeDiagnosticsSnapshot,
    MapRuntimeHandle,
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
    readonly hiddenObjectCategoryIds?: ReadonlyArray<string>
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
    hiddenObjectCategoryIds = [],
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

  const operationalRenderController = createOperationalRenderController({
    getRuntime: () => runtime,
    getState: () => ({
      objects,
      selectedControllerId,
      highlightedObjectIds,
      hiddenObjectCategoryIds,
      placementPoints,
      packAreaFeatures: cachedPackMapAreaFeatures,
      visibleFamilies: visibleFamilies(),
      placementCursorActive: placementCursor !== null,
    }),
    hasNewInfo: object => hasNewInfo(object),
    presentationFor: object => presentationFor(object),
    onObjectSelected: object => onObjectSelected(object),
    onObjectSeen: object => onObjectSeen(object),
    onObjectHover: object => {
      if (object) popupController.show(object)
      else popupController.hide()
    },
    setCursor: cursor => {
      const canvas = runtime?.map.getCanvas()
      if (canvas) canvas.style.cursor = cursor
    },
    refreshPopup: displayObjects => {
      popupController.refresh(displayObjects)
    },
    onDiagnostic: currentRuntime => {
      onMapDiagnostic(currentRuntime.diagnostics())
    },
    performanceDiagnostics: mapPerformanceDiagnostics,
  })

  const referenceLayerController = createReferenceLayerController({
    onError: message => {
      onMapError(message)
    },
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
      runtime?.reportDiagnosticPhase({
        phase: 'operational-static',
        status: 'ready',
        message: 'No pack area features active',
        details: [],
      })
      operationalRenderController.syncAreaFeatures()
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
    runtime?.reportDiagnosticPhase({
      phase: 'operational-static',
      status: 'running',
      message: 'Refreshing pack area features',
      details: [
        { label: 'Zoom', value: zoom.toFixed(2) },
      ],
    })
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
      runtime?.reportDiagnosticPhase({
        phase: 'operational-static',
        status: 'ready',
        message: 'Pack area features ready',
        details: [
          { label: 'Features', value: String(features.length) },
          { label: 'Zoom', value: zoom.toFixed(2) },
        ],
      })
      operationalRenderController.syncAreaFeatures()
    } catch (err) {
      if (serial !== packAreaFeatureRequestSerial || isAbortError(err)) return
      const message = err instanceof Error ? err.message : String(err)
      runtime?.reportDiagnosticPhase({
        phase: 'operational-static',
        status: 'failed',
        message,
        error: {
          phase: 'operational-static',
          message,
          recoverable: true,
        },
      })
      onMapError(message)
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
    if (!currentRuntime) return
    referenceLayerController.register({
      runtime: currentRuntime,
      controlInstanceId,
      datasetIds: referenceDatasetIds,
      layerGroups: mapLayerGroups,
      visibility: mapLayerGroupVisibility,
    })
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
      operationalRenderController.flushNow()
      notifyMapReady()
      registerReferenceLayers()
      if (mapLayerEnabled('weather')) {
        void refreshPackMapAreaFeatures()
        startPackAreaRefresh()
      } else {
        void refreshPackMapAreaFeatures()
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
      operationalRenderController.destroy()
      stopPackAreaRefresh()
      abortPackAreaFeatureRequest('operational map was destroyed')
      popupController.hide()
      screenshotResponderCleanup?.()
      screenshotResponderCleanup = null
      referenceLayerController.reset()
      runtime?.destroy()
      runtime = null
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
    operationalRenderController.syncObjects()
  })

  $effect(() => {
    hiddenObjectCategoryIds
    operationalRenderController.syncObjectVisibility()
  })

  $effect(() => {
    placementPoints
    operationalRenderController.syncPlacement()
  })

  $effect(() => {
    cachedPackMapAreaFeatures
    operationalRenderController.syncAreaFeatures()
  })

  $effect(() => {
    mapConfig.layers
    activePackIds
    operationalRenderController.syncVisibility()
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
        referenceLayerController.reset()
        registerReferenceLayers()
        operationalRenderController.flushNow()
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
    runtime
    referenceDatasetIds
    mapLayerGroups
    controlInstanceId
    registerReferenceLayers()
  })

  $effect(() => {
    mapLayerGroupVisibility
    referenceLayerController.applyVisibility(mapLayerGroupVisibility)
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
