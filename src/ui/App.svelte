<script lang="ts">
  import type { Component } from 'svelte'
  import { tick } from 'svelte'
  import type { OperationalObject, ControlInstanceId } from '../core/model/index.ts'
  import { deleteObjectCommandKind } from '../core/model/index.ts'
  import { createCompositePack } from '../core/packs/composite.ts'
  import type { LeitbildPack, PackCreateObjectType, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { ambulancePack } from '../packs/ambulance/pack.ts'
  import { trafficPack } from '../packs/traffic/pack.ts'
  import {
    createControlInstance,
    joinControlInstance as joinControlInstanceClient,
    listControlInstances,
    resetControlInstance,
    sendControlInstanceCommand,
    syncControlInstanceSnapshot as syncControlInstanceSnapshotClient,
  } from './control-instance-client.ts'
  import {
    applyControlInstanceEventBatchMessage,
    parseControlInstanceEventBatchMessage,
  } from './control-instance-events.ts'
  import {
    categoryRowsFor,
    placementCursorFor,
    selectedControllerObjectFor,
  } from './control-surface-selectors.ts'
  import { createPlacementState } from './placement-state.svelte.ts'
  import { createRailLayoutState } from './rail-layout-state.svelte.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import ControlRail from './ControlRail.svelte'
  import CreateObjectModal from './CreateObjectModal.svelte'
  import InstancePicker from './InstancePicker.svelte'
  import StartupModal from './StartupModal.svelte'
  import type { StatusTone } from './components/StatusDot.svelte'
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
  import type { CategoryRow, ControlInstanceSummary, CreateDraft } from './types.ts'

  const activePack: LeitbildPack = createCompositePack({
    id: 'leitbild-control',
    name: 'Leitbild Control',
    packs: [ambulancePack, trafficPack],
  })
  const appVersion = __LEITBILD_VERSION__
  let controlInstanceId = $state<ControlInstanceId | null>(null)
  let objects = $state<OperationalObject[]>([])
  let selectedControllerId = $state<string | null>(null)
  let status = $state('Starting')
  let commandStatus = $state('')
  let routeMode = $state<'picker' | 'control-instance'>('control-instance')
  let instances = $state<ReadonlyArray<ControlInstanceSummary>>([])
  let seenRevisions = $state(new Map<string, number>())
  let controlInstanceSocket = $state<WebSocket | null>(null)
  let routeRevision = $state(0)
  let startupSteps = $state<ReadonlyArray<StartupStep>>(createStartupSteps())
  let mapReady = $state(false)
  let snapshotReady = $state(false)
  let startupDismissed = $state(false)
  let startupStatusModalOpen = $state(false)
  let MapSurface = $state<Component | null>(null)
  let theme = $state<ThemeMode>('light')
  const railLayout = createRailLayoutState()
  const placement = createPlacementState({
    packId: activePack.id,
    defaultName: (type) => defaultName(type),
    setCommandStatus: (nextStatus) => {
      commandStatus = nextStatus
    },
  })
  const placementMode = $derived(placement.mode)
  const createDraft = $derived(placement.draft)
  const selectedControllerObject = $derived(selectedControllerObjectFor(objects, selectedControllerId, activePack))
  const categoryRows = $derived<ReadonlyArray<CategoryRow>>(categoryRowsFor(objects, activePack))
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

  const hasNewInfo = (object: OperationalObject): boolean =>
    (seenRevisions.get(object.id) ?? object.revision) < object.revision

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

  const completeObjectsWhenReady = async (): Promise<void> => {
    if (!mapReady || !snapshotReady) return
    await tick()
    completeStep('objects')
  }

  const closeStartupModal = (): void => {
    startupDismissed = true
    startupStatusModalOpen = false
  }

  const openStatusModal = (): void => {
    startupStatusModalOpen = true
  }

  const resetStartupForJoin = (): void => {
    startupDismissed = false
    startupSteps = resetStartupStepsAfter(startupSteps, 'control-instance')
    if (mapReady) completeStep('map')
  }

  const openInstance = (id: string): void => {
    location.href = `/i/${encodeURIComponent(id)}`
  }

  const scenarioIdFromUrl = (): string | undefined => {
    const value = new URLSearchParams(location.search).get('scenario')?.trim()
    return value ? value : undefined
  }

  const createInstance = async (): Promise<void> => {
    status = 'Creating Control Instance'
    const body = await createControlInstance({ scenarioId: scenarioIdFromUrl() })
    openInstance(body.id)
  }

  const defaultName = (type: PackCreateObjectType): string =>
    activePack.defaultObjectLabel(type.id, { objects })

  const syncControlInstanceSnapshot = async (): Promise<void> => {
    if (!controlInstanceId) return
    const body = await syncControlInstanceSnapshotClient(controlInstanceId)
    objects = [...body.snapshot.objects]
  }

  const sendCommand = async (kind: string, payload: unknown, targetObjectIds: readonly string[] = []): Promise<void> => {
    if (!controlInstanceId) return
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

  const connectWebSocket = (id: ControlInstanceId): void => {
    controlInstanceSocket?.close()
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/ws?controlInstance=${encodeURIComponent(id)}`)
    controlInstanceSocket = socket
    startStep('realtime')
    socket.onopen = () => {
      status = 'Connected'
      completeStep('realtime')
      completeStep('ready')
    }
    socket.onclose = () => {
      if (controlInstanceSocket !== socket) return
      controlInstanceSocket = null
      status = 'Disconnected'
    }
    socket.onerror = () => {
      status = 'WebSocket error'
      failStep('realtime', 'WebSocket error')
    }
    socket.onmessage = (message) => {
      let parsed
      try {
        parsed = parseControlInstanceEventBatchMessage(message.data as string)
      } catch (err) {
        status = err instanceof Error ? err.message : 'Invalid WebSocket message'
        return
      }
      if (!parsed) return
      const applied = applyControlInstanceEventBatchMessage({ objects, selectedControllerId }, parsed)
      if (applied.objectUpdate) {
        objects = [...applied.objectUpdate.objects]
        selectedControllerId = applied.objectUpdate.selectedControllerId
      }
      if (applied.commandStatusUpdate) {
        commandStatus = applied.commandStatusUpdate.commandStatus
      }
      if (applied.routesChanged) {
        routeRevision += 1
      }
    }
  }

  const controlInstanceIdFromPath = (): ControlInstanceId => {
    if (location.pathname === '/') {
      history.replaceState(null, '', '/i/sandbox')
      return 'sandbox' as ControlInstanceId
    }
    const match = location.pathname.match(/^\/i\/([^/]+)$/)
    if (!match) {
      history.replaceState(null, '', '/i/sandbox')
      return 'sandbox' as ControlInstanceId
    }
    return decodeURIComponent(match[1] ?? 'sandbox') as ControlInstanceId
  }

  const routeModeFromPath = (): 'picker' | 'control-instance' => {
    if (location.pathname === '/i') return 'picker'
    return 'control-instance'
  }

  const joinControlInstance = async (): Promise<void> => {
    controlInstanceSocket?.close()
    controlInstanceSocket = null
    resetStartupForJoin()
    snapshotReady = false
    status = 'Starting'
    startStep('control-instance')
    let activeStartupStep: StartupStepId = 'control-instance'
    try {
      const id = controlInstanceIdFromPath()
      const body = await joinControlInstanceClient(id, { scenarioId: scenarioIdFromUrl() })
      completeStep('control-instance')
      activeStartupStep = 'snapshot'
      startStep('snapshot')
      controlInstanceId = body.id
      objects = [...body.snapshot.objects]
      selectedControllerId = objects.find(object => activePack.isController(object))?.id ?? null
      seenRevisions = new Map(objects.map(object => [object.id, object.revision]))
      snapshotReady = true
      completeStep('snapshot')
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
    controlInstanceSocket?.close()
    controlInstanceSocket = null
    resetStartupForJoin()
    snapshotReady = false
    status = 'Resetting'
    commandStatus = 'Resetting scenario'
    startStep('control-instance')
    let activeStartupStep: StartupStepId = 'control-instance'
    try {
      const body = await resetControlInstance(controlInstanceId, { scenarioId: scenarioIdFromUrl() })
      completeStep('control-instance')
      activeStartupStep = 'snapshot'
      startStep('snapshot')
      objects = [...body.snapshot.objects]
      selectedControllerId = objects.find(object => activePack.isController(object))?.id ?? null
      seenRevisions = new Map(objects.map(object => [object.id, object.revision]))
      snapshotReady = true
      completeStep('snapshot')
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
    const nextRouteMode = routeModeFromPath()
    routeMode = nextRouteMode
    completeStep('route')
    completeStep('interface')
    if (nextRouteMode === 'picker') {
      void loadInstances()
      return () => {
        window.removeEventListener('keydown', handleKeydown)
        window.removeEventListener('click', handleClick, { capture: true })
        railLayout.stopResize()
      }
    }
    void loadMapSurface()
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
  <InstancePicker {instances} {status} {createInstance} {openInstance} />
{:else}
  <div class:rail-collapsed={railLayout.collapsed} class="app-shell" style={`--rail-width: ${railLayout.width}px`}>
    <ControlRail
      {status}
      {systemStatusTone}
      {appVersion}
      {theme}
      collapsed={railLayout.collapsed}
      {categoryRows}
      {placementMode}
      {selectedControllerId}
      {presentationFor}
      {hasNewInfo}
      {markSeen}
      {selectObject}
      {deleteObject}
      beginPlacement={placement.begin}
      cancelPlacement={placement.cancel}
      {toggleTheme}
      {resetScenario}
      {openStatusModal}
    />
    <button
      class="rail-resize-handle"
      class:collapsed={railLayout.collapsed}
      type="button"
      aria-label={railLayout.collapsed ? 'Show control rail' : 'Resize control rail'}
      title={railLayout.collapsed ? 'Show control rail' : 'Drag to resize control rail'}
      onpointerdown={railLayout.startResize}
    ></button>

    <main class="map-region">
      {#if MapSurface}
        <MapSurface
          {objects}
          {selectedControllerId}
          {placementMode}
          {placementCursor}
          {theme}
          {routeRevision}
          layoutRevision={railLayout.layoutRevision}
          {hasNewInfo}
          {presentationFor}
          onObjectSelected={selectObject}
          onPlacementPoint={placement.placePoint}
          onObjectSeen={markSeen}
          onMapReady={handleMapReady}
          onMapError={handleMapError}
        />
      {:else}
        <div class="map-loading">Starting map...</div>
      {/if}
    </main>
  </div>
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
