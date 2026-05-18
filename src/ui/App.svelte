<script lang="ts">
  import type { Component } from 'svelte'
  import { tick } from 'svelte'
  import type { OperationalObject, ControlInstanceId, ScenarioDefinition, ScenarioInstanceState, SimulationClockState } from '../core/model/index.ts'
  import { deleteObjectCommandKind } from '../core/model/index.ts'
  import { createCompositePack } from '../core/packs/composite.ts'
  import type { LeitbildPack, PackCreateObjectType, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { ambulancePack } from '../packs/ambulance/pack.ts'
  import { trafficPack } from '../packs/traffic/pack.ts'
  import {
    createControlInstance,
    deleteControlInstance,
    fetchScenario,
    joinControlInstance as joinControlInstanceClient,
    listScenarios as listScenariosClient,
    listControlInstances,
    resetControlInstance,
    sendControlInstanceCommand,
    setControlInstanceClock,
    syncControlInstanceSnapshot as syncControlInstanceSnapshotClient,
  } from './control-instance-client.ts'
  import {
    controlInstanceIdForScenarioRun,
    createGeneratedRunId,
    parseControlSurfaceRoute,
    pathForNewScenarioRun,
    pathForScenarioRun,
  } from './control-instance-route.ts'
  import {
    applyControlInstanceEventBatchMessage,
    parseControlInstanceWebSocketMessage,
  } from './control-instance-events.ts'
  import {
    categoryRowsFor,
    placementCursorFor,
    selectedControllerObjectFor,
  } from './control-surface-selectors.ts'
  import { createPlacementState } from './placement-state.svelte.ts'
  import { pathForRecentScenarioRun, rememberRecentScenarioRun } from './recent-scenario-runs.ts'
  import { createRailLayoutState } from './rail-layout-state.svelte.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import ControlRail from './ControlRail.svelte'
  import CreateObjectModal from './CreateObjectModal.svelte'
  import InstancePicker from './InstancePicker.svelte'
  import ScenarioGuidance from './ScenarioGuidance.svelte'
  import SettingsModal from './SettingsModal.svelte'
  import StartupModal from './StartupModal.svelte'
  import type { StatusTone } from './components/StatusDot.svelte'
  import {
    categoryRowsForSurface,
    surfaceHasPrimitive,
    surfaceMapConfig,
    surfaceObjectRailConfig,
  } from './surface.ts'
  import { getTheme, initialTheme, toggleTheme as toggleThemeMode, type ThemeMode } from './theme.ts'
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
  } from './startup.ts'
  import type { CategoryRow, ControlInstanceSummary, CreateDraft, ScenarioListItem } from './types.ts'

  const activePack: LeitbildPack = createCompositePack({
    id: 'leitbild-control',
    name: 'Leitbild Control',
    packs: [ambulancePack, trafficPack],
  })
  const appVersion = __LEITBILD_VERSION__
  let controlInstanceId = $state<ControlInstanceId | null>(null)
  let objects = $state<OperationalObject[]>([])
  let scenarioState = $state<ScenarioInstanceState | undefined>(undefined)
  let clock = $state<SimulationClockState | undefined>(undefined)
  let scenarioDefinition = $state<ScenarioDefinition | null>(null)
  let selectedControllerId = $state<string | null>(null)
  let status = $state('Starting')
  let commandStatus = $state('')
  let routeMode = $state<'picker' | 'control-instance'>('control-instance')
  let instances = $state<ReadonlyArray<ControlInstanceSummary>>([])
  let seenRevisions = $state(new Map<string, number>())
  let controlInstanceSocket = $state<WebSocket | null>(null)
  let controlInstanceSocketId = $state<ControlInstanceId | null>(null)
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
  let theme = $state<ThemeMode>('light')
  let scenarioOptions = $state<ReadonlyArray<ScenarioListItem>>([])
  const railLayout = createRailLayoutState()
  const placement = createPlacementState({
    packId: activePack.id,
    defaultName: (type) => defaultName(type),
    setCommandStatus: (nextStatus) => {
      commandStatus = nextStatus
    },
  })
  const placementMode = $derived(placement.mode)
  const placementPoints = $derived(placement.points)
  const createDraft = $derived(placement.draft)
  const selectedControllerObject = $derived(selectedControllerObjectFor(objects, selectedControllerId, activePack))
  const allCategoryRows = $derived<ReadonlyArray<CategoryRow>>(categoryRowsFor(objects, activePack))
  const surface = $derived(scenarioDefinition?.surface ?? null)
  const railConfig = $derived(surfaceObjectRailConfig(surface))
  const mapConfig = $derived(surfaceMapConfig(surface))
  const mapVisible = $derived(mapConfig !== null)
  const railVisible = $derived(railConfig !== null)
  const footerVisible = $derived(surfaceHasPrimitive(surface, 'systemFooter'))
  const guidanceOverlayVisible = $derived(surfaceHasPrimitive(surface, 'guidanceOverlay'))
  const categoryRows = $derived<ReadonlyArray<CategoryRow>>(categoryRowsForSurface(allCategoryRows, railConfig))
  const placementCursor = $derived(placementCursorFor(placementMode, activePack))
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

  const presentationFor = (object: OperationalObject): PackObjectPresentation =>
    activePack.presentObject(object, { objects })

  const hasNewInfo = (object: OperationalObject): boolean => {
    const presentation = presentationFor(object)
    if (presentation.noteworthyUpdates !== true) return false
    return (seenRevisions.get(object.id) ?? object.revision) < object.revision
  }

  const markSeen = (object: OperationalObject): void => {
    if ((seenRevisions.get(object.id) ?? -1) >= object.revision) return
    seenRevisions = new Map([...seenRevisions, [object.id, object.revision]])
  }

  const loadInstances = async (): Promise<void> => {
    const body = await listControlInstances()
    instances = body.controlInstances
    status = 'Ready'
  }

  const loadMapSurface = async (): Promise<void> => {
    const module = await import('./MapSurface.svelte')
    MapSurface = module.default
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
    const body = await fetchScenario(scenarioId)
    scenarioDefinition = body.scenario
    if (surfaceHasPrimitive(body.scenario.surface, 'map')) {
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
  }

  const closeSettings = (): void => {
    settingsModalOpen = false
  }

  const resetStartupForJoin = (): void => {
    startupDismissed = false
    startupSteps = resetStartupStepsAfter(startupSteps, 'control-instance')
    if (mapReady) completeStep('map')
  }

  const openScenarioRun = (scenarioId: string, runId: string): void => {
    location.href = pathForScenarioRun(scenarioId, runId)
  }

  const activeRoute = () => parseControlSurfaceRoute(location.pathname)

  const scenarioIdForReset = (): string | undefined =>
    scenarioState?.scenarioId

  const loadScenarioOptions = async (): Promise<void> => {
    const body = await listScenariosClient()
    scenarioOptions = body.scenarios
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

  const deleteScenarioRun = async (controlInstance: ControlInstanceSummary): Promise<void> => {
    if (controlInstance.websocketClientCount > 0) {
      status = `Cannot delete ${controlInstance.runId ?? controlInstance.id}: users are connected`
      return
    }
    const confirmed = window.confirm(`Delete run ${controlInstance.runId ?? controlInstance.id}? This stops the run and removes its persisted state.`)
    if (!confirmed) return
    status = 'Deleting run'
    try {
      await deleteControlInstance(controlInstance.id)
      await loadInstances()
    } catch (err) {
      status = err instanceof Error ? err.message : 'control instance delete failed'
    }
  }

  const defaultName = (type: PackCreateObjectType): string =>
    activePack.defaultObjectLabel(type.id, { objects })

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
    const parameters = {
      severity: draft.trafficSeverity,
      speedFactor: draft.trafficSpeedFactor,
      reason: draft.trafficReason,
    }
    const command = activePack.buildCreateObjectCommand(
      draft.objectType.id,
      draft.label.trim() || defaultName(draft.objectType),
      draft.geometry,
      parameters,
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
    if (!activePack.isTarget(controller, destination, { objects })) return
    commandStatus = `Sending ${controller.label} to ${destination.label}`
    const command = activePack.buildSetTargetCommand(controller, destination, { objects })
    await sendCommand(command.kind, command.payload, command.targetObjectIds)
  }

  const selectObject = (object: OperationalObject): void => {
    markSeen(object)
    if (activePack.isController(object)) {
      selectedControllerId = object.id
      commandStatus = `Selected ${object.label}; click a valid target`
      return
    }
    const controller = selectedControllerObject
    if (controller && activePack.isTarget(controller, object, { objects })) {
      void setDestination(object)
    }
  }

  const socketCanCarryControlInstance = (id: ControlInstanceId): boolean =>
    controlInstanceSocket !== null
    && controlInstanceSocketId === id
    && (controlInstanceSocket.readyState === WebSocket.OPEN || controlInstanceSocket.readyState === WebSocket.CONNECTING)

  const connectWebSocket = (id: ControlInstanceId): void => {
    startStep('realtime')
    if (socketCanCarryControlInstance(id)) {
      status = controlInstanceSocket?.readyState === WebSocket.OPEN ? 'Realtime channel open' : 'Connecting'
      completeReadyWhenReady()
      return
    }
    realtimeAttached = false
    controlInstanceSocket?.close()
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/ws?controlInstance=${encodeURIComponent(id)}`)
    controlInstanceSocket = socket
    controlInstanceSocketId = id
    socket.onopen = () => {
      if (controlInstanceSocket !== socket) return
      status = 'Realtime channel open'
    }
    socket.onclose = () => {
      if (controlInstanceSocket !== socket) return
      controlInstanceSocket = null
      controlInstanceSocketId = null
      realtimeAttached = false
      status = 'Disconnected'
    }
    socket.onerror = () => {
      if (controlInstanceSocket !== socket) return
      status = 'WebSocket error'
      failStep('realtime', 'WebSocket error')
    }
    socket.onmessage = (message) => {
      let parsed
      try {
        parsed = parseControlInstanceWebSocketMessage(message.data as string)
      } catch (err) {
        status = err instanceof Error ? err.message : 'Invalid WebSocket message'
        return
      }
      if (!parsed) return
      if (parsed.type === 'realtime.ready') {
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
        return
      }
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
    }
  }

  const controlInstanceIdFromPath = (): ControlInstanceId => {
    const route = activeRoute()
    if (route.mode !== 'control-instance') throw new Error('control instance route expected')
    if (location.pathname !== route.canonicalPath) history.replaceState(null, '', route.canonicalPath)
    return route.controlInstanceId
  }

  const routeModeFromPath = (): 'picker' | 'control-instance' => {
    return activeRoute().mode === 'picker' ? 'picker' : 'control-instance'
  }

  const joinControlInstance = async (): Promise<void> => {
    controlInstanceSocket?.close()
    controlInstanceSocket = null
    controlInstanceSocketId = null
    realtimeAttached = false
    resetStartupForJoin()
    snapshotReady = false
    mapReady = false
    scenarioDefinition = null
    status = 'Starting'
    startStep('control-instance')
    let activeStartupStep: StartupStepId = 'control-instance'
    try {
      const id = controlInstanceIdFromPath()
      const route = activeRoute()
      if (route.mode !== 'control-instance') throw new Error('control instance route expected')
      expectedRealtimeScenarioId = route.scenarioId
      const body = await joinControlInstanceClient(id, { scenarioId: route.scenarioId })
      completeStep('control-instance')
      activeStartupStep = 'snapshot'
      startStep('snapshot')
      controlInstanceId = body.id
      objects = [...body.snapshot.objects]
      scenarioState = body.snapshot.scenario
      clock = body.snapshot.clock
      if (!scenarioState?.scenarioId) throw new Error('control instance snapshot is missing scenario state')
      expectedRealtimeScenarioId = scenarioState.scenarioId
      try {
        rememberRecentScenarioRun(route.scenarioId, route.runId)
      } catch (err) {
        commandStatus = err instanceof Error ? err.message : 'Unable to remember scenario run'
      }
      selectedControllerId = objects.find(object => activePack.isController(object))?.id ?? null
      seenRevisions = new Map(objects.map(object => [object.id, object.revision]))
      snapshotReady = true
      completeStep('snapshot')
      activeStartupStep = 'map'
      startStep('map')
      await loadSurfaceForScenario(scenarioState.scenarioId)
      activeStartupStep = 'objects'
      startStep('objects')
      await completeObjectsWhenReady()
      activeStartupStep = 'realtime'
      connectWebSocket(body.id)
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
    status = 'Resetting'
    commandStatus = 'Resetting scenario'
    startStep('control-instance')
    let activeStartupStep: StartupStepId = 'control-instance'
    try {
      const requestedScenarioId = scenarioIdForReset()
      expectedRealtimeScenarioId = requestedScenarioId ?? null
      startStep('realtime')
      const body = await resetControlInstance(controlInstanceId, { scenarioId: requestedScenarioId })
      completeStep('control-instance')
      activeStartupStep = 'snapshot'
      startStep('snapshot')
      objects = [...body.snapshot.objects]
      scenarioState = body.snapshot.scenario
      clock = body.snapshot.clock
      if (!scenarioState?.scenarioId) throw new Error('control instance snapshot is missing scenario state')
      expectedRealtimeScenarioId = scenarioState.scenarioId
      selectedControllerId = objects.find(object => activePack.isController(object))?.id ?? null
      seenRevisions = new Map(objects.map(object => [object.id, object.revision]))
      snapshotReady = true
      completeStep('snapshot')
      activeStartupStep = 'map'
      startStep('map')
      await loadSurfaceForScenario(scenarioState.scenarioId)
      activeStartupStep = 'objects'
      startStep('objects')
      await completeObjectsWhenReady()
      activeStartupStep = 'realtime'
      connectWebSocket(body.id)
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
    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') placement.cancel()
      if (event.key === 'Enter' && placementMode && (placementMode.placementKind ?? 'point') === 'polygon') {
        event.preventDefault()
        placement.finishPolygon()
      }
    }
    const handleClick = (event: MouseEvent): void => {
      if (!placementMode) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.map-region')) return
      placement.cancel()
      event.stopImmediatePropagation()
      event.stopPropagation()
      event.preventDefault()
    }
    window.addEventListener('keydown', handleKeydown)
    window.addEventListener('click', handleClick, { capture: true })
    let nextRouteMode: 'picker' | 'control-instance'
    try {
      nextRouteMode = routeModeFromPath()
    } catch (err) {
      routeMode = 'control-instance'
      failStep('route', err)
      return () => {
        window.removeEventListener('keydown', handleKeydown)
        window.removeEventListener('click', handleClick, { capture: true })
        railLayout.stopResize()
      }
    }
    routeMode = nextRouteMode
    completeStep('route')
    completeStep('interface')
    void loadScenarioOptions()
    const route = activeRoute()
    if (nextRouteMode === 'picker') {
      void loadInstances()
      return () => {
        window.removeEventListener('keydown', handleKeydown)
        window.removeEventListener('click', handleClick, { capture: true })
        railLayout.stopResize()
      }
    }
    if (route.mode === 'new-run') {
      void createScenarioRun(route.scenarioId, 'replace')
      return () => {
        window.removeEventListener('keydown', handleKeydown)
        window.removeEventListener('click', handleClick, { capture: true })
        railLayout.stopResize()
      }
    }
    void joinControlInstance()
    return () => {
      window.removeEventListener('keydown', handleKeydown)
      window.removeEventListener('click', handleClick, { capture: true })
      railLayout.stopResize()
      controlInstanceSocket?.close()
      controlInstanceSocket = null
    }
  })
</script>

{#if routeMode === 'picker'}
  <InstancePicker
    scenarios={scenarioOptions}
    {instances}
    {status}
    {createScenarioRun}
    {openScenarioRun}
    {deleteScenarioRun}
  />
{:else}
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
            mapConfig={mapConfig}
            {routeRevision}
            layoutRevision={railLayout.layoutRevision}
            highlightedObjectIds={scenarioState?.highlightedObjectIds ?? []}
            {hasNewInfo}
            {presentationFor}
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

{#if createDraft}
  <CreateObjectModal {createDraft} {createObject} cancelCreate={placement.cancel} />
{/if}

{#if settingsModalOpen}
  <SettingsModal
    {theme}
    scenarios={scenarioOptions}
    selectedScenarioId={scenarioState?.scenarioId ?? ''}
    close={closeSettings}
    {toggleTheme}
    {resetScenario}
    {selectScenario}
  />
{/if}
