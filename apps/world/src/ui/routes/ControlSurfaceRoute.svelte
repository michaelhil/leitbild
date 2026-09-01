<script lang="ts">
  import type { Component } from 'svelte'
  import { tick, untrack } from 'svelte'
  import type {
    IsoTimestamp,
    OperationalObject,
    SimulationRunId,
    ObjectId,
    ProcedureDocument,
    ProcedureId,
    ProcedureRunScope,
    ProcedureRunState,
    ProcedureStepId,
    ScenarioDefinition,
    ScenarioExecutionState,
    SimulationClockState,
  } from '../../core/model/index.ts'
  import { deleteObjectCommandKind } from '../../core/model/index.ts'
  import { createPackPresentationComposer } from '../../core/packs/presentation-composer.ts'
  import type { PackCreateObjectType, PackObjectPresentation, PackObjectPresentationTier, PackObjectStatusPresentation, PackPresentationContribution } from '../../core/packs/protocol.ts'
  import type { ActivePackViews } from '../../core/packs/active-views.ts'
  import {
    fetchScenario,
    joinSimulationRun as joinSimulationRunClient,
    resetSimulationRun,
    sendSimulationRunCommand,
    setSimulationRunClock,
    syncSimulationRunSnapshot as syncSimulationRunSnapshotClient,
  } from '../simulation-run-client.ts'
  import {
    parseControlSurfaceRoute,
  } from '../simulation-run-route.ts'
  import {
    applySimulationRunEventBatchMessage,
  } from '../simulation-run-events.ts'
  import { parseDroneMotionFramesRealtimeMessage, type DroneMotionFrame } from '../../packs/drone/realtime.ts'
  import { createMapAreaFeatureLoader } from '../app/map-area-feature-loader.ts'
  import { installPlacementGlobalEvents } from '../app/placement-global-events.ts'
  import { createRealtimeConnectionController } from '../app/realtime-connection.ts'
  import { completeControlSurfaceStartupFromSnapshot } from '../app/control-surface-session.ts'
  import { loadActivePackViews } from '../pack-loader.ts'
  import {
    categoryRowsFor,
    placementCursorFor,
    selectedControllerObjectFor,
  } from '../control-surface-selectors.ts'
  import { createPlacementState } from '../placement-state.svelte.ts'
  import { createRailLayoutState } from '../rail-layout-state.svelte.ts'
  import { simulationTimeAt } from '../simulation-clock.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import ControlRail from '../ControlRail.svelte'
  import ScenarioGuidance from '../ScenarioGuidance.svelte'
  import StartupModal from '../StartupModal.svelte'
  import { processPlantIdForObject, type ProcessPlantArtifactKind } from '../process-display/process-display-client.ts'
  import { readProcedureDocument, readProcedureRuns } from '../procedures/procedure-client.ts'
  import {
    procedureCurrentStep,
    procedureRunSummariesForScope,
    type ProcedureRunSummary,
    type ProcedureRunSummaryGroup,
  } from '../procedures/procedure-run-selectors.ts'
  import type { StatusTone } from '../components/StatusDot.svelte'
  import {
    categoryRowsForSurface,
    surfaceHasPrimitive,
    surfaceMapConfig,
    surfaceObjectRailConfig,
  } from '../surface.ts'
  import { getTheme, initialTheme, toggleTheme as toggleThemeMode, type ThemeMode } from '../theme.ts'
  import {
    completeStartupStep,
    createStartupSteps,
    failStartupStep,
    resetStartupStepsAfter,
    setStartupStepDetails,
    startupHasFailed,
    startupIsReady,
    startupModalShouldShow,
    startStartupStep,
    type StartupStep,
    type StartupStepId,
  } from '../startup.ts'
  import { runtimeDiagnosticDetails } from '../map-runtime/map-diagnostics.ts'
  import { mapPerformanceDiagnostics } from '../map-runtime/map-performance-diagnostics.ts'
  import type { MapRuntimeDiagnosticsSnapshot } from '../map-runtime/types.ts'
  import {
    browserDiagnostics,
    clearPackQueryDiagnostics,
    createLongTaskDiagnosticsMonitor,
    installInternalDiagnosticsGlobal,
    packQueryDiagnostics,
    resourceDiagnostics,
    routeDiagnostics,
    scenarioDiagnosticsFor,
    type InternalDiagnosticsSnapshot,
    type LongTaskDiagnosticsMonitor,
  } from '../internal-diagnostics.ts'
  import type { CategoryRow, SimulationRunResponse, CreateDraft } from '../types.ts'

  const appVersion = __LEITBILD_VERSION__
  const gridOverviewCategoryId = 'grid-system'
  const emptyStringArray: ReadonlyArray<string> = []
  const emptyMapLayerGroups: NonNullable<PackPresentationContribution['mapLayerGroups']> = []
  const emptyMapAreaFeatureLayers: NonNullable<PackPresentationContribution['mapAreaFeatureLayers']> = []
  const emptyProcedureRunSummaries: ProcedureRunSummaryGroup = { active: [], completed: [] }

  interface ProcessDisplayWindowEntry {
    readonly id: string
    readonly objectId: ObjectId
  }

  interface DroneWindowEntry {
    readonly id: string
    readonly objectId: ObjectId
  }

  type DroneMotionFrameConsumer = (frames: ReadonlyArray<DroneMotionFrame>) => void

  interface ProcedureSystemWindowEntry {
    readonly id: string
    readonly objectId: ObjectId
    readonly initialProcedureId?: ProcedureId
    readonly initialStepId?: ProcedureStepId
    readonly initialNavigationRevision: number
  }

  interface ProcessDisplayWindowModel extends ProcessDisplayWindowEntry {
    readonly object: OperationalObject
    readonly index: number
  }

  interface DroneWindowModel extends DroneWindowEntry {
    readonly object: OperationalObject
    readonly index: number
  }

  interface ProcedureSystemWindowModel extends ProcedureSystemWindowEntry {
    readonly object: OperationalObject
    readonly plantId: string
    readonly index: number
  }
  let activePack = $state<ActivePackViews | null>(null)
  let simulationRunId = $state<SimulationRunId | null>(null)
  let objects = $state<OperationalObject[]>([])
  let scenarioState = $state<ScenarioExecutionState | undefined>(undefined)
  let clock = $state<SimulationClockState | undefined>(undefined)
  let scenarioDefinition = $state<ScenarioDefinition | null>(null)
  let selectedControllerId = $state<string | null>(null)
  let status = $state('Starting')
  let commandStatus = $state('')
  const routeMode = 'simulation-run'
  let seenRevisions = $state(new Map<string, number>())
  let expectedRealtimeScenarioId = $state<string | null>(null)
  let realtimeAttached = $state(false)
  let routeRevision = $state(0)
  let procedureRevision = $state(0)
  let startupSteps = $state<ReadonlyArray<StartupStep>>(createStartupSteps())
  let mapReady = $state(false)
  let snapshotReady = $state(false)
  let startupDismissed = $state(false)
  let startupStatusModalOpen = $state(false)
  let settingsModalOpen = $state(false)
  let OperationalMap = $state<Component | null>(null)
  let CreateObjectModal = $state<Component | null>(null)
  let SettingsModal = $state<Component | null>(null)
  let ProcessDisplayModal = $state<Component | null>(null)
  let GridOverviewPanel = $state<Component | null>(null)
  let ProcedureSystemModal = $state<Component | null>(null)
  let ProcessPlantArtifactModal = $state<Component | null>(null)
  let ProcessPlantCatalogModal = $state<Component | null>(null)
  let ProcessPlantCredibilityModal = $state<Component | null>(null)
  let DroneControlModal = $state<Component | null>(null)
  let DroneProfileEditorModal = $state<Component | null>(null)
  let processDisplayWindows = $state<ReadonlyArray<ProcessDisplayWindowEntry>>([])
  let droneControlWindows = $state<ReadonlyArray<DroneWindowEntry>>([])
  let droneProfileEditorWindows = $state<ReadonlyArray<DroneWindowEntry>>([])
  let procedureSystemWindows = $state<ReadonlyArray<ProcedureSystemWindowEntry>>([])
  let floatingWindowSequence = 0
  let procedureRuns = $state<ReadonlyArray<ProcedureRunState>>([])
  let procedureRunDocuments = $state<ReadonlyMap<ProcedureId, ProcedureDocument>>(new Map())
  let processPlantArtifactModal = $state<{
    readonly object: OperationalObject
    readonly artifact: ProcessPlantArtifactKind
  } | null>(null)
  let processPlantCatalogModal = $state<OperationalObject | null>(null)
  let processPlantCredibilityModal = $state<OperationalObject | null>(null)
  let theme = $state<ThemeMode>('light')
  let weatherLayerVisible = $state(true)
  let surfaceLoadGeneration = 0
  let operationalMapLoadPromise: Promise<Component> | null = null
  let processDisplayModalLoadPromise: Promise<Component> | null = null
  let gridOverviewPanelLoadPromise: Promise<Component> | null = null
  let procedureSystemModalLoadPromise: Promise<Component> | null = null
  let processPlantArtifactModalLoadPromise: Promise<Component> | null = null
  let processPlantCatalogModalLoadPromise: Promise<Component> | null = null
  let processPlantCredibilityModalLoadPromise: Promise<Component> | null = null
  let droneControlModalLoadPromise: Promise<Component> | null = null
  let droneProfileEditorModalLoadPromise: Promise<Component> | null = null
  let pendingRealtimeSimulationRunId = $state<SimulationRunId | null>(null)
  let postReadyPreloadStarted = false
  let startupAutoDismissTimer: number | null = null
  let startupDebugGeneration = 0
  let startupDebugReported = false
  let startupDebugMarks: Array<{ readonly label: string; readonly atMs: number; readonly deltaMs: number }> = []
  let latestMapRuntimeDiagnostics = $state<MapRuntimeDiagnosticsSnapshot | null>(null)
  let longTaskMonitor: LongTaskDiagnosticsMonitor | null = null
  let procedureRunRefreshInFlight = false
  let procedureRunRefreshQueued = false
  let procedureRunRefreshKey = ''
  let procedureRunDocumentSimulationRunId: SimulationRunId | null = null
  let latestDroneMotionFrames: ReadonlyArray<DroneMotionFrame> = []
  const droneMotionFrameConsumers = new Set<DroneMotionFrameConsumer>()
  const realtimeConnection = createRealtimeConnectionController()
  const railLayout = createRailLayoutState()
  const placement = createPlacementState({
    packId: 'leitbild-control',
    defaultName: (type) => defaultName(type),
    setCommandStatus: (nextStatus) => {
      commandStatus = nextStatus
    },
  })
  const placementMode = $derived(placement.mode)
  const placementPoints = $derived(placement.points)
  const createDraft = $derived(placement.draft)
  const selectedControllerObject = $derived(activePack
    ? selectedControllerObjectFor(objects, selectedControllerId, activePack)
    : null)
  const allCategoryRows = $derived<ReadonlyArray<CategoryRow>>(activePack ? categoryRowsFor(objects, activePack) : [])
  const surface = $derived(scenarioDefinition?.surface ?? null)
  const railConfig = $derived(surfaceObjectRailConfig(surface))
  const mapConfig = $derived(surfaceMapConfig(surface))
  const effectiveMapConfig = $derived(mapConfig === null
    ? null
    : {
        ...mapConfig,
        layers: weatherLayerVisible
          ? mapConfig.layers
          : mapConfig.layers.filter(layer => layer !== 'weather'),
      })
  const mapVisible = $derived(mapConfig !== null)
  const railVisible = $derived(railConfig !== null)
  const footerVisible = $derived(surfaceHasPrimitive(surface, 'systemFooter'))
  const guidanceOverlayVisible = $derived(surfaceHasPrimitive(surface, 'guidanceOverlay'))
  let categoryMapVisibility = $state<Record<string, boolean>>({})
  const gridOverviewAvailable = $derived(scenarioDefinition?.packs.includes('electric-grid') === true)
  const gridOverviewVisible = $derived(
    gridOverviewAvailable && (categoryMapVisibility[gridOverviewCategoryId] ?? true),
  )
  const mapStartupFailed = $derived(startupSteps.find(step => step.id === 'map')?.status === 'failed')
  const richOperationalUiReady = $derived(!mapVisible || mapReady || mapStartupFailed)
  const debugMapInput = $derived(new URLSearchParams(location.search).get('debugMapInput') === '1')
  const debugStartup = new URLSearchParams(location.search).get('debugStartup') === '1'
  const categoryRows = $derived<ReadonlyArray<CategoryRow>>(categoryRowsForSurface(allCategoryRows, railConfig))
  const objectById = $derived(new Map(objects.map(object => [object.id, object])))
  $effect(() => {
    const rows = categoryRows
    untrack(() => {
      const current = categoryMapVisibility
      const next: Record<string, boolean> = {}
      let changed = Object.keys(current).length !== rows.length
      for (const row of rows) {
        const value = current[row.category.id] ?? true
        next[row.category.id] = value
        if (current[row.category.id] === undefined) changed = true
      }
      if (changed) categoryMapVisibility = next
    })
  })
  const hiddenObjectCategoryIds = $derived(
    Object.entries(categoryMapVisibility).flatMap(([categoryId, visible]) => visible ? [] : [categoryId]),
  )
  const placementCursor = $derived(activePack ? placementCursorFor(placementMode, activePack) : null)
  const systemStatusTone = $derived<StatusTone>(
    startupHasFailed(startupSteps) ? 'error' : startupIsReady(startupSteps) ? 'ready' : 'working',
  )
  const startupModalVisible = $derived(startupModalShouldShow({
    routeMode,
    dismissed: startupDismissed,
    steps: startupSteps,
  }) || startupStatusModalOpen)

  const toggleTheme = (): void => {
    theme = toggleThemeMode()
  }

  const toggleWeatherLayer = (): void => {
    weatherLayerVisible = !weatherLayerVisible
  }

  const setCategoryMapVisibility = (categoryId: string, visible: boolean): void => {
    if ((categoryMapVisibility[categoryId] ?? true) === visible) return
    categoryMapVisibility = {
      ...categoryMapVisibility,
      [categoryId]: visible,
    }
  }

  const toggleCategoryMapVisibility = (categoryId: string): void => {
    setCategoryMapVisibility(categoryId, !(categoryMapVisibility[categoryId] ?? true))
  }

  const closeGridOverviewPanel = (): void => {
    setCategoryMapVisibility(gridOverviewCategoryId, false)
  }

  // Pack-rail layer-group visibility. Active pack contributes mapLayerGroups
  // (e.g. aviation pack: airspace, airports, aircraft); the rail renders
  // toggles and writes here; OperationalMap re-applies on change.
  const activeMapLayerGroups = $derived(activePack?.presentation.mapLayerGroups ?? emptyMapLayerGroups)
  const activePackAreaFeatureLayers = $derived(activePack?.presentation.mapAreaFeatureLayers ?? emptyMapAreaFeatureLayers)
  const activePackAreaFeatureSourcePackIds = $derived(activePack?.mapAreaFeatureSourcePackIds ?? emptyStringArray)
  const activeReferenceDatasetIds = $derived(activePack?.referenceDatasetIds?.map(String) ?? emptyStringArray)
  let mapLayerGroupVisibility = $state<Record<string, boolean>>({})
  // Re-seed when the group list changes. `untrack` keeps the write from
  // re-triggering this effect (a new object literal every time would otherwise
  // loop infinitely and block the event loop).
  $effect(() => {
    const groups = activeMapLayerGroups
    untrack(() => {
      const current = mapLayerGroupVisibility
      const next: Record<string, boolean> = {}
      let changed = Object.keys(current).length !== groups.length
      for (const group of groups) {
        const value = current[group.id] ?? group.defaultVisible
        next[group.id] = value
        if (current[group.id] === undefined) changed = true
      }
      if (changed) mapLayerGroupVisibility = next
    })
  })
  const toggleMapLayerGroup = (groupId: string): void => {
    mapLayerGroupVisibility = {
      ...mapLayerGroupVisibility,
      [groupId]: !(mapLayerGroupVisibility[groupId] ?? activeMapLayerGroups.find(g => g.id === groupId)?.defaultVisible ?? true),
    }
  }

  // Rail source picker (Phase B.3). Only meaningful when the scenario binds
  // the aviation pack to aviation.multi — that runtime is the only one
  // accepting aviation.set_source, so picking a source on a single-source
  // runtime would do nothing.
  //
  // Active source is tracked locally because it's runtime state, not part of
  // the scenario manifest after the first switch. We seed from the scenario's
  // Pack config (the same payload the multi adapter consumes at connect
  // time) and then update optimistically on each successful command.
  let aviationActiveSourceId = $state<'opensky' | 'vatsim'>('opensky')
  let pendingSourceSwitch = $state(false)
  $effect(() => {
    const scenario = scenarioDefinition
    if (!scenario) return
    // Pack config is keyed by Pack id and routed to the selected runtime.
    const cfg = (scenario.packConfigs ?? {})['aviation'] as { source?: string } | undefined
    untrack(() => {
      const source = cfg?.source === 'vatsim' ? 'vatsim' : 'opensky'
      aviationActiveSourceId = source
    })
  })

  const setAviationSource = async (sourceId: string): Promise<void> => {
    if (sourceId !== 'opensky' && sourceId !== 'vatsim') return
    if (sourceId === aviationActiveSourceId || pendingSourceSwitch) return
    pendingSourceSwitch = true
    try {
      await sendCommand('aviation.set_source', { source: sourceId })
      aviationActiveSourceId = sourceId
    } finally {
      pendingSourceSwitch = false
    }
  }

  const railSourcePicker = $derived.by(() => {
    if (!activePack || !scenarioDefinition) return null
    const activeRuntimeId = scenarioDefinition.packRuntimes['aviation']
      ?? activePack.defaultRuntimeIdFor('aviation')
    if (activeRuntimeId !== 'aviation.multi') return null
    const sources = [
      { id: 'opensky', label: 'OpenSky Network (live ADS-B)' },
      { id: 'vatsim', label: 'VATSIM (flight-sim network)' },
    ]
    return {
      title: 'Aircraft source',
      sources,
      activeId: aviationActiveSourceId,
      onSelect: (sourceId: string) => { void setAviationSource(sourceId) },
    }
  })

  const currentPackTime = (): IsoTimestamp | undefined =>
    simulationTimeAt(clock)

  const requireActivePack = (): ActivePackViews => {
    if (!activePack) throw new Error('scenario packs are not loaded')
    return activePack
  }

  const presentationComposer = createPackPresentationComposer({
    getContext: () => ({
      pack: activePack,
      objects,
      currentTime: currentPackTime(),
    }),
  })

  const presentationFor = (
    object: OperationalObject,
    options: { readonly tier?: PackObjectPresentationTier } = {},
  ): PackObjectPresentation => {
    return presentationComposer.present(object, options)
  }

  const detailPresentationFor = (object: OperationalObject): PackObjectPresentation =>
    presentationFor(object, { tier: 'detail' })

  const mapPresentationFor = (object: OperationalObject): PackObjectPresentation =>
    presentationFor(object, { tier: 'map' })

  const statusPresentationFor = (object: OperationalObject): PackObjectStatusPresentation =>
    presentationFor(object).status ?? {
      tone: 'idle',
      label: object.operational.status,
      indicator: { shape: 'dot' },
    }

  const mapAreaFeaturesFor = createMapAreaFeatureLoader({
    pack: () => activePack,
    objects: () => objects,
    simulationRunId: () => simulationRunId,
    currentTime: currentPackTime,
  })

  const hasNewInfo = (object: OperationalObject): boolean => {
    if (!activePack) return false
    const presentation = presentationFor(object)
    if (presentation.noteworthyUpdates !== true) return false
    return (seenRevisions.get(object.id) ?? object.revision) < object.revision
  }

  const markSeen = (object: OperationalObject): void => {
    if ((seenRevisions.get(object.id) ?? -1) >= object.revision) return
    seenRevisions = new Map([...seenRevisions, [object.id, object.revision]])
  }

  const markStartup = (label: string): void => {
    if (!debugStartup) return
    const atMs = performance.now()
    const first = startupDebugMarks[0]?.atMs ?? atMs
    startupDebugMarks = [...startupDebugMarks, { label, atMs, deltaMs: atMs - first }]
    performance.mark(`leitbild-startup:${startupDebugGeneration}:${label}`)
  }

  const resetStartupDebug = (): void => {
    startupDebugGeneration += 1
    startupDebugReported = false
    startupDebugMarks = []
    markStartup('begin')
  }

  const reportStartupDebug = (): void => {
    if (!debugStartup || startupDebugReported) return
    startupDebugReported = true
    console.table(startupDebugMarks.map(mark => ({
      step: mark.label,
      elapsedMs: Number(mark.deltaMs.toFixed(1)),
    })))
  }

  const currentInternalDiagnostics = (): InternalDiagnosticsSnapshot => {
    const currentMapConfig = mapConfig
    const center = currentMapConfig?.center.coordinates
    return {
      capturedAt: new Date().toISOString(),
      appVersion,
      route: routeDiagnostics(),
      browser: browserDiagnostics(),
      startup: {
        status,
        commandStatus,
        dismissed: startupDismissed,
        statusModalOpen: startupStatusModalOpen,
        steps: startupSteps,
        marks: startupDebugMarks,
      },
      simulationRun: {
        id: simulationRunId,
        expectedScenarioId: expectedRealtimeScenarioId,
        snapshotReady,
        realtimeAttached,
        mapReady,
        selectedControllerId,
      },
      scenario: scenarioDiagnosticsFor(scenarioDefinition, objects),
      presentation: presentationComposer.diagnostics(),
      map: {
        visible: mapVisible,
        ready: mapReady,
        config: {
          center: center ? [center[0], center[1]] : null,
          zoom: currentMapConfig?.zoom ?? null,
          layers: currentMapConfig?.layers ?? [],
        },
        layerGroups: activeMapLayerGroups.map(group => ({
          id: group.id,
          visible: mapLayerGroupVisibility[group.id] ?? group.defaultVisible,
        })),
        referenceDatasetIds: activeReferenceDatasetIds,
        runtime: latestMapRuntimeDiagnostics,
      },
      performance: {
        map: mapPerformanceDiagnostics.snapshot(),
        longTasks: longTaskMonitor?.snapshot() ?? {
          supported: false,
          sampleCount: 0,
          worst: null,
          recent: [],
        },
        resources: resourceDiagnostics(),
        packQueries: packQueryDiagnostics(),
      },
    }
  }

  const clearInternalDiagnostics = (): void => {
    mapPerformanceDiagnostics.clear()
    presentationComposer.reset()
    longTaskMonitor?.clear()
    clearPackQueryDiagnostics()
    performance.clearResourceTimings()
  }

  const runWhenIdle = (task: () => void): void => {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      window.requestIdleCallback(task, { timeout: 2_000 })
      return
    }
    setTimeout(task, 250)
  }

  const preloadOptionalUiAfterReady = (): void => {
    if (postReadyPreloadStarted) return
    if (mapVisible && !mapReady) return
    const scenario = scenarioDefinition
    if (!scenario?.packs.includes('process-plant')) return
    postReadyPreloadStarted = true
    runWhenIdle(() => {
      void (async (): Promise<void> => {
        try {
          markStartup('process-display-preload:start')
          await loadProcessDisplayModal()
          markStartup('process-display-preload:done')
        } catch (err) {
          if (debugStartup) console.warn(err)
        }
      })()
    })
  }

  const loadOperationalMap = async (): Promise<Component> => {
    if (OperationalMap) return OperationalMap
    operationalMapLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../OperationalMap.svelte')
      return module.default
    })()
    try {
      const component = await operationalMapLoadPromise
      OperationalMap = component
      return component
    } catch (err) {
      operationalMapLoadPromise = null
      throw err
    }
  }

  const preloadOperationalMapModule = (): void => {
    if (OperationalMap || operationalMapLoadPromise) return
    markStartup('map-module:preload:start')
    void (async (): Promise<void> => {
      try {
        await loadOperationalMap()
        markStartup('map-module:preload:done')
      } catch (err) {
        if (debugStartup) console.warn('Operational map preload failed:', err)
      }
    })()
  }

  const loadCreateObjectModal = async (): Promise<void> => {
    if (CreateObjectModal) return
    const module = await import('../CreateObjectModal.svelte')
    CreateObjectModal = module.default
  }

  const loadSettingsModal = async (): Promise<void> => {
    if (SettingsModal) return
    const module = await import('../SettingsModal.svelte')
    SettingsModal = module.default
  }

  const loadProcessDisplayModal = async (): Promise<void> => {
    if (ProcessDisplayModal) return
    processDisplayModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../process-display/ProcessDisplayModal.svelte')
      return module.default
    })()
    try {
      ProcessDisplayModal = await processDisplayModalLoadPromise
    } catch (err) {
      processDisplayModalLoadPromise = null
      throw err
    }
  }

  const loadGridOverviewPanel = async (): Promise<void> => {
    if (GridOverviewPanel) return
    gridOverviewPanelLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../grid/GridOverviewPanel.svelte')
      return module.default
    })()
    try {
      GridOverviewPanel = await gridOverviewPanelLoadPromise
    } catch (err) {
      gridOverviewPanelLoadPromise = null
      throw err
    }
  }

  const loadProcedureSystemModal = async (): Promise<void> => {
    if (ProcedureSystemModal) return
    procedureSystemModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../procedures/ProcedureSystemModal.svelte')
      return module.default
    })()
    try {
      ProcedureSystemModal = await procedureSystemModalLoadPromise
    } catch (err) {
      procedureSystemModalLoadPromise = null
      throw err
    }
  }

  const loadProcessPlantArtifactModal = async (): Promise<void> => {
    if (ProcessPlantArtifactModal) return
    processPlantArtifactModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../process-display/ProcessPlantArtifactModal.svelte')
      return module.default
    })()
    try {
      ProcessPlantArtifactModal = await processPlantArtifactModalLoadPromise
    } catch (err) {
      processPlantArtifactModalLoadPromise = null
      throw err
    }
  }

  const loadProcessPlantCatalogModal = async (): Promise<void> => {
    if (ProcessPlantCatalogModal) return
    processPlantCatalogModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../process-display/ProcessPlantCatalogModal.svelte')
      return module.default
    })()
    try {
      ProcessPlantCatalogModal = await processPlantCatalogModalLoadPromise
    } catch (err) {
      processPlantCatalogModalLoadPromise = null
      throw err
    }
  }

  const loadProcessPlantCredibilityModal = async (): Promise<void> => {
    if (ProcessPlantCredibilityModal) return
    processPlantCredibilityModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../process-display/ProcessPlantCredibilityModal.svelte')
      return module.default
    })()
    try {
      ProcessPlantCredibilityModal = await processPlantCredibilityModalLoadPromise
    } catch (err) {
      processPlantCredibilityModalLoadPromise = null
      throw err
    }
  }

  const loadDroneControlModal = async (): Promise<void> => {
    if (DroneControlModal) return
    droneControlModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../drone/DroneControlModal.svelte')
      return module.default
    })()
    try {
      DroneControlModal = await droneControlModalLoadPromise
    } catch (err) {
      droneControlModalLoadPromise = null
      throw err
    }
  }

  const loadDroneProfileEditorModal = async (): Promise<void> => {
    if (DroneProfileEditorModal) return
    droneProfileEditorModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../drone/DroneProfileEditorModal.svelte')
      return module.default
    })()
    try {
      DroneProfileEditorModal = await droneProfileEditorModalLoadPromise
    } catch (err) {
      droneProfileEditorModalLoadPromise = null
      throw err
    }
  }

  const startStep = (id: StartupStepId): void => {
    markStartup(`${id}:start`)
    startupSteps = startStartupStep(startupSteps, id)
  }

  const completeStep = (id: StartupStepId): void => {
    if (startupSteps.find(step => step.id === id)?.status === 'done') return
    markStartup(`${id}:done`)
    startupSteps = completeStartupStep(startupSteps, id)
  }

  const failStep = (id: StartupStepId, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err)
    markStartup(`${id}:failed`)
    startupSteps = failStartupStep(startupSteps, id, message)
    status = message
  }

  const mapRuntimeDetails = (snapshot: MapRuntimeDiagnosticsSnapshot) => {
    const phases = snapshot.phases.map(phase => ({
      label: phase.phase,
      value: phase.completedAtMs
        ? `${phase.status} · ${((phase.completedAtMs - phase.startedAtMs) / 1000).toFixed(1)}s`
        : phase.status,
    }))
    const details = runtimeDiagnosticDetails(snapshot).slice(0, 12)
    const performanceDetails = snapshot.performance?.summaryDetails.slice(0, 7).map(detail => ({
      label: `Perf ${detail.label}`,
      value: detail.value,
    })) ?? []
    return [
      ...phases,
      ...performanceDetails,
      ...details,
      ...(snapshot.latestError
        ? [{ label: 'Latest error', value: snapshot.latestError.message }]
        : []),
    ]
  }

  const handleMapDiagnostic = (snapshot: MapRuntimeDiagnosticsSnapshot): void => {
    latestMapRuntimeDiagnostics = snapshot
    startupSteps = setStartupStepDetails(startupSteps, 'map', mapRuntimeDetails(snapshot))
  }

  const completeReadyWhenReady = (): void => {
    if (!snapshotReady || !realtimeAttached) return
    if (mapVisible && !mapReady) return
    completeStep('ready')
    reportStartupDebug()
    preloadOptionalUiAfterReady()
  }

  const completeObjectsWhenReady = async (): Promise<void> => {
    if (!snapshotReady) return
    if (mapVisible && !mapReady) return
    await tick()
    completeStep('objects')
    completeReadyWhenReady()
  }

  const loadSurfaceForScenario = async (scenarioId: string): Promise<void> => {
    const generation = ++surfaceLoadGeneration
    const scenario = scenarioDefinition?.id === scenarioId
      ? scenarioDefinition
      : await loadScenarioDefinitionAndPack(scenarioId)
    if (surfaceHasPrimitive(scenario.surface, 'map')) {
      mapReady = false
      startStep('map')
      markStartup('map-module:start')
      void (async (): Promise<void> => {
        try {
          await loadOperationalMap()
          if (generation !== surfaceLoadGeneration) return
          markStartup('map-module:done')
        } catch (err) {
          if (generation !== surfaceLoadGeneration) return
          failStep('map', err)
        }
      })()
      return
    }
    OperationalMap = null
    mapReady = false
    completeStep('map')
  }

  const closeStartupModal = (): void => {
    clearStartupAutoDismissTimer()
    startupDismissed = true
    startupStatusModalOpen = false
  }

  const clearStartupAutoDismissTimer = (): void => {
    if (startupAutoDismissTimer === null) return
    window.clearTimeout(startupAutoDismissTimer)
    startupAutoDismissTimer = null
  }

  const openStatusModal = (): void => {
    startupStatusModalOpen = true
  }

  const openSettings = (): void => {
    settingsModalOpen = true
    void loadSettingsModal()
  }

  const goToStartPage = (): void => {
    window.location.assign('/')
  }

  const nextFloatingWindowId = (prefix: string, objectId: ObjectId): string => {
    floatingWindowSequence += 1
    return `${prefix}:${objectId}:${floatingWindowSequence}`
  }

  const openProcessDisplay = (object: OperationalObject): void => {
    processDisplayWindows = [
      ...processDisplayWindows,
      {
        id: nextFloatingWindowId('process-display', object.id),
        objectId: object.id,
      },
    ]
    void loadProcessDisplayModal()
  }

  const closeProcessDisplay = (windowId: string): void => {
    processDisplayWindows = processDisplayWindows.filter(entry => entry.id !== windowId)
  }

  const openDroneControl = (object: OperationalObject): void => {
    if (object.packId !== 'drone') return
    droneControlWindows = [
      ...droneControlWindows,
      {
        id: nextFloatingWindowId('drone-control', object.id),
        objectId: object.id,
      },
    ]
    void loadDroneControlModal()
  }

  const closeDroneControl = (windowId: string): void => {
    droneControlWindows = droneControlWindows.filter(entry => entry.id !== windowId)
  }

  const openDroneProfileEditor = (object: OperationalObject): void => {
    if (object.packId !== 'drone') return
    droneProfileEditorWindows = [
      ...droneProfileEditorWindows,
      {
        id: nextFloatingWindowId('drone-profile', object.id),
        objectId: object.id,
      },
    ]
    void loadDroneProfileEditorModal()
  }

  const closeDroneProfileEditor = (windowId: string): void => {
    droneProfileEditorWindows = droneProfileEditorWindows.filter(entry => entry.id !== windowId)
  }

  const openProcessPlantArtifact = (object: OperationalObject, artifact: ProcessPlantArtifactKind): void => {
    if (processPlantIdForObject(object) === null) return
    processPlantArtifactModal = { object, artifact }
    void loadProcessPlantArtifactModal()
  }

  const closeProcessPlantArtifact = (): void => {
    processPlantArtifactModal = null
  }

  const openProcessPlantCatalog = (object: OperationalObject): void => {
    if (object.packId !== 'process-plant') return
    processPlantCatalogModal = object
    void loadProcessPlantCatalogModal()
  }

  const closeProcessPlantCatalog = (): void => {
    processPlantCatalogModal = null
  }

  const openProcessPlantCredibility = (object: OperationalObject): void => {
    if (processPlantIdForObject(object) === null) return
    processPlantCredibilityModal = object
    void loadProcessPlantCredibilityModal()
  }

  const closeProcessPlantCredibility = (): void => {
    processPlantCredibilityModal = null
  }

  const procedureUnitContexts = $derived(objects.flatMap(object => {
    const plantId = processPlantIdForObject(object)
    return plantId === null
      ? []
      : [{
          plantId,
          targetObjectId: object.id,
          label: object.label,
          status: statusPresentationFor(object),
        }]
  }))

  const processDisplayWindowModels = $derived<ReadonlyArray<ProcessDisplayWindowModel>>(
    processDisplayWindows.flatMap((entry, index) => {
      const object = objectById.get(entry.objectId)
      return object === undefined ? [] : [{ ...entry, object, index }]
    }),
  )

  const droneControlWindowModels = $derived<ReadonlyArray<DroneWindowModel>>(
    droneControlWindows.flatMap((entry, index) => {
      const object = objectById.get(entry.objectId)
      return object === undefined ? [] : [{ ...entry, object, index }]
    }),
  )

  const droneProfileEditorWindowModels = $derived<ReadonlyArray<DroneWindowModel>>(
    droneProfileEditorWindows.flatMap((entry, index) => {
      const object = objectById.get(entry.objectId)
      return object === undefined ? [] : [{ ...entry, object, index }]
    }),
  )

  const procedureSystemWindowModels = $derived<ReadonlyArray<ProcedureSystemWindowModel>>(
    procedureSystemWindows.flatMap((entry, index) => {
      const object = objectById.get(entry.objectId)
      if (object === undefined) return []
      const plantId = processPlantIdForObject(object)
      return plantId === null ? [] : [{ ...entry, object, plantId, index }]
    }),
  )

  $effect(() => {
    const liveObjectIds = new Set(objects.map(object => object.id))
    untrack(() => {
      const nextProcessDisplayWindows = processDisplayWindows.filter(entry => liveObjectIds.has(entry.objectId))
      if (nextProcessDisplayWindows.length !== processDisplayWindows.length) {
        processDisplayWindows = nextProcessDisplayWindows
      }
      const nextDroneControlWindows = droneControlWindows.filter(entry => liveObjectIds.has(entry.objectId))
      if (nextDroneControlWindows.length !== droneControlWindows.length) {
        droneControlWindows = nextDroneControlWindows
      }
      const nextDroneProfileEditorWindows = droneProfileEditorWindows.filter(entry => liveObjectIds.has(entry.objectId))
      if (nextDroneProfileEditorWindows.length !== droneProfileEditorWindows.length) {
        droneProfileEditorWindows = nextDroneProfileEditorWindows
      }
      const nextProcedureSystemWindows = procedureSystemWindows.filter(entry => liveObjectIds.has(entry.objectId))
      if (nextProcedureSystemWindows.length !== procedureSystemWindows.length) {
        procedureSystemWindows = nextProcedureSystemWindows
      }
    })
  })

  const procedureScopeForObject = (object: OperationalObject): ProcedureRunScope | null => {
    const plantId = processPlantIdForObject(object)
    return plantId === null
      ? null
      : { plantId, targetObjectId: object.id, label: object.label }
  }

  const scopedProcedureRuns = (nextRuns: ReadonlyArray<ProcedureRunState>): ReadonlyArray<ProcedureRunState> =>
    nextRuns.filter(run => {
      const raw = run as ProcedureRunState & { readonly scope?: unknown }
      return typeof raw.scope === 'object'
        && raw.scope !== null
        && !Array.isArray(raw.scope)
        && typeof (raw.scope as Record<string, unknown>).plantId === 'string'
    })

  const procedureRunDocumentIds = (nextRuns: ReadonlyArray<ProcedureRunState>): ReadonlyArray<ProcedureId> =>
    [...new Set(nextRuns
      .filter(run => run.status === 'active' || run.status === 'completed')
      .map(run => run.procedureId))]

  const ensureProcedureRunDocuments = async (
    controlId: SimulationRunId,
    nextRuns: ReadonlyArray<ProcedureRunState>,
  ): Promise<void> => {
    const missing = procedureRunDocumentIds(nextRuns).filter(procedureId => !procedureRunDocuments.has(procedureId))
    if (missing.length === 0) return
    const loaded = await Promise.all(missing.map(async procedureId =>
      await readProcedureDocument(controlId, procedureId, {
        sourceId: nextRuns.find(run => run.procedureId === procedureId)?.sourceId,
      }),
    ))
    procedureRunDocuments = new Map([
      ...procedureRunDocuments,
      ...loaded.map(document => [document.procedureId, document] as const),
    ])
  }

  const refreshProcedureRunState = async (): Promise<void> => {
    const controlId = simulationRunId
    if (!controlId || scenarioDefinition?.packs.includes('process-plant') !== true) {
      procedureRuns = []
      procedureRunDocuments = new Map()
      procedureRunRefreshKey = ''
      procedureRunDocumentSimulationRunId = null
      return
    }
    if (procedureRunDocumentSimulationRunId !== controlId) {
      procedureRuns = []
      procedureRunDocuments = new Map()
      procedureRunDocumentSimulationRunId = controlId
    }
    if (procedureRunRefreshInFlight) {
      procedureRunRefreshQueued = true
      return
    }
    procedureRunRefreshInFlight = true
    try {
      do {
        procedureRunRefreshQueued = false
        const nextRuns = scopedProcedureRuns((await readProcedureRuns(controlId)).runs)
        await ensureProcedureRunDocuments(controlId, nextRuns)
        if (simulationRunId === controlId) procedureRuns = nextRuns
      } while (procedureRunRefreshQueued)
    } catch (err) {
      commandStatus = err instanceof Error ? err.message : 'Unable to refresh procedure run status'
    } finally {
      procedureRunRefreshInFlight = false
    }
  }

  const procedureSummariesForObject = (object: OperationalObject): ProcedureRunSummaryGroup => {
    const scope = procedureScopeForObject(object)
    return scope
      ? procedureRunSummariesForScope(procedureRuns, scope, procedureRunDocuments)
      : emptyProcedureRunSummaries
  }

  const procedureLaunchStepFor = (summary: ProcedureRunSummary): ProcedureStepId | undefined => {
    const document = procedureRunDocuments.get(summary.procedureId)
    const current = document ? procedureCurrentStep(summary.run, document) : null
    return (current?.step.id ?? summary.step?.stepId) as ProcedureStepId | undefined
  }

  const openProcedureSystemAt = (object: OperationalObject, summary?: ProcedureRunSummary): void => {
    if (processPlantIdForObject(object) === null) return
    const initialStepId = summary === undefined ? undefined : procedureLaunchStepFor(summary)
    procedureSystemWindows = [
      ...procedureSystemWindows,
      {
        id: nextFloatingWindowId('procedure-system', object.id),
        objectId: object.id,
        ...(summary?.procedureId === undefined ? {} : { initialProcedureId: summary.procedureId }),
        ...(initialStepId === undefined ? {} : { initialStepId }),
        initialNavigationRevision: floatingWindowSequence,
      },
    ]
    void loadProcedureSystemModal()
  }

  const openProcedureSystem = (object: OperationalObject): void => {
    openProcedureSystemAt(object)
  }

  const closeProcedureSystem = (windowId: string): void => {
    procedureSystemWindows = procedureSystemWindows.filter(entry => entry.id !== windowId)
  }

  const closeSettings = (): void => {
    settingsModalOpen = false
  }

  const resetStartupForJoin = (): void => {
    resetStartupDebug()
    surfaceLoadGeneration += 1
    postReadyPreloadStarted = false
    startupDismissed = false
    latestMapRuntimeDiagnostics = null
    pendingRealtimeSimulationRunId = null
    latestDroneMotionFrames = []
    startupSteps = resetStartupStepsAfter(startupSteps, 'simulation-run')
  }

  const activeRoute = () => parseControlSurfaceRoute(location.pathname)

  const activeWorkspaceId = () => {
    const route = activeRoute()
    return route.workspaceId
  }

  const scenarioIdForReset = (): string | undefined =>
    scenarioState?.scenarioId

  const loadScenarioDefinitionAndPack = async (scenarioId: string): Promise<ScenarioDefinition> => {
    markStartup('scenario-fetch:start')
    const body = await fetchScenario(scenarioId)
    markStartup('scenario-fetch:done')
    return await loadScenarioDefinitionAndPackFromDefinition(body.scenario)
  }

  const loadScenarioDefinitionAndPackFromDefinition = async (scenario: ScenarioDefinition): Promise<ScenarioDefinition> => {
    markStartup('pack-load:start')
    const nextPack = await loadActivePackViews(scenario.packs)
    markStartup('pack-load:done')
    scenarioDefinition = scenario
    activePack = nextPack
    return scenario
  }

  const defaultName = (type: PackCreateObjectType): string => {
    const creation = requireActivePack().creation
    if (!creation) throw new Error(`no active Pack can create ${type.id}`)
    return creation.defaultObjectLabel(type.id, { objects })
  }

  const syncSimulationRunSnapshot = async (): Promise<void> => {
    if (!simulationRunId) return
    const body = await syncSimulationRunSnapshotClient(simulationRunId)
    objects = [...body.snapshot.objects]
    scenarioState = body.snapshot.scenario
    clock = body.snapshot.clock
  }

  const sendCommand = async (kind: string, payload: unknown, targetObjectIds: readonly string[] = []): Promise<void> => {
    if (!simulationRunId) return
    if (!realtimeAttached) {
      commandStatus = 'Wait for realtime attachment before sending commands'
      return
    }
    let body
    try {
      body = await sendSimulationRunCommand(simulationRunId, { kind, targetObjectIds, payload })
    } catch (err) {
      commandStatus = err instanceof Error ? err.message : 'command failed'
      return
    }
    if (!body.result.ok) {
      commandStatus = `Command rejected: ${body.result.reason ?? 'unknown reason'}`
      return
    }
    commandStatus = 'Command accepted'
    await syncSimulationRunSnapshot()
  }

  const sendRealtimeCommand = async (command: Parameters<typeof realtimeConnection.sendCommand>[1]) => {
    if (!simulationRunId) throw new Error('simulation run is not ready')
    return await realtimeConnection.sendCommand(simulationRunId, command)
  }

  const sendRealtimeInput = (input: Parameters<typeof realtimeConnection.sendRuntimeInput>[1]): void => {
    if (!simulationRunId) throw new Error('simulation run is not ready')
    realtimeConnection.sendRuntimeInput(simulationRunId, input)
  }

  const subscribeDroneMotionFrames = (consumer: DroneMotionFrameConsumer): (() => void) => {
    droneMotionFrameConsumers.add(consumer)
    if (latestDroneMotionFrames.length > 0) consumer(latestDroneMotionFrames)
    return () => {
      droneMotionFrameConsumers.delete(consumer)
    }
  }

  const publishDroneMotionFrames = (frames: ReadonlyArray<DroneMotionFrame>): void => {
    if (frames.length === 0) return
    latestDroneMotionFrames = frames
    for (const consumer of droneMotionFrameConsumers) consumer(frames)
  }

  const deleteObject = async (object: OperationalObject): Promise<void> => {
    commandStatus = `Deleting ${object.label}`
    await sendCommand(deleteObjectCommandKind, { objectId: object.id }, [object.id])
  }

  const createObject = async (draft: CreateDraft): Promise<void> => {
    placement.clearDraft()
    commandStatus = `Creating ${draft.objectType.label}`
    const pack = requireActivePack()
    if (!pack.creation) throw new Error('active Packs do not support object creation')
    const command = pack.creation.buildCreateObjectCommand(
      draft.objectType.id,
      draft.label.trim() || defaultName(draft.objectType),
      draft.geometry,
      draft.parameters,
    )
    await sendCommand(command.kind, command.payload, command.targetObjectIds)
  }

  const setDestination = async (destination: OperationalObject): Promise<void> => {
    const controller = selectedControllerObject
    if (!controller) {
      commandStatus = 'Select a controller first'
      return
    }
    if (destination.id === controller.id) return
    const pack = requireActivePack()
    if (!pack.targeting?.isTarget(controller, destination, { objects })) return
    commandStatus = `Sending ${controller.label} to ${destination.label}`
    const command = pack.targeting.buildSetTargetCommand(controller, destination, { objects })
    await sendCommand(command.kind, command.payload, command.targetObjectIds)
  }

  const selectObject = (object: OperationalObject): void => {
    markSeen(object)
    const pack = requireActivePack()
    if (pack.targeting?.isController(object)) {
      selectedControllerId = object.id
      commandStatus = `Selected ${object.label}; click a valid target`
      return
    }
    const controller = selectedControllerObject
    if (controller && pack.targeting?.isTarget(controller, object, { objects })) {
      void setDestination(object)
    }
  }

  const connectWebSocket = (id: SimulationRunId): void => {
    if (mapVisible && !mapReady) {
      pendingRealtimeSimulationRunId = id
      startStep('realtime')
      status = 'Waiting for map first frame before realtime updates'
      return
    }
    pendingRealtimeSimulationRunId = null
    startStep('realtime')
    if (realtimeConnection.canCarry(id)) {
      status = realtimeConnection.statusFor(id) === 'open' ? 'Realtime channel open' : 'Connecting'
      completeReadyWhenReady()
      return
    }
    realtimeAttached = false
    latestDroneMotionFrames = []
    realtimeConnection.connect(id, {
      onOpen: () => {
        status = 'Realtime channel open'
      },
      onClose: () => {
        realtimeAttached = false
        status = 'Disconnected'
      },
      onError: (message) => {
        status = message
        failStep('realtime', message)
      },
      onInvalidMessage: (message) => {
        status = message
      },
      onReady: (parsed) => {
        if (parsed.simulationRunId !== id) {
          failStep('realtime', `Realtime attached to ${parsed.simulationRunId}, expected ${id}`)
          return
        }
        if (expectedRealtimeScenarioId !== null && parsed.scenarioId !== expectedRealtimeScenarioId) {
          failStep('realtime', `Realtime attached to scenario ${parsed.scenarioId ?? 'none'}, expected ${expectedRealtimeScenarioId}`)
          return
        }
        realtimeAttached = true
        if (parsed.clock) clock = parsed.clock
        status = 'Connected'
        completeStep('realtime')
        completeReadyWhenReady()
      },
      onEvent: (parsed) => {
        if (parsed.simulationRunId !== id) return
        if (expectedRealtimeScenarioId !== null && parsed.scenarioId !== expectedRealtimeScenarioId) return
        if (!realtimeAttached) return
        const applied = applySimulationRunEventBatchMessage({ objects, selectedControllerId, scenarioState }, parsed)
        if (applied.objectUpdate) {
          objects = [...applied.objectUpdate.objects]
          selectedControllerId = applied.objectUpdate.selectedControllerId
        }
        if (applied.commandStatusUpdate) {
          commandStatus = applied.commandStatusUpdate.commandStatus
        }
        if (applied.scenarioUpdate) {
          scenarioState = applied.scenarioUpdate
        }
        if (applied.clockUpdate) {
          clock = applied.clockUpdate
        }
        if (applied.routesChanged) {
          routeRevision += 1
        }
        if (parsed.events.some(event => event.type.startsWith('procedure.'))) {
          procedureRevision += 1
        }
      },
      onRuntimeRealtime: (parsed) => {
        if (parsed.simulationRunId !== id) return
        if (expectedRealtimeScenarioId !== null && parsed.scenarioId !== expectedRealtimeScenarioId) return
        if (!realtimeAttached) return
        const frames = parsed.messages.flatMap(message => {
          try {
            return parseDroneMotionFramesRealtimeMessage(message)?.payload.frames ?? []
          } catch (err) {
            status = err instanceof Error ? err.message : String(err)
            return []
          }
        })
        publishDroneMotionFrames(frames)
      },
    })
  }

  const connectPendingRealtime = (): void => {
    const id = pendingRealtimeSimulationRunId
    if (!id) return
    pendingRealtimeSimulationRunId = null
    connectWebSocket(id)
  }

  const simulationRunIdFromPath = (): SimulationRunId => {
    const route = activeRoute()
    if (route.mode !== 'simulation-run') throw new Error('simulation run route expected')
    if (location.pathname !== route.canonicalPath) history.replaceState(null, '', route.canonicalPath)
    return route.simulationRunId
  }

  const completeStartupFromResponse = async (
    response: SimulationRunResponse,
    config: {
      readonly setActiveStartupStep: (id: StartupStepId) => void
    },
  ): Promise<void> => {
    const scenarioId = response.snapshot.scenario?.scenarioId
    if (!scenarioId) throw new Error('simulation run snapshot is missing scenario state')
    const packScenario = scenarioDefinition?.id === scenarioId
      ? scenarioDefinition
      : response.scenario?.id === scenarioId
        ? await loadScenarioDefinitionAndPackFromDefinition(response.scenario)
        : await loadScenarioDefinitionAndPack(scenarioId)
    if (packScenario.id !== scenarioId || !activePack) throw new Error(`scenario packs failed to load for ${scenarioId}`)
    await completeControlSurfaceStartupFromSnapshot({
      response,
      pack: activePack,
      startStep,
      completeStep,
      setActiveStartupStep: config.setActiveStartupStep,
      setSimulationRunId: id => {
        simulationRunId = id
      },
      setObjects: nextObjects => {
        objects = nextObjects
      },
      setScenarioState: nextState => {
        scenarioState = nextState
      },
      setClock: nextClock => {
        clock = nextClock
      },
      setExpectedRealtimeScenarioId: scenarioId => {
        expectedRealtimeScenarioId = scenarioId
      },
      setSelectedControllerId: id => {
        selectedControllerId = id
      },
      setSeenRevisions: nextSeen => {
        seenRevisions = nextSeen
      },
      setSnapshotReady: ready => {
        snapshotReady = ready
      },
      loadSurfaceForScenario,
      completeObjectsWhenReady,
      connectRealtime: connectWebSocket,
    })
  }

  const joinSimulationRun = async (): Promise<void> => {
    realtimeConnection.disconnect()
    realtimeAttached = false
    resetStartupForJoin()
    snapshotReady = false
    mapReady = false
    scenarioDefinition = null
    activePack = null
    status = 'Starting'
    startStep('simulation-run')
    let activeStartupStep: StartupStepId = 'simulation-run'
    try {
      const id = simulationRunIdFromPath()
      const route = activeRoute()
      if (route.mode !== 'simulation-run') throw new Error('simulation run route expected')
      markStartup('join-request:start')
      const body = await joinSimulationRunClient(id)
      markStartup('join-request:done')
      await completeStartupFromResponse(body, {
        setActiveStartupStep: id => {
          activeStartupStep = id
        },
      })
    } catch (err) {
      failStep(activeStartupStep, err)
    }
  }

  const resetScenario = async (): Promise<void> => {
    if (!simulationRunId) return
    realtimeAttached = false
    resetStartupForJoin()
    snapshotReady = false
    mapReady = false
    scenarioDefinition = null
    activePack = null
    status = 'Resetting'
    commandStatus = 'Resetting scenario'
    startStep('simulation-run')
    let activeStartupStep: StartupStepId = 'simulation-run'
    try {
      expectedRealtimeScenarioId = scenarioIdForReset() ?? null
      startStep('realtime')
      const body = await resetSimulationRun(simulationRunId)
      await completeStartupFromResponse(body, {
        setActiveStartupStep: id => {
          activeStartupStep = id
        },
      })
      commandStatus = 'Scenario reset'
    } catch (err) {
      failStep(activeStartupStep, err)
      commandStatus = err instanceof Error ? err.message : 'Scenario reset failed'
    }
  }

  const toggleClockPaused = async (): Promise<void> => {
    if (!simulationRunId || !clock) return
    const body = await setSimulationRunClock(simulationRunId, { paused: !clock.paused })
    clock = body.clock
  }

  const handleMapReady = (): void => {
    mapReady = true
    markStartup('map:ready')
    if (startupSteps.find(step => step.id === 'map')?.status !== 'done') completeStep('map')
    if (startupSteps.find(step => step.id === 'objects')?.status === 'pending') startStep('objects')
    connectPendingRealtime()
    void completeObjectsWhenReady()
    preloadOptionalUiAfterReady()
  }

  const handleMapError = (message: string): void => {
    if (!mapReady) {
      failStep('map', message)
      return
    }
    status = message
  }

  runOnMount(() => {
    longTaskMonitor = createLongTaskDiagnosticsMonitor()
    const cleanupInternalDiagnosticsGlobal = installInternalDiagnosticsGlobal({
      snapshot: currentInternalDiagnostics,
      clear: clearInternalDiagnostics,
    })
    const nextTheme = initialTheme()
    theme = nextTheme
    if (getTheme() !== nextTheme) document.documentElement.classList.toggle('dark', nextTheme === 'dark')
    railLayout.initialize()
    const removePlacementGlobalEvents = installPlacementGlobalEvents({
      placementMode: () => placementMode,
      cancel: placement.cancel,
      finishPolygon: placement.finishPolygon,
    })
    let route
    try {
      route = activeRoute()
      if (route.mode !== 'simulation-run') throw new Error('control surface route expected')
    } catch (err) {
      failStep('route', err)
      return () => {
        cleanupInternalDiagnosticsGlobal()
        longTaskMonitor?.stop()
        longTaskMonitor = null
        removePlacementGlobalEvents()
        railLayout.stopResize()
        clearStartupAutoDismissTimer()
      }
    }
    completeStep('route')
    completeStep('interface')
    preloadOperationalMapModule()
    void joinSimulationRun()
    return () => {
      cleanupInternalDiagnosticsGlobal()
      longTaskMonitor?.stop()
      longTaskMonitor = null
      removePlacementGlobalEvents()
      railLayout.stopResize()
      realtimeConnection.disconnect()
      clearStartupAutoDismissTimer()
    }
  })

  $effect(() => {
    if (
      startupDismissed
      || startupStatusModalOpen
      || startupHasFailed(startupSteps)
      || !startupIsReady(startupSteps)
    ) {
      clearStartupAutoDismissTimer()
      return
    }
    if (startupAutoDismissTimer !== null) return
    startupAutoDismissTimer = window.setTimeout(() => {
      startupAutoDismissTimer = null
      closeStartupModal()
    }, 1_500)
  })

  $effect(() => {
    if (createDraft) void loadCreateObjectModal()
  })

  $effect(() => {
    if (gridOverviewVisible && richOperationalUiReady) void loadGridOverviewPanel()
  })

  $effect(() => {
    const controlId = simulationRunId
    const hasProcessPlant = scenarioDefinition?.packs.includes('process-plant') === true
    const refreshKey = controlId && hasProcessPlant ? `${controlId}:${procedureRevision}` : ''
    if (refreshKey === procedureRunRefreshKey) return
    procedureRunRefreshKey = refreshKey
    if (!refreshKey) {
      procedureRuns = []
      procedureRunDocuments = new Map()
      return
    }
    void refreshProcedureRunState()
  })
