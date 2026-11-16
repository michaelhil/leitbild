<script lang="ts">
  import 'maplibre-gl/dist/maplibre-gl.css'
  import { untrack } from 'svelte'
  import type { EmbeddedViewListing } from '@leitbild/contracts'
  import type { PhysicalLayoutBinding, PhysicalLayoutMapInteraction } from './physical-layout/sources.ts'
  import type {
    GeoJsonPoint,
    GeoJsonPolygon,
    IsoTimestamp,
    SimulationRunId,
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
    PackMapFeatureQuery,
    PackObjectPresentation,
    PackTargetPreview,
  } from '../core/packs/protocol.ts'
  import type { PackReferenceDatasetStyle } from '../core/packs/reference-style.ts'
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
  import { createPackLiveLayerController, maplibreLiveMapPort, type PackLiveMapLayerBinding } from './map-runtime/pack-live-layer.ts'
  import { composeSymbolAtlas, loadMapSymbols, rasterizeSymbol } from './map-runtime/map-symbols.ts'
  import { createCatalogueSymbolAtlas } from './map-runtime/catalogue-symbol-atlas.ts'
  import type { Map as MapLibreMap } from 'maplibre-gl'
  import { clearCentreFor, panIntoClear, startingZoomFor, type CameraInteraction, type CameraPadding } from './map/map-camera.ts'
  import { noMapCover, type MapPrompt, type MapTargeting } from './surface-panel-interaction.ts'
  import type { MapCover } from './surface-panel-contract.ts'
  import { createMapPromptController } from './map/map-prompt.ts'
  import { createMapStackChooser } from './map/map-stack-chooser.ts'
  import { objectsUnder, stackPick } from './map/map-stack.ts'
  import { disksPickFor, hoverCardsFor, pickingRadiusFor } from './map/map-pointer.ts'
  import { operationalIconPx } from './map-runtime/symbol-kit.ts'
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
    MapTargetingLine,
    MapTargetingRender,
    Position3,
  } from './map-runtime/types.ts'

  interface Props {
    readonly objects: ReadonlyArray<OperationalObject>
    readonly selectedControllerId: string | null
    /** Whether the selected object is a controller, highlighted for an order: a tap on a stack then names a target. */
    readonly controllerHighlighted?: boolean
    /** Whether an object is one the screen orders: a stack holding exactly one, tapped while none is highlighted, picks it without the chooser. */
    readonly isController?: (object: OperationalObject) => boolean
    readonly placementMode: PackCreateObjectType | null
    readonly placementCursor: { readonly icon: string; readonly color: string } | null
    readonly placementPoints: ReadonlyArray<GeoJsonPoint>
    readonly theme: ThemeMode
    readonly mapConfig: StartingMapView
    readonly clock?: SimulationClockState | undefined
    readonly routeRevision: number
    readonly debugMapInput?: boolean
    readonly highlightedObjectIds?: ReadonlyArray<string>
    /** Objects the screen sees but may not order: drawn muted. */
    readonly mutedObjectIds?: ReadonlyArray<string>
    /** The open map-target panel's prompt of one or two buttons by a point, e.g. "Move here"; any map click dismisses it. */
    readonly prompt?: MapPrompt | null
    /** The operator dismissed the prompt without confirming: a map click elsewhere, its × or Esc. Once per prompt. */
    readonly onPromptDismissed: (prompt: MapPrompt) => void
    /**
     * The open map-target panel's armed order: halos on its targets, tags on
     * the nearest, every other object dimmed once the targets are complete,
     * and a line from its object to a mouse pointer (`MapTargeting`); null
     * while nothing is armed.
     */
    readonly targeting?: MapTargeting | null
    readonly hiddenObjectCategoryIds?: ReadonlyArray<string>
    readonly hasNewInfo: (object: OperationalObject) => boolean
    readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
    /**
     * What `presentationFor` depends on besides the object, such as the roles
     * the screen chose to see: a change draws every object again.
     */
    readonly presentationKey?: string
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
    readonly onFocusResult?: (revision: number, status: 'applied' | 'superseded') => void
    readonly onCameraGesture?: () => void
    readonly onMapError: (message: string) => void
    readonly onMapDiagnostic?: (snapshot: MapRuntimeDiagnosticsSnapshot) => void
    readonly simulationRunId?: string | null
    readonly mapLayerGroups?: ReadonlyArray<PackMapLayerGroup>
    readonly mapLayerGroupVisibility?: Readonly<Record<string, boolean>>
    readonly referenceStyles?: ReadonlyArray<PackReferenceDatasetStyle>
    readonly liveMapLayers?: ReadonlyArray<PackLiveMapLayerBinding>
    physicalLayoutControlsOpen?: boolean
    readonly physicalLayoutBindings?: ReadonlyArray<PhysicalLayoutBinding>
    readonly onPhysicalDisplay?: (listing: EmbeddedViewListing) => void
    readonly physicalLayoutSuspended: boolean
    readonly layoutClearTop?: number
    readonly queryLiveMapLayer?: (request: PackMapFeatureQuery, signal: AbortSignal) => Promise<unknown>
    /** The selected item per surface panel; live map layers highlight it. */
    readonly packSelections?: Readonly<Record<string, string | null>>
    readonly packFeatureLayers?: ReadonlyArray<MapLayerId>
    readonly packFeatureSourcePackIds?: ReadonlyArray<string>
    readonly focusRequest?: MapFocusRequest | null
    readonly cancelFocusRevision?: number | null
    readonly packDataRevisionKey?: string
    /** A role Run's perspective epoch: a hover card of an earlier one is never left showing. */
    readonly perspectiveEpoch?: number
    readonly onPackFeatureSelected?: (selection: NonNullable<PackMapFeature['selection']>) => void
    /** Camera gestures on or off; only an active Pack switches one off. */
    readonly cameraInteraction: CameraInteraction
    /** How far open surface panels reach over the map: the camera centres and fits clear of them, and so do the map's own controls. */
    readonly cameraPadding?: MapCover
    /**
     * Whether map taps pick targets for an order, so each must reach exactly
     * the object it lands on; the surface opts in while a panel takes map
     * targets (`map-target-routing.ts`, `targetPickingWanted`). A mouse click
     * on an icon's coloured disk then picks its object, not the ground
     * beneath, and a tap on several overlapping icons shows a chooser listing
     * them, so a site beneath the units parked on it can be reached. Off, the
     * map picks as it always has: the glyph's strokes, the top object.
     */
    readonly targetPicking?: boolean
    /** Reported only when given: a click on open ground, neither an object nor a Pack feature. */
    readonly onGroundSelected?: ((point: GeoJsonPoint) => void) | undefined
    /** The order preview a hovered object's card shows, when the selected controller's Pack describes targets. */
    readonly targetPreviewFor?: ((object: OperationalObject) => PackTargetPreview | null) | undefined
    /**
     * Objects a click opens a display or a closed map-target panel for: a
     * mouse click or hover anywhere on their coloured disk is theirs on every
     * surface, not only while the surface picks targets. Every other object's
     * disk picks as before. It answers by the object alone, so the icons are
     * not drawn again for it.
     */
    readonly takesDiskClicks?: (object: OperationalObject) => boolean
  }

  let {
    objects,
    selectedControllerId,
    controllerHighlighted = false,
    isController = () => false,
    placementMode,
    placementCursor,
    placementPoints,
    theme,
    mapConfig,
    clock,
    routeRevision,
    debugMapInput = false,
    highlightedObjectIds = [],
    mutedObjectIds = [],
    prompt = null,
    onPromptDismissed,
    targeting = null,
    hiddenObjectCategoryIds = [],
    hasNewInfo,
    presentationFor,
    presentationKey = '',
    mapFeaturesFor,
    onObjectSelected,
    onPlacementPoint,
    onObjectSeen,
    onMapReady,
    onMapView = () => {},
    onFocusResult = () => {},
    onCameraGesture = () => {},
    onMapError,
    onMapDiagnostic = () => undefined,
    simulationRunId = null,
    mapLayerGroups = [],
    mapLayerGroupVisibility = {},
    referenceStyles = [],
    liveMapLayers = [],
    physicalLayoutBindings = [],
    physicalLayoutControlsOpen = $bindable(false),
    onPhysicalDisplay = () => {},
    physicalLayoutSuspended,
    layoutClearTop = 0,
    queryLiveMapLayer = async () => { throw new Error('live map layers need a capability query') },
    packSelections = {},
    packFeatureLayers = [],
    packFeatureSourcePackIds = [],
    focusRequest = null,
    cancelFocusRevision = null,
    packDataRevisionKey = '',
    perspectiveEpoch = 0,
    onPackFeatureSelected = () => {},
    cameraInteraction,
    cameraPadding = noMapCover,
    targetPicking = false,
    onGroundSelected,
    targetPreviewFor,
    takesDiskClicks = () => false,
  }: Props = $props()

  let mapElement = $state<HTMLDivElement | null>(null)
  let runtime = $state<MapRuntimeHandle | null>(null)
  let mapInputDebugEntries = $state<ReadonlyArray<string>>([])
  let mapInputDebugSummary = $state('Waiting for map input')
  let cachedPackMapFeatures = $state<ReadonlyArray<PackMapFeature>>([])
  const packFeatureLayer = createPackFeatureLayer(selection => { clickHandled = true; featureSelection = selection }, message => onMapError(message))
  const syncPackFeatures = () => { if (runtime) packFeatureLayer.update(runtime.map, cachedPackMapFeatures, visibleFamilies()) }
  let appliedTheme: ThemeMode | null = null
  let cameraMoveStarted: { at: number; user: boolean } | null = null
  let pendingFocus: number | null = null
  let appliedCameraKey: string | null = null
  /** The camera still shows the Starting View: the operator has neither moved the camera nor clicked the map, nor has a focus request moved it. */
  let startingCamera = true
  let appliedFocusRevision = -1
  let mapReadyNotified = false
  let hoveredObject: OperationalObject | null = null
  /** The type of the last pointer seen on the canvas; hover cards and an armed order's line are for a mouse only (map-pointer.ts). */
  let lastPointerType: string | null = null
  /** How far around a press the map picks, for the last pointer seen: a mouse's 0 until a finger or a pen sets more. */
  let pickingRadius = 0
  /** Where the mouse is while an order is armed: the end of its line. */
  let linePointer = $state<GeoJsonPoint | null>(null)
  let lineRevision = $state(0)
  let lastPointerScreen = { x: 0, y: 0 }
  // Set while one map click is handled by an object or a Pack feature, so it is not also a ground click.
  let clickHandled = false
  // One click selects one thing: a Pack feature beneath an object's icon (a grid line under a Plant) is selected only when no object took the click.
  let objectTookClick = false
  let featureSelection: NonNullable<PackMapFeature['selection']> | null = null

  const targetingRender = $derived<MapTargetingRender | null>(targeting === null ? null : {
    fromId: targeting.from,
    complete: targeting.complete,
    targets: new Map(targeting.targets.map(target => [target.id as string, { tag: target.tag ?? null, refused: target.tone === 'refused' }])),
  })
  /** Whether a line follows the pointer: a panel's armed order while the pointer is a mouse. */
  const pointerLineWanted = (pointerType: string | null): boolean => targeting !== null && hoverCardsFor(pointerType)

  /** Where the line starts: the armed order's object, where its icon is drawn. */
  const lineAnchor = (): Position3 | null => {
    if (targeting === null || !hoverCardsFor(lastPointerType)) return null
    return operationalRenderController.points().find(point => point.id === targeting.from)?.position ?? null
  }

  /** The armed order's line to the mouse pointer. */
  const targetingLine = (): MapTargetingLine => {
    const anchor = lineAnchor()
    return {
      revision: lineRevision,
      anchor,
      pointer: anchor !== null && linePointer ? [linePointer.coordinates[0], linePointer.coordinates[1], 0] : null,
    }
  }

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

  const promptController = createMapPromptController({ getMap: () => runtime?.map ?? null, onDismiss: prompt => onPromptDismissed(prompt) })
  let physicalLayoutInteraction: PhysicalLayoutMapInteraction | null = null
  let detailedLayoutOwnerIds = $state.raw<ReadonlySet<string>>(new Set())
  const physicalMapPresentation = (object: OperationalObject): PackObjectPresentation => {
    const presentation = presentationFor(object)
    return detailedLayoutOwnerIds.has(object.id) ? { ...presentation, mapIconVisible: false } : presentation
  }
  const setDetailedLayoutOwners = (ids: ReadonlyArray<string>): void => {
    const next = new Set(ids)
    if (next.size !== detailedLayoutOwnerIds.size || [...next].some(id => !detailedLayoutOwnerIds.has(id))) detailedLayoutOwnerIds = next
  }
  const stackChooser = createMapStackChooser({ getMap: () => runtime?.map ?? null })

  /** The objects whose icons lie under the last press itself, while the surface picks targets. */
  const stackUnderPointer = (): ReadonlyArray<OperationalObject> => {
    const current = runtime
    if (!targetPicking || current === null) return []
    return objectsUnder(operationalRenderController.points(), position => current.map.project([position[0], position[1]]), lastPointerScreen)
  }

  const showStackChooser = (stack: ReadonlyArray<OperationalObject>): void => {
    const current = runtime
    if (current === null) return
    const point = current.map.unproject([lastPointerScreen.x, lastPointerScreen.y])
    stackChooser.show(geoPointFromLonLat(point.lng, point.lat), stack.map(object => ({
      id: object.id,
      label: presentationFor(object).mapLabel ?? object.label,
      choose: () => {
        onObjectSeen(object)
        onObjectSelected(object)
      },
    })))
  }

  const popupController = createMapPopupController({
    getMap: () => runtime?.map ?? null,
    presentationFor: (object) => presentationFor(object),
    hasNewInfo: (object) => hasNewInfo(object),
    targetPreviewFor: (object) => targetPreviewFor?.(object) ?? null,
    drawnAt: (object) => {
      const point = operationalRenderController.points().find(candidate => candidate.id === object.id)
      return point ? [point.position[0], point.position[1]] : null
    },
  })

  // Catalogue icons beyond the compiled atlas: artwork loads only when an object or Pack feature uses one.
  const catalogueAtlas = createCatalogueSymbolAtlas<ImageData>({
    loadArtwork: loadMapSymbols,
    rasterize: rasterizeSymbol,
    compose: composeSymbolAtlas,
    onChange: () => operationalRenderController.syncSymbolArtwork(),
    onError: message => onMapError(message),
  })

  const operationalRenderController = createOperationalRenderController({
    getRuntime: () => runtime,
    getState: () => ({
      objects,
      selectedControllerId,
      highlightedObjectIds,
      mutedObjectIds,
      targeting: targetingRender,
      alertPalette: theme === 'dark' ? 'dusk' : 'day',
      hiddenObjectCategoryIds,
      placementPoints,
      packFeatures: cachedPackMapFeatures,
      visibleFamilies: visibleFamilies(),
      placementCursorActive: placementCursor !== null,
      targetingLine: targetingLine(),
      disksPick: disksPickFor(targetPicking, pickingRadius),
      diskClicks: pickingRadius === 0 ? takesDiskClicks : null,
      presentationKey: `${presentationKey}|physical:${[...detailedLayoutOwnerIds].sort().join(',')}`,
    }),
    hasNewInfo: object => hasNewInfo(object),
    presentationFor: object => physicalMapPresentation(object),
    onObjectSelected: object => {
      clickHandled = true
      objectTookClick = true
      const stack = stackUnderPointer()
      if (stack.length > 1) {
        const picked = stackPick(stack, controllerHighlighted, isController)
        if (picked === null) return showStackChooser(stack)
        onObjectSeen(picked)
        return onObjectSelected(picked)
      }
      onObjectSelected(object)
    },
    onObjectSeen: object => onObjectSeen(object),
    onObjectHover: object => {
      hoveredObject = object
      if (object && hoverCardsFor(lastPointerType)) popupController.show(object)
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
    catalogueAtlas,
  })

  const referenceLayerController = createReferenceLayerController({
    onError: message => {
      onMapError(message)
    },
  })

  // The theme of the loaded style; null while a style change is loading.
  let liveStyleTheme: ThemeMode | null = null
  const liveLayerController = createPackLiveLayerController({
    query: (request, signal) => queryLiveMapLayer(request, signal),
    rasterize: rasterizeSymbol,
    active: () => !document.hidden,
    onSelect: selection => { clickHandled = true; featureSelection = selection },
    onHover: hover => { if (hover && hoverCardsFor(lastPointerType)) popupController.showCard(hover); else popupController.hide() },
    onError: message => onMapError(`Live map layer: ${message}`),
  })

  const liveLayerGroupVisible = (groupId: string): boolean => {
    const group = mapLayerGroups.find(candidate => candidate.id === groupId)
    if (!group) throw new Error(`live map layer group ${groupId} is not a declared Pack layer group`)
    return mapLayerGroupVisibility[groupId] ?? group.defaultVisible
  }

  const syncLiveLayers = (): void => {
    const currentRuntime = runtime
    if (!currentRuntime || liveStyleTheme === null) return
    try {
      liveLayerController.sync({
        map: maplibreLiveMapPort(currentRuntime.map),
        bindings: simulationRunId === null ? [] : liveMapLayers,
        objects,
        appearance: { theme: liveStyleTheme },
        groupVisible: liveLayerGroupVisible,
        referenceStyles,
        selections: packSelections,
      })
    } catch (err) {
      onMapError(`Live map layer: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

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
    if (request.revision === cancelFocusRevision) { appliedFocusRevision = request.revision; return }
    if (pendingFocus !== null) onFocusResult(pendingFocus, 'superseded')
    pendingFocus = null
    current.stop()
    pendingFocus = request.revision
    appliedFocusRevision = request.revision
    startingCamera = false
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650
    if (request.target.kind === 'view') {
      const container = current.getContainer()
      current.flyTo({ center: [...request.target.center], zoom: request.target.fitToAvailableArea ? startingZoomFor(request.target.zoom, { width: container.clientWidth, height: container.clientHeight }, cameraPadding) : request.target.zoom, bearing: request.target.bearing, padding: { ...cameraPadding }, duration })
      return
    }
    if (request.target.kind === 'point') {
      current.flyTo({ center: [request.target.center[0], request.target.center[1]], zoom: Math.max(current.getZoom(), 9), padding: { ...cameraPadding }, duration })
      return
    }
    current.fitBounds(
      [[request.target.bounds[0][0], request.target.bounds[0][1]], [request.target.bounds[1][0], request.target.bounds[1][1]]],
      { padding: { ...cameraPadding }, maxZoom: 10, duration },
    )
  })

  $effect(() => {
    const revision = cancelFocusRevision, current = runtime?.map
    if (revision === null || !current || pendingFocus !== revision) return
    // Cancel only this still-owned flight at its current position. A newer human or Home move wins.
    pendingFocus = null
    current.stop()
  })

  const currentDisplayTime = (): IsoTimestamp | undefined =>
    simulationTimeAt(clock)

  // The scenario compiler builds the Starting View layer list from the active
  // Packs' declared map feature layers, so it needs no Pack-id gate here.
  const visibleFamilies = (): ReadonlySet<string> => new Set(mapConfig.layers)

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
    active: () => !document.hidden,
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

  const syncViewportDemand = (): void => {
    packOverlayController.syncEnabled()
    syncLiveLayers()
  }

  const registerReferenceLayers = (): void => {
    const currentRuntime = runtime
    if (!currentRuntime) return
    referenceLayerController.register({
      runtime: currentRuntime,
      simulationRunId,
      styles: referenceStyles,
      appearance: { theme },
      layerGroups: mapLayerGroups,
      visibility: mapLayerGroupVisibility,
    })
  }

  /** The Starting View, fitted into the part of the map no panel covers. */
  const jumpToStartingView = (current: MapLibreMap): void => {
    const padding = { top: cameraPadding.top, right: cameraPadding.right, bottom: cameraPadding.bottom, left: cameraPadding.left }
    const container = current.getContainer()
    current.jumpTo({
      center: [mapConfig.center.coordinates[0], mapConfig.center.coordinates[1]],
      zoom: startingZoomFor(mapConfig.zoom, { width: container.clientWidth, height: container.clientHeight }, padding),
      padding,
    })
  }

  /** How far inside the clear part of the map the selected object stays when a panel's cover grows over it. */
  const selectionClearPx = 48

  /**
   * A panel's cover changed once the operator has taken the camera: the drawn
   * map stays where it is, so nothing under the pointer moves (plan B.1.3,
   * HF9), and the camera only pans, just far enough, when the selected object
   * would end up under the cover. It never re-fits.
   */
  const followCover = (current: MapLibreMap, padding: CameraPadding): void => {
    const applied = current.getPadding()
    if (applied.top === padding.top && applied.right === padding.right && applied.bottom === padding.bottom && applied.left === padding.left) return
    const container = current.getContainer()
    const size = { width: container.clientWidth, height: container.clientHeight }
    // The new padding centres the camera on what is drawn at the new clear centre now, so every pixel stays put.
    current.jumpTo({ center: current.unproject([...clearCentreFor(size, padding)]), padding: { ...padding } })
    const position = selectedControllerId === null ? undefined : operationalRenderController.points().find(point => point.id === selectedControllerId)?.position
    if (position === undefined) return
    const drawn = current.project([position[0], position[1]])
    const [x, y] = panIntoClear([drawn.x, drawn.y], size, padding, selectionClearPx)
    if (x === 0 && y === 0) return
    current.panBy([x, y], { duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250 })
  }

  const applyScenarioCameraDefault = (): void => {
    const current = runtime?.map
    if (!current) return
    const cameraKey = cameraKeyFor(mapConfig)
    if (cameraKey === appliedCameraKey) return
    appliedCameraKey = cameraKey
    startingCamera = true
    jumpToStartingView(current)
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
    let cleanupMapGestures = () => undefined

    const initializeMap = async (): Promise<void> => {
      await installMapInputDebugController()
      if (cancelled || !mapElement) return
      const nextRuntime = await createMapRuntime({
        element: mapElement,
        styleUrl: styleUrlFor(theme),
        center: mapConfig.center,
        zoom: mapConfig.zoom,
        cameraInteraction,
        placementActive: () => placementMode !== null,
        onPlacementPoint,
        onMapClick: point => {
          // This listener runs first; object, label and Pack feature clicks of the same event follow it
          // synchronously, because the deck overlay picks with pickAsync 'sync' (map-runtime.ts).
          // A double-click's extra object click leaves no mark on the next click.
          clickHandled = false
          objectTookClick = false
          featureSelection = null
          // After a click the camera stays where the operator saw it: a panel the click opens never re-fits the Starting View.
          startingCamera = false
          // Any click lets a stack's chooser go; an object click on a stack shows a new one.
          stackChooser.hide()
          // A click anywhere on the map dismisses the panel's prompt without confirming; its buttons stop their own clicks.
          promptController.dismiss()
          queueMicrotask(() => {
            const handled = clickHandled
            const feature = objectTookClick ? null : featureSelection
            clickHandled = false
            objectTookClick = false
            featureSelection = null
            if (handled) physicalLayoutInteraction?.dismiss()
            if (feature !== null && !placementMode) onPackFeatureSelected(feature)
            if (handled) return
            const captured = placementMode !== null || targetPicking || selectedControllerId !== null
            if (!captured && physicalLayoutInteraction?.activate(lastPointerScreen)) return
            onGroundSelected?.(point)
          })
        },
        onMoveStart: event => {
          cameraMoveStarted = { at: performance.now(), user: event.originalEvent !== undefined }
          if (event.originalEvent !== undefined) { startingCamera = false; onCameraGesture(); if (pendingFocus !== null) { onFocusResult(pendingFocus, 'superseded'); pendingFocus = null } }
          stackChooser.hide()
          packOverlayController.setCameraGestureActive(true)
          packOverlayController.abort('map camera moved before pack map-area query completed')
          popupController.hide()
        },
        onMoveEnd: () => {
          if (cameraMoveStarted !== null) { mapPerformanceDiagnostics.record('camera', 'moveend', performance.now() - cameraMoveStarted.at, { userGesture: cameraMoveStarted.user }); cameraMoveStarted = null }
          if (pendingFocus !== null) { onFocusResult(pendingFocus, 'applied'); pendingFocus = null }
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
      // Icons that would overlap fan out anew at each zoom step (point-declutter.ts).
      nextRuntime.map.on('zoom', () => operationalRenderController.syncZoom())
      const canvas = nextRuntime.map.getCanvas()
      // A finger picks objects within a 44 px target around the tap; a mouse only under it.
      const trackPointer = (pointerType: string) => {
        lastPointerType = pointerType
        const radius = pickingRadiusFor(pointerType, operationalIconPx)
        if (radius === pickingRadius) return
        pickingRadius = radius
        nextRuntime.setPickingRadius(radius)
        operationalRenderController.syncPicking()
      }
      const pointerPoint = (event: PointerEvent): GeoJsonPoint => {
        const rect = canvas.getBoundingClientRect()
        lastPointerScreen = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        const value = nextRuntime.map.unproject([lastPointerScreen.x, lastPointerScreen.y])
        return geoPointFromLonLat(value.lng, value.lat)
      }
      const onPointerDown = (event: PointerEvent) => {
        pointerPoint(event)
        trackPointer(event.pointerType)
        if (!hoverCardsFor(lastPointerType)) popupController.hide()
      }
      const onPointerMove = (event: PointerEvent) => {
        const point = pointerPoint(event)
        trackPointer(event.pointerType)
        if (!pointerLineWanted(event.pointerType)) return
        linePointer = point
        lineRevision += 1
      }
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        if (event.target instanceof Element && event.target.closest('[role="dialog"], dialog, input, textarea, select, [contenteditable="true"]')) return
        if (stackChooser.shown()) stackChooser.hide()
        else if (!promptController.dismiss() && !popupController.dismiss()) return
        event.preventDefault()
      }
      canvas.addEventListener('pointerdown', onPointerDown)
      canvas.addEventListener('pointermove', onPointerMove)
      window.addEventListener('keydown', onKeyDown)
      cleanupMapGestures = () => {
        canvas.removeEventListener('pointerdown', onPointerDown)
        canvas.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('keydown', onKeyDown)
      }
      onMapView(readMapView(nextRuntime.map))
      appliedTheme = theme
      appliedCameraKey = cameraKeyFor(mapConfig)
      mapInputDebugController.install(nextRuntime.map)
      operationalRenderController.flushNow()
      notifyMapReady()
      registerReferenceLayers()
      packOverlayController.syncEnabled()
      liveStyleTheme = theme
      syncLiveLayers()
    }

    const runInitializeMap = async (): Promise<void> => {
      try {
        await initializeMap()
      } catch (err) {
        if (!cancelled) onMapError(err instanceof Error ? err.message : String(err))
      }
    }

    void runInitializeMap()
    document.addEventListener('visibilitychange', syncViewportDemand)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', syncViewportDemand)
      liveLayerController.destroy()
      liveStyleTheme = null
      stopFrameLagMonitor()
      cleanupMapGestures()
      cleanupMapPerformanceGlobal()
      resetMapInputDebugController()
      operationalRenderController.destroy()
      catalogueAtlas.reset()
      packFeatureLayer.destroy()
      packOverlayController.destroy()
      popupController.hide()
      promptController.destroy()
      stackChooser.hide()
      referenceLayerController.reset()
      runtime?.destroy()
      runtime = null
      appliedTheme = null
      appliedCameraKey = null
      startingCamera = true
      mapReadyNotified = false
    }
  })

  $effect(() => {
    objects
    detailedLayoutOwnerIds
    selectedControllerId
    highlightedObjectIds
    mutedObjectIds
    targetingRender
    routeRevision
    theme
    untrack(() => operationalRenderController.syncObjects())
  })

  $effect(() => {
    targeting
    lineRevision
    untrack(() => {
      const canvas = runtime?.map.getCanvas()
      if (!pointerLineWanted(lastPointerType) && linePointer) {
        linePointer = null
        lineRevision += 1
      }
      if (canvas) canvas.style.cursor = placementCursor ? 'crosshair' : hoveredObject ? 'pointer' : ''
      operationalRenderController.syncInteraction()
    })
  })

  $effect(() => {
    hiddenObjectCategoryIds
    untrack(() => operationalRenderController.syncObjectVisibility())
  })

  $effect(() => {
    presentationKey
    untrack(() => operationalRenderController.syncPresentation())
  })

  $effect(() => {
    targetPicking
    untrack(() => {
      if (!targetPicking) stackChooser.hide()
      operationalRenderController.syncPicking()
    })
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
  $effect(() => { perspectiveEpoch; untrack(() => { hoveredObject = null; popupController.hide(); stackChooser.hide() }) })

  $effect(() => {
    mapConfig.layers.join('|')
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
    liveStyleTheme = null
    packOverlayController.abort('map style changed before pack map-area query completed')
    popupController.hide()
    void (async (): Promise<void> => {
      try {
        await currentRuntime.setStyleUrl(styleUrlFor(theme))
        referenceLayerController.reset()
        registerReferenceLayers()
        operationalRenderController.flushNow()
        syncPackFeatures()
        liveStyleTheme = appliedTheme
        syncLiveLayers()
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
    const shown = prompt
    if (!runtime) return
    untrack(() => promptController.show(shown))
  })

  $effect(() => {
    const interaction = cameraInteraction
    const currentRuntime = runtime
    if (!currentRuntime) return
    untrack(() => currentRuntime.setCameraInteraction(interaction))
  })

  $effect(() => {
    const { top, right, bottom, left } = cameraPadding
    const current = runtime?.map
    if (!current) return
    untrack(() => {
      // Until the operator moves the camera or clicks the map, it shows the whole Starting View clear of the panels.
      if (startingCamera) {
        jumpToStartingView(current)
        return
      }
      followCover(current, { top, right, bottom, left })
    })
  })

  $effect(() => {
    runtime
    referenceStyles
    mapLayerGroups
    simulationRunId
    untrack(() => registerReferenceLayers())
  })

  $effect(() => {
    mapLayerGroupVisibility
    untrack(() => referenceLayerController.applyVisibility(mapLayerGroupVisibility))
  })

  $effect(() => {
    objects
    liveMapLayers
    mapLayerGroups
    mapLayerGroupVisibility
    referenceStyles
    packSelections
    simulationRunId
    untrack(() => syncLiveLayers())
  })
</script>

<div
  class="map"
  class:placing={placementCursor !== null}
  style:--map-cover-right={`${cameraPadding.right}px`}
  style:--map-cover-left={`${cameraPadding.left}px`}
  bind:this={mapElement}
></div>
{#if runtime !== null && simulationRunId !== null && physicalLayoutBindings.length > 0}
  {#key runtime.map}
  {#key simulationRunId}
  {#await import('./physical-layout/PhysicalExplorer.svelte') then { default: PhysicalExplorer }}
    <PhysicalExplorer suspendPickingForNavigation={runtime.suspendPickingForNavigation} bind:controlsOpen={physicalLayoutControlsOpen} map={runtime.map} {objects} bindings={physicalLayoutBindings} hiddenCategoryIds={hiddenObjectCategoryIds}
      {presentationFor} runId={simulationRunId as SimulationRunId} {perspectiveEpoch} {theme} clearTop={layoutClearTop} reservedPadding={cameraPadding} onDetailedOwners={setDetailedLayoutOwners}
      suspended={physicalLayoutSuspended}
      onoverview={onObjectSelected} onopen={onPhysicalDisplay} onerror={onMapError} onconnect={interaction => physicalLayoutInteraction = interaction} />
  {:catch error}
    <p role="alert">Physical layouts cannot be shown: {error instanceof Error ? error.message : String(error)}</p>
  {/await}
  {/key}
  {/key}
{/if}
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

<style>
  /* The map's own controls and attribution stay clear of panels lying over the map's edges. */
  .map :global(.maplibregl-ctrl-top-right),
  .map :global(.maplibregl-ctrl-bottom-right) {
    right: var(--map-cover-right);
  }

  .map :global(.maplibregl-ctrl-top-left),
  .map :global(.maplibregl-ctrl-bottom-left) {
    left: var(--map-cover-left);
  }

  /* A panel's prompt: the × first, a rule, then the options (map-prompt.ts). */
  .map :global(.map-prompt-actions) {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px;
    border-radius: 10px;
    background: var(--panel);
  }

  .map :global(.map-prompt-actions > .map-popup-dismiss) {
    flex: none;
  }

  /* Side by side while both options fit, stacked otherwise; a label longer than the prompt wraps, never clips. */
  .map :global(.map-prompt-options) {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
    padding-left: 8px;
    border-left: 1px solid var(--border);
  }

  .map :global(.map-popup-dismiss) {
    justify-self: end;
    min-width: 44px;
    min-height: 44px;
    border: 0;
    border-radius: 8px;
    background: var(--panel);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }

  .map :global(.map-popup-dismiss:hover) {
    background: var(--panel-strong);
  }

  /* A panel's prompt at a point. */
  .map :global(.map-prompt .maplibregl-popup-content) {
    padding: 0;
    border-radius: 10px;
    background: transparent;
    box-shadow: 0 6px 18px rgba(16, 24, 40, .28);
  }

  /* The chooser of objects stacked under one tap: one button per object, each large enough to tap. */
  .map :global(.map-stack .maplibregl-popup-content) {
    padding: 4px;
    border-radius: 10px;
    background: var(--panel);
    box-shadow: 0 6px 18px rgba(16, 24, 40, .28);
  }

  .map :global(.map-stack-list) {
    display: grid;
    gap: 4px;
    max-height: min(45dvh, 360px);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .map :global(.map-stack-list .map-popup-dismiss) {
    position: sticky;
    top: 0;
  }

  .map :global(.map-stack-button) {
    min-width: 44px;
    min-height: 44px;
    padding: 8px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel-strong);
    color: var(--text);
    font: inherit;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
  }

  .map :global(.map-prompt-button) {
    flex-grow: 1;
    flex-shrink: 1;
    flex-basis: max-content;
    max-width: 100%;
    min-width: 44px;
    min-height: 44px;
    padding: 10px 16px;
    border: 1px solid var(--accent);
    border-radius: 10px;
    background: var(--accent);
    color: white;
    font: inherit;
    font-weight: 650;
    text-align: center;
    overflow-wrap: anywhere;
    cursor: pointer;
  }

  /* An option that drops work, such as "Now (drops C-3 · P3)". */
  .map :global(.map-prompt-button-warning) {
    border-color: var(--warning);
    background: var(--panel);
    color: var(--text);
    box-shadow: inset 4px 0 0 var(--warning);
  }
</style>
