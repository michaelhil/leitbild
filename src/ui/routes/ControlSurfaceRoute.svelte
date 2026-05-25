<script lang="ts">
  import type { Component } from 'svelte'
  import { tick } from 'svelte'
  import type { IsoTimestamp, OperationalObject, ControlInstanceId, ScenarioDefinition, ScenarioInstanceState, SimulationClockState } from '../../core/model/index.ts'
  import { deleteObjectCommandKind } from '../../core/model/index.ts'
  import type { LeitbildPack, PackCreateObjectType, PackObjectPresentation } from '../../core/packs/protocol.ts'
  import {
    createControlInstance,
    fetchScenario,
    joinControlInstance as joinControlInstanceClient,
    listScenarios as listScenariosClient,
    resetControlInstance,
    sendControlInstanceCommand,
    setControlInstanceClock,
    syncControlInstanceSnapshot as syncControlInstanceSnapshotClient,
  } from '../control-instance-client.ts'
  import {
    controlInstanceIdForScenarioRun,
    createGeneratedRunId,
    parseControlSurfaceRoute,
    pathForNewScenarioRun,
    pathForScenarioRun,
  } from '../control-instance-route.ts'
  import {
    applyControlInstanceEventBatchMessage,
  } from '../control-instance-events.ts'
  import { createMapAreaFeatureProvider } from '../app/map-area-feature-provider.ts'
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
    startupHasFailed,
    startupIsReady,
    startupModalShouldShow,
    startStartupStep,
    type StartupStep,
    type StartupStepId,
  } from '../startup.ts'
  import type { CategoryRow, ControlInstanceResponse, CreateDraft, ScenarioListItem } from '../types.ts'

  const appVersion = __LEITBILD_VERSION__
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
  let startupSteps = $state<ReadonlyArray<StartupStep>>(createStartupSteps())
  let mapReady = $state(false)
  let snapshotReady = $state(false)
  let startupDismissed = $state(false)
  let startupStatusModalOpen = $state(false)
  let settingsModalOpen = $state(false)
  let MapSurface = $state<Component | null>(null)
  let CreateObjectModal = $state<Component | null>(null)
  let SettingsModal = $state<Component | null>(null)
  let ProcessSurfaceModal = $state<Component | null>(null)
  let processSurfaceObject = $state<OperationalObject | null>(null)
  let theme = $state<ThemeMode>('light')
  let weatherLayerVisible = $state(true)
  let scenarioOptions = $state<ReadonlyArray<ScenarioListItem>>([])
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
  const debugMapInput = $derived(new URLSearchParams(location.search).get('debugMapInput') === '1')
  const categoryRows = $derived<ReadonlyArray<CategoryRow>>(categoryRowsForSurface(allCategoryRows, railConfig))
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

  const currentPackTime = (): IsoTimestamp | undefined =>
    simulationTimeAt(clock)

  const requireActivePack = (): LeitbildPack => {
    if (!activePack) throw new Error('scenario packs are not loaded')
    return activePack
  }

  const presentationFor = (object: OperationalObject): PackObjectPresentation =>
    requireActivePack().presentObject(object, { objects, currentTime: currentPackTime() })

  const mapAreaFeaturesFor = createMapAreaFeatureProvider({
    pack: () => activePack,
    objects: () => objects,
    controlInstanceId: () => controlInstanceId,
    currentTime: currentPackTime,
  })

  const hasNewInfo = (object: OperationalObject): boolean => {
    if (!activePack) return false
    const presentation = activePack.presentObject(object, { objects, currentTime: currentPackTime() })
    if (presentation.noteworthyUpdates !== true) return false
    return (seenRevisions.get(object.id) ?? object.revision) < object.revision
  }

  const markSeen = (object: OperationalObject): void => {
    if ((seenRevisions.get(object.id) ?? -1) >= object.revision) return
    seenRevisions = new Map([...seenRevisions, [object.id, object.revision]])
  }

  const loadMapSurface = async (): Promise<void> => {
    const module = await import('../MapSurface.svelte')
    MapSurface = module.default
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
    const module = await import('../process-surface/ProcessSurfaceModal.svelte')
    ProcessSurfaceModal = module.default
  }

  const startStep = (id: StartupStepId): void => {
    startupSteps = startStartupStep(startupSteps, id)
  }

  const completeStep = (id: StartupStepId): void => {
    startupSteps = completeStartupStep(startupSteps, id)
  }

  const failStep = (id: StartupStepId, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err)
    startupSteps = failStartupStep(startupSteps, id, message)
    status = message
  }

  const completeReadyWhenReady = (): void => {
    if (!snapshotReady || !realtimeAttached || (mapVisible && !mapReady)) return
    completeStep('ready')
  }

  const completeObjectsWhenReady = async (): Promise<void> => {
    if (!snapshotReady || (mapVisible && !mapReady)) return
    await tick()
    completeStep('objects')
    completeReadyWhenReady()
  }

  const loadSurfaceForScenario = async (scenarioId: string): Promise<void> => {
    const scenario = scenarioDefinition?.id === scenarioId
      ? scenarioDefinition
      : await loadScenarioDefinitionAndPack(scenarioId)
    if (surfaceHasPrimitive(scenario.surface, 'map')) {
      await loadMapSurface()
      return
    }
    MapSurface = null
    mapReady = false
    completeStep('map')
  }

  const closeStartupModal = (): void => {
    startupDismissed = true
    startupStatusModalOpen = false
  }

  const openStatusModal = (): void => {
    startupStatusModalOpen = true
  }

  const openSettings = (): void => {
    settingsModalOpen = true
    void loadSettingsModal()
  }

  const openProcessSurface = (object: OperationalObject): void => {
    processSurfaceObject = object
    void loadProcessSurfaceModal()
  }

  const closeProcessSurface = (): void => {
    processSurfaceObject = null
  }

  const closeSettings = (): void => {
    settingsModalOpen = false
  }

  const resetStartupForJoin = (): void => {
    startupDismissed = false
    startupSteps = resetStartupStepsAfter(startupSteps, 'control-instance')
    if (mapReady) completeStep('map')
  }

  const activeRoute = () => parseControlSurfaceRoute(location.pathname)

  const scenarioIdForReset = (): string | undefined =>
    scenarioState?.scenarioId

  const loadScenarioOptions = async (): Promise<void> => {
    const body = await listScenariosClient()
    scenarioOptions = body.scenarios
  }

  const loadScenarioDefinitionAndPack = async (scenarioId: string): Promise<ScenarioDefinition> => {
    const body = await fetchScenario(scenarioId)
    const nextPack = await createScenarioControlPack(body.scenario.packs)
    scenarioDefinition = body.scenario
    activePack = nextPack
    return body.scenario
  }

  const createScenarioRun = async (scenarioId: string, navigation: 'assign' | 'replace' = 'assign'): Promise<void> => {
    status = 'Creating Control Instance'
    startStep('control-instance')
    try {
      const runId = createGeneratedRunId()
      const id = controlInstanceIdForScenarioRun(scenarioId, runId)
      const body = await createControlInstance({ id, scenarioId })
      if (body.id !== id) throw new Error(`created control instance ${body.id}, expected ${id}`)
      const nextPath = pathForScenarioRun(scenarioId, runId)
      if (navigation === 'replace') {
        location.replace(nextPath)
        return
      }
      location.href = nextPath
    } catch (err) {
      failStep('control-instance', err)
      status = err instanceof Error ? err.message : 'control instance create failed'
    }
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
      },
    })
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
    const packScenario = scenarioDefinition?.id === scenarioId ? scenarioDefinition : await loadScenarioDefinitionAndPack(scenarioId)
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
      const body = await joinControlInstanceClient(id, { scenarioId: route.scenarioId })
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
    completeStep('map')
    startStep('objects')
    void completeObjectsWhenReady()
  }

  const handleMapError = (message: string): void => {
    failStep('map', message)
  }

  runOnMount(() => {
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
        removePlacementGlobalEvents()
        railLayout.stopResize()
      }
    }
    completeStep('route')
    completeStep('interface')
    void loadScenarioOptions()
    if (route.mode === 'new-run') {
      void createScenarioRun(route.scenarioId, 'replace')
      return () => {
        removePlacementGlobalEvents()
        railLayout.stopResize()
      }
    }
    void joinControlInstance()
    return () => {
      removePlacementGlobalEvents()
      railLayout.stopResize()
      realtimeConnection.disconnect()
    }
  })

  $effect(() => {
    if (createDraft) void loadCreateObjectModal()
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
        {presentationFor}
        {hasNewInfo}
        {markSeen}
        {selectObject}
        {deleteObject}
        {openProcessSurface}
        beginPlacement={placement.begin}
        cancelPlacement={placement.cancel}
        {openStatusModal}
        {openSettings}
        {toggleClockPaused}
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
      {#if mapVisible && MapSurface}
        <MapSurface
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
          highlightedObjectIds={scenarioState?.highlightedObjectIds ?? []}
          {hasNewInfo}
          {presentationFor}
          {mapAreaFeaturesFor}
          onObjectSelected={selectObject}
          onPlacementPoint={placement.placePoint}
          onObjectSeen={markSeen}
          onMapReady={handleMapReady}
          onMapError={handleMapError}
        />
      {:else if mapVisible}
        <div class="map-loading">Starting map...</div>
      {:else}
        <div class="surface-empty"></div>
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
    close={closeProcessSurface}
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
