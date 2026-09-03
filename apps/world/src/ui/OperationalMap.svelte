<script lang="ts">
  import 'maplibre-gl/dist/maplibre-gl.css'
  import { untrack } from 'svelte'
  import type {
    GeoJsonPoint,
    GeoJsonPolygon,
    IsoTimestamp,
    OperationalObject,
    SimulationClockState,
    MapLayerId,
    StartingMapView,
  } from '../core/model/index.ts'
  import { geoPointFromLonLat } from '../core/model/index.ts'
  import type {
    PackCreateObjectType,
    PackMapFeature,
    PackMapLayerGroup,
    PackObjectPresentation,
  } from '../core/packs/protocol.ts'
  import { createMapPopupController } from './map/map-popup-controller.ts'
  import type { MapInputDebugController } from './map/map-input-debug.ts'
  import { simulationTimeAt } from './simulation-clock.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import { readMapView, type MapView } from './map-view.ts'
  import type { ThemeMode } from './theme.ts'
  import { createMapRuntime } from './map-runtime/map-runtime.ts'
  import { createOperationalRenderController } from './map-runtime/operational-render-controller.ts'
  import { createPackOverlayController } from './map-runtime/pack-overlay-controller.ts'
  import { createPackFeatureLayer } from './map-runtime/pack-feature-layer.ts'
  import { createReferenceLayerController } from './map-runtime/reference-layer-controller.ts'
  import {
    installMapPerformanceDiagnosticsGlobal,
    mapPerformanceDiagnostics,
    startFrameLagMonitor,
  } from './map-runtime/map-performance-diagnostics.ts'
  import type {
    MapRuntimeDiagnosticsSnapshot,
    MapFocusRequest,
    MapRuntimeHandle,
  } from './map-runtime/types.ts'

  interface Props {
    readonly objects: ReadonlyArray<OperationalObject>
    readonly selectedControllerId: string | null
    readonly placementMode: PackCreateObjectType | null
    readonly placementCursor: { readonly icon: string; readonly color: string } | null
    readonly placementPoints: ReadonlyArray<GeoJsonPoint>
    readonly theme: ThemeMode
    readonly mapConfig: StartingMapView
    readonly clock?: SimulationClockState
    readonly routeRevision: number
    readonly debugMapInput?: boolean
    readonly highlightedObjectIds?: ReadonlyArray<string>
    readonly hiddenObjectCategoryIds?: ReadonlyArray<string>
    readonly hasNewInfo: (object: OperationalObject) => boolean
    readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
    readonly mapFeaturesFor: (context: {
      readonly viewport: GeoJsonPolygon
      readonly zoom: number
      readonly currentTime?: IsoTimestamp
      readonly signal?: AbortSignal
    }) => Promise<ReadonlyArray<PackMapFeature>>
    readonly onObjectSelected: (object: OperationalObject) => void
    readonly onPlacementPoint: (point: GeoJsonPoint) => void
    readonly onObjectSeen: (object: OperationalObject) => void
    readonly onMapReady: () => void
    readonly onMapView?: (view: MapView) => void
    readonly onMapError: (message: string) => void
    readonly onMapDiagnostic?: (snapshot: MapRuntimeDiagnosticsSnapshot) => void
    readonly simulationRunId?: string | null
    readonly activePackIds?: ReadonlyArray<string>
    readonly mapLayerGroups?: ReadonlyArray<PackMapLayerGroup>
    readonly mapLayerGroupVisibility?: Readonly<Record<string, boolean>>
    readonly referenceDatasetIds?: ReadonlyArray<string>
    readonly packFeatureLayers?: ReadonlyArray<MapLayerId>
    readonly packFeatureSourcePackIds?: ReadonlyArray<string>
    readonly focusRequest?: MapFocusRequest | null
    readonly packDataRevisionKey?: string
    readonly onPackFeatureSelected?: (selection: NonNullable<PackMapFeature['selection']>) => void
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
    mapFeaturesFor,
    onObjectSelected,
    onPlacementPoint,
    onObjectSeen,
    onMapReady,
    onMapView = () => {},
    onMapError,
    onMapDiagnostic = () => undefined,
    simulationRunId = null,
    activePackIds = [],
    mapLayerGroups = [],
    mapLayerGroupVisibility = {},
    referenceDatasetIds = [],
    packFeatureLayers = [],
    packFeatureSourcePackIds = [],
    focusRequest = null,
    packDataRevisionKey = '',
    onPackFeatureSelected = () => {},
  }: Props = $props()

  let mapElement = $state<HTMLDivElement | null>(null)
  let runtime = $state<MapRuntimeHandle | null>(null)
  let mapInputDebugEntries = $state<ReadonlyArray<string>>([])
  let mapInputDebugSummary = $state('Waiting for map input')
  let cachedPackMapFeatures = $state<ReadonlyArray<PackMapFeature>>([])
  const packFeatureLayer = createPackFeatureLayer(selection => { if (!placementMode) onPackFeatureSelected(selection) }, message => onMapError(message))
  const syncPackFeatures = () => { if (runtime) packFeatureLayer.update(runtime.map, cachedPackMapFeatures, visibleFamilies()) }
  let appliedTheme: ThemeMode | null = null
  let appliedCameraKey: string | null = null
  let appliedFocusRevision = -1
  let mapReadyNotified = false

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
      packFeatures: cachedPackMapFeatures,
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

  const cameraKeyFor = (config: StartingMapView): string => {
    const [lon, lat] = config.center.coordinates
    return `${lon}:${lat}:${config.zoom}`
  }

  $effect(() => {
    const request = focusRequest
    const current = runtime?.map
    if (!request || !current || request.revision === appliedFocusRevision) return
    appliedFocusRevision = request.revision
    if (request.target.kind === 'point') {
      current.flyTo({ center: [request.target.center[0], request.target.center[1]], zoom: Math.max(current.getZoom(), 9), duration: 650 })
      return
    }
    current.fitBounds(
      [[request.target.bounds[0][0], request.target.bounds[0][1]], [request.target.bounds[1][0], request.target.bounds[1][1]]],
      { padding: 80, maxZoom: 10, duration: 650 },
    )
  })

  const currentDisplayTime = (): IsoTimestamp | undefined =>
    simulationTimeAt(clock)

  const visibleFamilies = (): ReadonlySet<string> => {
    const enabled = new Set<string>()
    for (const layer of mapConfig.layers) {
      if (layer === 'weather' && !activePackIds.includes('weather')) continue
      if (layer === 'grid' && !activePackIds.includes('electric-grid')) continue
      enabled.add(layer)
    }
    return enabled
  }

  const mapLayerEnabled = (layer: MapLayerId): boolean =>
    visibleFamilies().has(layer)

  const packFeaturesEnabled = (): boolean =>
    packFeatureLayers.some(layer => mapLayerEnabled(layer))

  const currentViewport = (): GeoJsonPolygon | null => {
    const current = runtime?.map
    if (!current) return null
    const bounds = current.getBounds()
    const wholeWorld = bounds.getEast() - bounds.getWest() >= 360
    const wrap = (longitude: number) => ((longitude + 180) % 360 + 360) % 360 - 180
    const west = wholeWorld ? -180 : wrap(bounds.getWest())
    const east = wholeWorld ? 180 : wrap(bounds.getEast())
    const south = Math.max(-90, bounds.getSouth())
    const north = Math.min(90, bounds.getNorth())
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

  const packFeatureSourceRevisionKey = (): string => {
    const sourcePackIds = packFeatureSourcePackIds
    const includeAllPacks = sourcePackIds.length === 0 || sourcePackIds.includes('*')
    const relevantPackIds = includeAllPacks ? null : new Set(sourcePackIds)
    let count = 0
    let checksum = 0
    for (const object of objects) {
      if (relevantPackIds && !relevantPackIds.has(object.packId)) continue
      count += 1
      for (let index = 0; index < object.id.length; index += 1) {
        checksum = (checksum * 33 + object.id.charCodeAt(index)) >>> 0
      }
      checksum = (checksum * 33 + object.revision) >>> 0
    }
    return `${count}:${checksum}:${packDataRevisionKey}`
  }

  const packOverlayController = createPackOverlayController({
    getRuntime: () => runtime,
    getViewport: currentViewport,
    getCurrentTime: currentDisplayTime,
    getSourceRevisionKey: packFeatureSourceRevisionKey,
    enabled: packFeaturesEnabled,
    loadFeatures: context => mapFeaturesFor(context),
    setFeatures: features => {
      cachedPackMapFeatures = features
    },
    onError: message => {
      onMapError(message)
    },
    performanceDiagnostics: mapPerformanceDiagnostics,
  })

  const registerReferenceLayers = (): void => {
    const currentRuntime = runtime
    if (!currentRuntime) return
    referenceLayerController.register({
      runtime: currentRuntime,
      simulationRunId,
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

  runOnMount(() => {
    if (!mapElement) throw new Error('Operational map element was not bound before map initialization')
    let cancelled = false
    mapPerformanceDiagnostics.clear()
    const cleanupMapPerformanceGlobal = installMapPerformanceDiagnosticsGlobal()
    const stopFrameLagMonitor = startFrameLagMonitor(mapPerformanceDiagnostics)

    const initializeMap = async (): Promise<void> => {
      await installMapInputDebugController()
      if (cancelled || !mapElement) return
      const nextRuntime = await createMapRuntime({
        element: mapElement,
        styleUrl: styleUrlFor(theme),
        center: mapConfig.center,
        zoom: mapConfig.zoom,
        placementActive: () => placementMode !== null,
        onPlacementPoint,
        onMoveStart: () => {
          packOverlayController.setCameraGestureActive(true)
          packOverlayController.abort('map camera moved before pack map-area query completed')
          popupController.hide()
        },
        onMoveEnd: () => {
          if (runtime) onMapView(readMapView(runtime.map))
          packOverlayController.setCameraGestureActive(false)
          void packOverlayController.refresh()
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
      onMapView(readMapView(nextRuntime.map))
      appliedTheme = theme
      appliedCameraKey = cameraKeyFor(mapConfig)
      mapInputDebugController.install(nextRuntime.map)
      operationalRenderController.flushNow()
      notifyMapReady()
      registerReferenceLayers()
      packOverlayController.syncEnabled()
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
      packFeatureLayer.destroy()
      packOverlayController.destroy()
      popupController.hide()
      referenceLayerController.reset()
      runtime?.destroy()
      runtime = null
      appliedTheme = null
      appliedCameraKey = null
      mapReadyNotified = false
    }
  })

  $effect(() => {
    objects
    selectedControllerId
    highlightedObjectIds
    routeRevision
    untrack(() => operationalRenderController.syncObjects())
  })

  $effect(() => {
    hiddenObjectCategoryIds
    untrack(() => operationalRenderController.syncObjectVisibility())
  })

  $effect(() => {
    placementPoints
    untrack(() => operationalRenderController.syncPlacement())
  })

  $effect(() => {
    cachedPackMapFeatures
    untrack(() => { operationalRenderController.syncAreaFeatures(); syncPackFeatures() })
  })

  $effect(() => { packDataRevisionKey; untrack(() => { void packOverlayController.refresh() }) })

  $effect(() => {
    mapConfig.layers.join('|')
    activePackIds.join('|')
    packFeatureLayers.join('|')
    packFeatureSourcePackIds.join('|')
    untrack(() => {
      operationalRenderController.syncVisibility()
      packOverlayController.syncEnabled()
      syncPackFeatures()
    })
  })

  $effect(() => {
    const currentRuntime = runtime
    if (!currentRuntime || appliedTheme === null || theme === appliedTheme) return
    appliedTheme = theme
    packOverlayController.abort('map style changed before pack map-area query completed')
    popupController.hide()
    void (async (): Promise<void> => {
      try {
        await currentRuntime.setStyleUrl(styleUrlFor(theme))
        referenceLayerController.reset()
        registerReferenceLayers()
        operationalRenderController.flushNow()
        syncPackFeatures()
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
    simulationRunId
    untrack(() => registerReferenceLayers())
  })

  $effect(() => {
    mapLayerGroupVisibility
    untrack(() => referenceLayerController.applyVisibility(mapLayerGroupVisibility))
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