</script>

{#if !surface}
  <div class="boot-shell"></div>
{:else}
  <div
    class:rail-collapsed={railLayout.collapsed}
    class:no-rail={!railVisible}
    class="app-shell"
    style={`--rail-width: ${railVisible ? railLayout.width : 0}px`}
  >
    {#if railConfig}
      <ControlRail
        {status}
        {systemStatusTone}
        {appVersion}
        {clock}
        {footerVisible}
        collapsed={railLayout.collapsed}
        {categoryRows}
        {railConfig}
        {placementMode}
        {selectedControllerId}
        {categoryMapVisibility}
        deferObjectRows={!richOperationalUiReady}
        {presentationFor}
        {detailPresentationFor}
        {hasNewInfo}
        {markSeen}
        {selectObject}
        {deleteObject}
        {openProcessDisplay}
        {openProcedureSystem}
        {openProcedureSystemAt}
        {openProcessPlantArtifact}
        {openProcessPlantCatalog}
        {openProcessPlantCredibility}
        {openDroneControl}
        {openDroneProfileEditor}
        {procedureSummariesForObject}
        beginPlacement={placement.begin}
        cancelPlacement={placement.cancel}
        {openStatusModal}
        {openSettings}
        {toggleClockPaused}
        {toggleCategoryMapVisibility}
        mapLayerGroups={activeMapLayerGroups}
        {mapLayerGroupVisibility}
        onMapLayerGroupToggle={toggleMapLayerGroup}
        sourcePicker={railSourcePicker}
      />
      <button
        class="rail-resize-handle"
        class:collapsed={railLayout.collapsed}
        type="button"
        aria-label={railLayout.collapsed ? 'Show control rail' : 'Resize control rail'}
        title={railLayout.collapsed ? 'Show control rail' : 'Drag to resize control rail'}
        onpointerdown={railLayout.startResize}
      ></button>
    {/if}

    <main class="surface-main" class:map-region={mapVisible}>
      {#if mapVisible && OperationalMap}
        <OperationalMap
          {objects}
          {selectedControllerId}
          {placementMode}
          {placementCursor}
          {placementPoints}
          {theme}
          mapConfig={effectiveMapConfig}
          {clock}
          {routeRevision}
          {debugMapInput}
          highlightedObjectIds={scenarioState?.highlightedObjectIds ?? emptyStringArray}
          {hiddenObjectCategoryIds}
          {hasNewInfo}
          presentationFor={mapPresentationFor}
          {mapAreaFeaturesFor}
          onObjectSelected={selectObject}
          onPlacementPoint={placement.placePoint}
          onObjectSeen={markSeen}
          onMapReady={handleMapReady}
          onMapError={handleMapError}
          onMapDiagnostic={handleMapDiagnostic}
          {simulationRunId}
          activePackIds={scenarioDefinition?.packs ?? emptyStringArray}
          mapLayerGroups={activeMapLayerGroups}
          {mapLayerGroupVisibility}
          referenceDatasetIds={activeReferenceDatasetIds}
          packAreaFeatureLayers={activePackAreaFeatureLayers}
          packAreaFeatureSourcePackIds={activePackAreaFeatureSourcePackIds}
        />
      {:else if mapVisible}
        <div class="map-loading">Starting map...</div>
      {:else}
        <div class="surface-empty"></div>
      {/if}
      {#if gridOverviewVisible && richOperationalUiReady && GridOverviewPanel}
        <GridOverviewPanel {objects} onClose={closeGridOverviewPanel} />
      {/if}
    </main>

    {#if guidanceOverlayVisible && scenarioState?.guidance}
    <ScenarioGuidance
      guidance={scenarioState.guidance}
      close={() => {
        if (!scenarioState) return
        const { guidance: _guidance, ...withoutGuidance } = scenarioState
        scenarioState = withoutGuidance
      }}
    />
    {/if}
  </div>
{/if}

{#if DroneControlModal && simulationRunId}
  {#each droneControlWindowModels as windowEntry (windowEntry.id)}
    <DroneControlModal
      {simulationRunId}
      object={windowEntry.object}
      {objects}
      {sendRealtimeCommand}
      {sendRealtimeInput}
      subscribeMotionFrames={subscribeDroneMotionFrames}
      windowOffsetIndex={windowEntry.index}
      close={() => closeDroneControl(windowEntry.id)}
    />
  {/each}
{/if}

{#if DroneProfileEditorModal && simulationRunId}
  {#each droneProfileEditorWindowModels as windowEntry (windowEntry.id)}
    <DroneProfileEditorModal
      {simulationRunId}
      object={windowEntry.object}
      windowOffsetIndex={windowEntry.index}
      close={() => closeDroneProfileEditor(windowEntry.id)}
    />
  {/each}
{/if}

{#if ProcessDisplayModal && simulationRunId}
  {#each processDisplayWindowModels as windowEntry (windowEntry.id)}
    <ProcessDisplayModal
      {simulationRunId}
      object={windowEntry.object}
      unitStatus={statusPresentationFor(windowEntry.object)}
      unitContexts={procedureUnitContexts}
      procedureSummaries={procedureSummariesForObject(windowEntry.object)}
      {procedureRevision}
      windowOffsetIndex={windowEntry.index}
      openProcedureSystemAt={(summary) => openProcedureSystemAt(windowEntry.object, summary)}
      close={() => closeProcessDisplay(windowEntry.id)}
    />
  {/each}
{/if}

{#if ProcedureSystemModal && simulationRunId}
  {#each procedureSystemWindowModels as windowEntry (windowEntry.id)}
    <ProcedureSystemModal
      {simulationRunId}
      plantId={windowEntry.plantId}
      unitName={windowEntry.object.label}
      unitStatus={statusPresentationFor(windowEntry.object)}
      unitContexts={procedureUnitContexts}
      realtimeRevision={procedureRevision}
      initialProcedureId={windowEntry.initialProcedureId}
      initialStepId={windowEntry.initialStepId}
      initialNavigationRevision={windowEntry.initialNavigationRevision}
      windowOffsetIndex={windowEntry.index}
      close={() => closeProcedureSystem(windowEntry.id)}
    />
  {/each}
{/if}

{#if processPlantArtifactModal && ProcessPlantArtifactModal && simulationRunId}
  {@const artifactSystemId = processPlantIdForObject(processPlantArtifactModal.object)}
  {#if artifactSystemId}
    <ProcessPlantArtifactModal
      {simulationRunId}
      plantId={artifactSystemId}
      artifact={processPlantArtifactModal.artifact}
      close={closeProcessPlantArtifact}
    />
  {/if}
{/if}

{#if processPlantCatalogModal && ProcessPlantCatalogModal && simulationRunId}
  <ProcessPlantCatalogModal
    {simulationRunId}
    close={closeProcessPlantCatalog}
  />
{/if}

{#if processPlantCredibilityModal && ProcessPlantCredibilityModal && simulationRunId}
  {@const credibilitySystemId = processPlantIdForObject(processPlantCredibilityModal)}
  {#if credibilitySystemId}
    <ProcessPlantCredibilityModal
      {simulationRunId}
      plantId={credibilitySystemId}
      close={closeProcessPlantCredibility}
    />
  {/if}
{/if}

{#if startupModalVisible}
  <StartupModal
    steps={startupSteps}
    tone={systemStatusTone}
    retry={joinSimulationRun}
    close={closeStartupModal}
    autoCloseWhenReady={!startupStatusModalOpen}
    closeWhenReadyOnly={!startupStatusModalOpen}
  />
{/if}

{#if createDraft && CreateObjectModal}
  <CreateObjectModal {createDraft} {createObject} cancelCreate={placement.cancel} />
{/if}

{#if settingsModalOpen && SettingsModal}
  <SettingsModal
    {theme}
    weatherLayerAvailable={mapConfig?.layers.includes('weather') ?? false}
    {weatherLayerVisible}
    close={closeSettings}
    {goToStartPage}
    {toggleTheme}
    {toggleWeatherLayer}
    {resetScenario}
  />
{/if}
