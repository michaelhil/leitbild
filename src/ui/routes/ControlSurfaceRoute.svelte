<script lang="ts">
  import type { Component } from 'svelte'
  import { tick, untrack } from 'svelte'
  import type { IsoTimestamp, OperationalObject, ControlInstanceId, ScenarioDefinition, ScenarioInstanceState, SimulationClockState } from '../../core/model/index.ts'
  import { deleteObjectCommandKind } from '../../core/model/index.ts'
  import { createPackPresentationComposer } from '../../core/packs/presentation-composer.ts'
  import type { LeitbildPack, PackCreateObjectType, PackObjectPresentation, PackObjectPresentationTier } from '../../core/packs/protocol.ts'
  import {
    fetchScenario,
    joinControlInstance as joinControlInstanceClient,
    listScenarios as listScenariosClient,
    resetControlInstance,
    sendControlInstanceCommand,
    setControlInstanceClock,
    syncControlInstanceSnapshot as syncControlInstanceSnapshotClient,
  } from '../control-instance-client.ts'
  import {
    createGeneratedRunId,
    parseControlSurfaceRoute,
    pathForNewScenarioRun,
    pathForScenarioRun,
  } from '../control-instance-route.ts'
  import {
    applyControlInstanceEventBatchMessage,
  } from '../control-instance-events.ts'
  import { createMapAreaFeatureLoader } from '../app/map-area-feature-loader.ts'
  import { installPlacementGlobalEvents } from '../app/placement-global-events.ts'
  import { createRealtimeConnectionController } from '../app/realtime-connection.ts'
  import { completeControlSurfaceStartupFromSnapshot } from '../app/control-surface-session.ts'
  import { createScenarioControlPack } from '../pack-loader.ts'
  import {
    categoryRowsFor,
    placementCursorFor,
    selectedControllerObjectFor,
  } from '../control-surface-selectors.ts'
  import { createPlacementState } from '../placement-state.svelte.ts'
  import { pathForRecentScenarioRun, rememberRecentScenarioRun } from '../recent-scenario-runs.ts'
  import { createRailLayoutState } from '../rail-layout-state.svelte.ts'
  import { simulationTimeAt } from '../simulation-clock.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import ControlRail from '../ControlRail.svelte'
  import ScenarioGuidance from '../ScenarioGuidance.svelte'
  import StartupModal from '../StartupModal.svelte'
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
  import type { CategoryRow, ControlInstanceResponse, CreateDraft, ScenarioListItem } from '../types.ts'

  const appVersion = __LEITBILD_VERSION__
  const gridOverviewCategoryId = 'grid-system'
  const emptyStringArray: ReadonlyArray<string> = []
  const emptyMapLayerGroups: NonNullable<LeitbildPack['mapLayerGroups']> = []
  const emptyMapAreaFeatureLayers: NonNullable<LeitbildPack['mapAreaFeatureLayers']> = []
  let activePack = $state<LeitbildPack | null>(null)
  let controlInstanceId = $state<ControlInstanceId | null>(null)
  let objects = $state<OperationalObject[]>([])
  let scenarioState = $state<ScenarioInstanceState | undefined>(undefined)
  let clock = $state<SimulationClockState | undefined>(undefined)
  let scenarioDefinition = $state<ScenarioDefinition | null>(null)
  let selectedControllerId = $state<string | null>(null)
  let status = $state('Starting')
  let commandStatus = $state('')
  const routeMode = 'control-instance'
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
  let ProcessSurfaceModal = $state<Component | null>(null)
  let GridOverviewPanel = $state<Component | null>(null)
  let ProcedureSystemModal = $state<Component | null>(null)
  let processSurfaceObject = $state<OperationalObject | null>(null)
  let procedureSystemObject = $state<OperationalObject | null>(null)
  let theme = $state<ThemeMode>('light')
  let weatherLayerVisible = $state(true)
  let scenarioOptions = $state<ReadonlyArray<ScenarioListItem>>([])
  let scenarioOptionsLoaded = $state(false)
  let surfaceLoadGeneration = 0
  let operationalMapLoadPromise: Promise<Component> | null = null
  let processSurfaceModalLoadPromise: Promise<Component> | null = null
  let gridOverviewPanelLoadPromise: Promise<Component> | null = null
  let procedureSystemModalLoadPromise: Promise<Component> | null = null
  let pendingRealtimeControlInstanceId = $state<ControlInstanceId | null>(null)
  let postReadyPreloadStarted = false
  let startupAutoDismissTimer: number | null = null
  let startupDebugGeneration = 0
  let startupDebugReported = false
  let startupDebugMarks: Array<{ readonly label: string; readonly atMs: number; readonly deltaMs: number }> = []
  let latestMapRuntimeDiagnostics = $state<MapRuntimeDiagnosticsSnapshot | null>(null)
  let longTaskMonitor: LongTaskDiagnosticsMonitor | null = null
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
  const richOperationalUiReady = $derived(!mapVisible || mapReady)
  const debugMapInput = $derived(new URLSearchParams(location.search).get('debugMapInput') === '1')
  const debugStartup = new URLSearchParams(location.search).get('debugStartup') === '1'
  const categoryRows = $derived<ReadonlyArray<CategoryRow>>(categoryRowsForSurface(allCategoryRows, railConfig))
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
  const activeMapLayerGroups = $derived(activePack?.mapLayerGroups ?? emptyMapLayerGroups)
  const activePackAreaFeatureLayers = $derived(activePack?.mapAreaFeatureLayers ?? emptyMapAreaFeatureLayers)
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
  // runtimeConfigs (the same payload the multi adapter consumes at connect
  // time) and then update optimistically on each successful command.
  let aviationActiveSourceId = $state<'opensky' | 'vatsim'>('opensky')
  let pendingSourceSwitch = $state(false)
  $effect(() => {
    const scenario = scenarioDefinition
    if (!scenario) return
    // runtimeConfigs is keyed by pack id, not runtime id — the catalog
    // routes pack-id-keyed configs to the active runtime at connect time.
    const cfg = (scenario.runtimeConfigs ?? {})['aviation'] as { source?: string } | undefined
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
    const activeRuntimeId = scenarioDefinition.runtimeOverrides[activePack.id]
      ?? activePack.defaultRuntimeId
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

  const requireActivePack = (): LeitbildPack => {
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

  const mapAreaFeaturesFor = createMapAreaFeatureLoader({
    pack: () => activePack,
    objects: () => objects,
    controlInstanceId: () => controlInstanceId,
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
      controlInstance: {
        id: controlInstanceId,
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
          markStartup('process-surface-preload:start')
          await loadProcessSurfaceModal()
          markStartup('process-surface-preload:done')
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

  const loadProcessSurfaceModal = async (): Promise<void> => {
    if (ProcessSurfaceModal) return
    processSurfaceModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../process-surface/ProcessSurfaceModal.svelte')
      return module.default
    })()
    try {
      ProcessSurfaceModal = await processSurfaceModalLoadPromise
    } catch (err) {
      processSurfaceModalLoadPromise = null
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
    void loadScenarioOptions()
  }

  const openProcessSurface = (object: OperationalObject): void => {
    processSurfaceObject = object
    void loadProcessSurfaceModal()
  }

  const closeProcessSurface = (): void => {
    processSurfaceObject = null
  }

  const processPlantSystemIdFor = (object: OperationalObject): string | null => {
    if (object.packId !== 'process-plant') return null
    const data = object.packData
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
    const systemId = (data as Record<string, unknown>).systemId
    return typeof systemId === 'string' && systemId.length > 0 ? systemId : null
  }

  const procedureSystemId = $derived(procedureSystemObject === null
    ? null
    : processPlantSystemIdFor(procedureSystemObject))

  const openProcedureSystem = (object: OperationalObject): void => {
    if (processPlantSystemIdFor(object) === null) return
    procedureSystemObject = object
    void loadProcedureSystemModal()
  }

  const closeProcedureSystem = (): void => {
    procedureSystemObject = null
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
    pendingRealtimeControlInstanceId = null
    startupSteps = resetStartupStepsAfter(startupSteps, 'control-instance')
  }

  const activeRoute = () => parseControlSurfaceRoute(location.pathname)

  const scenarioIdForReset = (): string | undefined =>
    scenarioState?.scenarioId

  const loadScenarioOptions = async (): Promise<void> => {
    if (scenarioOptionsLoaded) return
    const body = await listScenariosClient()
    scenarioOptions = body.scenarios
    scenarioOptionsLoaded = true
  }

  const loadScenarioDefinitionAndPack = async (scenarioId: string): Promise<ScenarioDefinition> => {
    markStartup('scenario-fetch:start')
    const body = await fetchScenario(scenarioId)
    markStartup('scenario-fetch:done')
    return await loadScenarioDefinitionAndPackFromDefinition(body.scenario)
  }

  const loadScenarioDefinitionAndPackFromDefinition = async (scenario: ScenarioDefinition): Promise<ScenarioDefinition> => {
    markStartup('pack-load:start')
    const nextPack = await createScenarioControlPack(scenario.packs)
    markStartup('pack-load:done')
    scenarioDefinition = scenario
    activePack = nextPack
    return scenario
  }

  const createScenarioRun = async (scenarioId: string, navigation: 'assign' | 'replace' = 'assign'): Promise<void> => {
    status = 'Opening Control Instance'
    const runId = createGeneratedRunId()
    const nextPath = pathForScenarioRun(scenarioId, runId)
    if (navigation === 'replace') {
      location.replace(nextPath)
      return
    }
    location.href = nextPath
  }

  const defaultName = (type: PackCreateObjectType): string =>
    requireActivePack().defaultObjectLabel(type.id, { objects })

  const syncControlInstanceSnapshot = async (): Promise<void> => {
    if (!controlInstanceId) return
    const body = await syncControlInstanceSnapshotClient(controlInstanceId)
    objects = [...body.snapshot.objects]
    scenarioState = body.snapshot.scenario
    clock = body.snapshot.clock
  }

  const sendCommand = async (kind: string, payload: unknown, targetObjectIds: readonly string[] = []): Promise<void> => {
    if (!controlInstanceId) return
    if (!realtimeAttached) {
      commandStatus = 'Wait for realtime attachment before sending commands'
      return
    }
    let body
    try {
      body = await sendControlInstanceCommand(controlInstanceId, { kind, targetObjectIds, payload })
    } catch (err) {
      commandStatus = err instanceof Error ? err.message : 'command failed'
      return
    }
    if (!body.result.ok) {
      commandStatus = `Command rejected: ${body.result.reason ?? 'unknown reason'}`
      return
    }
    commandStatus = 'Command accepted'
    await syncControlInstanceSnapshot()
  }

  const deleteObject = async (object: OperationalObject): Promise<void> => {
    commandStatus = `Deleting ${object.label}`
    await sendCommand(deleteObjectCommandKind, { objectId: object.id }, [object.id])
  }

  const createObject = async (draft: CreateDraft): Promise<void> => {
    placement.clearDraft()
    commandStatus = `Creating ${draft.objectType.label}`
    const pack = requireActivePack()
    const command = pack.buildCreateObjectCommand(
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
    if (!pack.isTarget(controller, destination, { objects })) return
    commandStatus = `Sending ${controller.label} to ${destination.label}`
    const command = pack.buildSetTargetCommand(controller, destination, { objects })
    await sendCommand(command.kind, command.payload, command.targetObjectIds)
  }

  const selectObject = (object: OperationalObject): void => {
    markSeen(object)
    const pack = requireActivePack()
    if (pack.isController(object)) {
      selectedControllerId = object.id
      commandStatus = `Selected ${object.label}; click a valid target`
      return
    }
    const controller = selectedControllerObject
    if (controller && pack.isTarget(controller, object, { objects })) {
      void setDestination(object)
    }
  }

  const connectWebSocket = (id: ControlInstanceId): void => {
    if (mapVisible && !mapReady) {
      pendingRealtimeControlInstanceId = id
      startStep('realtime')
      status = 'Waiting for map first frame before realtime updates'
      return
    }
    pendingRealtimeControlInstanceId = null
    startStep('realtime')
    if (realtimeConnection.canCarry(id)) {
      status = realtimeConnection.statusFor(id) === 'open' ? 'Realtime channel open' : 'Connecting'
      completeReadyWhenReady()
      return
    }
    realtimeAttached = false
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
        if (parsed.controlInstanceId !== id) {
          failStep('realtime', `Realtime attached to ${parsed.controlInstanceId}, expected ${id}`)
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
        if (parsed.controlInstanceId !== id) return
        if (expectedRealtimeScenarioId !== null && parsed.scenarioId !== expectedRealtimeScenarioId) return
        if (!realtimeAttached) return
        const applied = applyControlInstanceEventBatchMessage({ objects, selectedControllerId, scenarioState }, parsed)
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
    })
  }

  const connectPendingRealtime = (): void => {
    const id = pendingRealtimeControlInstanceId
    if (!id) return
    pendingRealtimeControlInstanceId = null
    connectWebSocket(id)
  }

  const controlInstanceIdFromPath = (): ControlInstanceId => {
    const route = activeRoute()
    if (route.mode !== 'control-instance') throw new Error('control instance route expected')
    if (location.pathname !== route.canonicalPath) history.replaceState(null, '', route.canonicalPath)
    return route.controlInstanceId
  }

  const completeStartupFromResponse = async (
    response: ControlInstanceResponse,
    config: {
      readonly rememberRecentRun?: () => void
      readonly onRememberRecentRunFailed?: (error: unknown) => void
      readonly setActiveStartupStep: (id: StartupStepId) => void
    },
  ): Promise<void> => {
    const scenarioId = response.snapshot.scenario?.scenarioId
    if (!scenarioId) throw new Error('control instance snapshot is missing scenario state')
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
      setControlInstanceId: id => {
        controlInstanceId = id
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
      ...(config.rememberRecentRun === undefined ? {} : { rememberRecentRun: config.rememberRecentRun }),
      ...(config.onRememberRecentRunFailed === undefined ? {} : { onRememberRecentRunFailed: config.onRememberRecentRunFailed }),
    })
  }

  const joinControlInstance = async (): Promise<void> => {
    realtimeConnection.disconnect()
    realtimeAttached = false
    resetStartupForJoin()
    snapshotReady = false
    mapReady = false
    scenarioDefinition = null
    activePack = null
    status = 'Starting'
    startStep('control-instance')
    let activeStartupStep: StartupStepId = 'control-instance'
    try {
      const id = controlInstanceIdFromPath()
      const route = activeRoute()
      if (route.mode !== 'control-instance') throw new Error('control instance route expected')
      expectedRealtimeScenarioId = route.scenarioId
      markStartup('join-request:start')
      const body = await joinControlInstanceClient(id, { scenarioId: route.scenarioId })
      markStartup('join-request:done')
      await completeStartupFromResponse(body, {
        setActiveStartupStep: id => {
          activeStartupStep = id
        },
        rememberRecentRun: () => rememberRecentScenarioRun(route.scenarioId, route.runId),
        onRememberRecentRunFailed: err => {
          commandStatus = err instanceof Error ? err.message : 'Unable to remember scenario run'
        },
      })
    } catch (err) {
      failStep(activeStartupStep, err)
    }
  }

  const resetScenario = async (): Promise<void> => {
    if (!controlInstanceId) return
    realtimeAttached = false
    resetStartupForJoin()
    snapshotReady = false
    mapReady = false
    scenarioDefinition = null
    activePack = null
    status = 'Resetting'
    commandStatus = 'Resetting scenario'
    startStep('control-instance')
    let activeStartupStep: StartupStepId = 'control-instance'
    try {
      const requestedScenarioId = scenarioIdForReset()
      expectedRealtimeScenarioId = requestedScenarioId ?? null
      startStep('realtime')
      const body = await resetControlInstance(controlInstanceId, { scenarioId: requestedScenarioId })
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

  const selectScenario = async (scenarioId: string): Promise<void> => {
    let rememberedPath: string | null
    try {
      rememberedPath = pathForRecentScenarioRun(scenarioId)
    } catch (err) {
      commandStatus = err instanceof Error ? err.message : 'Unable to read recent scenario runs'
      return
    }
    location.href = rememberedPath ?? pathForNewScenarioRun(scenarioId)
  }

  const toggleClockPaused = async (): Promise<void> => {
    if (!controlInstanceId || !clock) return
    const body = await setControlInstanceClock(controlInstanceId, { paused: !clock.paused })
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
      if (route.mode === 'picker') throw new Error('control surface route expected')
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
    if (route.mode === 'new-run') {
      void createScenarioRun(route.scenarioId, 'replace')
      return () => {
        cleanupInternalDiagnosticsGlobal()
        longTaskMonitor?.stop()
        longTaskMonitor = null
        removePlacementGlobalEvents()
        railLayout.stopResize()
        clearStartupAutoDismissTimer()
      }
    }
    preloadOperationalMapModule()
    void joinControlInstance()
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
        {openProcessSurface}
        {openProcedureSystem}
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
          {controlInstanceId}
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

{#if processSurfaceObject && ProcessSurfaceModal && controlInstanceId}
  <ProcessSurfaceModal
    {controlInstanceId}
    object={processSurfaceObject}
    {procedureRevision}
    close={closeProcessSurface}
  />
{/if}

{#if procedureSystemObject && procedureSystemId && ProcedureSystemModal && controlInstanceId}
  <ProcedureSystemModal
    {controlInstanceId}
    systemId={procedureSystemId}
    realtimeRevision={procedureRevision}
    close={closeProcedureSystem}
  />
{/if}

{#if startupModalVisible}
  <StartupModal
    steps={startupSteps}
    tone={systemStatusTone}
    retry={joinControlInstance}
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
    scenarios={scenarioOptions}
    selectedScenarioId={scenarioState?.scenarioId ?? ''}
    close={closeSettings}
    {toggleTheme}
    {toggleWeatherLayer}
    {resetScenario}
    {selectScenario}
  />
{/if}
