<script lang="ts">
  import type { Component } from 'svelte'
  import { onDestroy, onMount, tick } from 'svelte'
  import type { GeoJsonPoint, GeoJsonPolygon, OperationalObject, ControlInstanceId } from '../core/model/index.ts'
  import { createCompositePack } from '../core/packs/composite.ts'
  import type { LeitbildPack, PackCreateObjectType, PackCreationGeometry, PackObjectPresentation } from '../core/packs/protocol.ts'
  import type { TrafficSeverity } from '../domains/traffic/model.ts'
  import { ambulancePack } from '../domains/ambulance/pack.ts'
  import { trafficPack } from '../domains/traffic/pack.ts'
  import { isIconName, type IconName } from './icons.ts'
  import {
    createControlInstance,
    joinControlInstance as joinControlInstanceClient,
    listControlInstances,
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
  import ControlRail from './ControlRail.svelte'
  import CreateObjectModal from './CreateObjectModal.svelte'
  import InstancePicker from './InstancePicker.svelte'
  import StartupModal from './StartupModal.svelte'
  import { getTheme, initialTheme, toggleTheme as toggleThemeMode, type ThemeMode } from './theme.ts'
  import {
    completeStartupStep,
    createStartupSteps,
    failStartupStep,
    resetStartupStepsAfter,
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
  const railStorageKey = 'leitbild.controlRailWidth'
  const defaultRailWidth = 360
  const minRailWidth = 280
  const maxRailWidth = 560
  const collapseThreshold = 180
  let controlInstanceId: ControlInstanceId | null = null
  let objects: OperationalObject[] = []
  let selectedControllerId: string | null = null
  let placementMode: PackCreateObjectType | null = null
  let createDraft: CreateDraft | null = null
  let placementPoints: GeoJsonPoint[] = []
  let status = 'Starting'
  let commandStatus = ''
  let routeMode: 'picker' | 'control-instance' = 'control-instance'
  let instances: ReadonlyArray<ControlInstanceSummary> = []
  let seenRevisions = new Map<string, number>()
  let selectedControllerObject: OperationalObject | null = null
  let categoryRows: ReadonlyArray<CategoryRow> = []
  let controlInstanceSocket: WebSocket | null = null
  let placementCursor: { readonly icon: IconName; readonly color: string } | null = null
  let routeRevision = 0
  let startupSteps: ReadonlyArray<StartupStep> = createStartupSteps()
  let mapReady = false
  let snapshotReady = false
  let startupMinimumElapsed = false
  let startupDismissed = false
  let startupMinimumTimer: number | null = null
  let startupModalVisible = false
  let MapSurface: Component | null = null
  let theme: ThemeMode = 'light'
  let railWidth = defaultRailWidth
  let lastOpenRailWidth = defaultRailWidth
  let railResizing = false
  let layoutRevision = 0

  const readStoredRailWidth = (): number => {
    try {
      const raw = localStorage.getItem(railStorageKey)
      if (!raw) return defaultRailWidth
      const parsed = Number(raw)
      if (!Number.isFinite(parsed) || parsed < 0) return defaultRailWidth
      return parsed === 0 ? 0 : Math.max(minRailWidth, Math.min(maxRailWidth, parsed))
    } catch (error) {
      console.warn('Unable to read Leitbild rail width preference', error)
      return defaultRailWidth
    }
  }

  const storeRailWidth = (width: number): void => {
    try {
      localStorage.setItem(railStorageKey, String(width))
    } catch (error) {
      console.warn('Unable to store Leitbild rail width preference', error)
    }
  }

  const setRailWidth = (width: number, persist = false): void => {
    railWidth = width
    if (width >= minRailWidth) lastOpenRailWidth = width
    layoutRevision += 1
    if (persist) storeRailWidth(width)
  }

  const widthFromPointer = (clientX: number): number => {
    const clamped = Math.max(0, Math.min(maxRailWidth, clientX))
    return clamped < collapseThreshold ? 0 : Math.max(minRailWidth, clamped)
  }

  const stopRailResize = (): void => {
    if (!railResizing) return
    railResizing = false
    document.body.classList.remove('rail-resizing')
    window.removeEventListener('pointermove', handleRailPointerMove)
    window.removeEventListener('pointerup', stopRailResize)
    storeRailWidth(railWidth)
  }

  const handleRailPointerMove = (event: PointerEvent): void => {
    if (!railResizing) return
    setRailWidth(widthFromPointer(event.clientX))
  }

  const startRailResize = (event: PointerEvent): void => {
    event.preventDefault()
    if (railWidth === 0) {
      setRailWidth(lastOpenRailWidth || defaultRailWidth, true)
      return
    }
    railResizing = true
    document.body.classList.add('rail-resizing')
    window.addEventListener('pointermove', handleRailPointerMove)
    window.addEventListener('pointerup', stopRailResize)
  }

  const toggleTheme = (): void => {
    theme = toggleThemeMode()
  }

  const presentationFor = (object: OperationalObject): PackObjectPresentation =>
    activePack.presentObject(object, { objects })

  const iconForPresentation = (presentation: PackObjectPresentation): IconName => {
    if (!isIconName(presentation.icon)) throw new Error(`pack ${activePack.id} requested unknown icon: ${presentation.icon}`)
    return presentation.icon
  }

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
    startupModalVisible = false
  }

  const resetStartupForJoin = (): void => {
    startupSteps = resetStartupStepsAfter(startupSteps, 'control-instance')
    if (mapReady) completeStep('map')
  }

  const openInstance = (id: string): void => {
    location.href = `/i/${encodeURIComponent(id)}`
  }

  const createInstance = async (): Promise<void> => {
    status = 'Creating Control Instance'
    const body = await createControlInstance()
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

  const createObject = async (): Promise<void> => {
    if (!createDraft) return
    const draft = createDraft
    createDraft = null
    placementMode = null
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

  const cancelDestination = async (): Promise<void> => {
    const controller = selectedControllerObject
    if (!controller) return
    commandStatus = `Stopping ${controller.label}`
    const command = activePack.buildCancelTargetCommand(controller, { objects })
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

  const detailLines = (object: OperationalObject): ReadonlyArray<string> => {
    return presentationFor(object).detailLines
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
      const body = await joinControlInstanceClient(id)
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

  const handleMapReady = (): void => {
    mapReady = true
    completeStep('map')
    startStep('objects')
    void completeObjectsWhenReady()
  }

  const handleMapError = (message: string): void => {
    failStep('map', message)
  }

  const beginPlacement = (type: PackCreateObjectType): void => {
    if (!isIconName(type.icon)) throw new Error(`pack ${activePack.id} requested unknown create cursor icon: ${type.icon}`)
    placementMode = type
    createDraft = null
    placementPoints = []
    const placementKind = type.placementKind ?? 'point'
    commandStatus = placementKind === 'route'
      ? `Click start point for new ${type.label.toLowerCase()}`
      : placementKind === 'polygon'
        ? `Click polygon vertices for new ${type.label.toLowerCase()}; press Enter to finish`
        : `Click map to place new ${type.label.toLowerCase()}`
  }

  const defaultTrafficSeverity = (): TrafficSeverity => 'high'

  const closePolygon = (points: ReadonlyArray<GeoJsonPoint>): GeoJsonPolygon => {
    if (points.length < 3) throw new Error('traffic area requires at least three points')
    const coordinates = points.map(point => point.coordinates)
    const first = coordinates[0]
    if (!first) throw new Error('traffic area requires at least one point')
    const last = coordinates[coordinates.length - 1]
    const closed = last && last[0] === first[0] && last[1] === first[1]
      ? coordinates
      : [...coordinates, first]
    return { type: 'Polygon', coordinates: [closed] }
  }

  const defaultTrafficDraftFields = (type: PackCreateObjectType): Pick<CreateDraft, 'trafficSeverity' | 'trafficSpeedFactor' | 'trafficReason'> =>
    type.id === 'traffic_road_segment' || type.id === 'traffic_area'
      ? {
          trafficSeverity: defaultTrafficSeverity(),
          trafficSpeedFactor: 0.55,
          trafficReason: 'Operator-created traffic condition',
        }
      : {}

  const createDraftFor = (type: PackCreateObjectType, geometry: PackCreationGeometry): void => {
    createDraft = { objectType: type, geometry, label: defaultName(type), ...defaultTrafficDraftFields(type) }
    placementMode = null
    placementPoints = []
  }

  const placeObjectDraft = (point: GeoJsonPoint): void => {
    if (!placementMode) return
    const placementKind = placementMode.placementKind ?? 'point'
    if (placementKind === 'point') {
      createDraftFor(placementMode, { kind: 'point', point })
      return
    }
    if (placementKind === 'route') {
      const nextPoints = [...placementPoints, point]
      placementPoints = nextPoints
      if (nextPoints.length < 2) {
        commandStatus = `Click end point for new ${placementMode.label.toLowerCase()}`
        return
      }
      const from = nextPoints[0]
      const to = nextPoints[1]
      if (!from || !to) throw new Error('route traffic requires start and end points')
      createDraftFor(placementMode, { kind: 'route', from, to })
      return
    }
    placementPoints = [...placementPoints, point]
    commandStatus = placementPoints.length < 3
      ? `Click ${3 - placementPoints.length} more point${3 - placementPoints.length === 1 ? '' : 's'} for new ${placementMode.label.toLowerCase()}`
      : `Press Enter to finish ${placementMode.label.toLowerCase()} polygon`
  }

  const finishPolygonPlacement = (): void => {
    if (!placementMode || (placementMode.placementKind ?? 'point') !== 'polygon') return
    if (placementPoints.length < 3) {
      commandStatus = `Traffic area needs ${3 - placementPoints.length} more point${3 - placementPoints.length === 2 ? 's' : ''}`
      return
    }
    createDraftFor(placementMode, { kind: 'polygon', polygon: closePolygon(placementPoints) })
  }

  const cancelPlacement = (): void => {
    placementMode = null
    createDraft = null
    placementPoints = []
  }

  onMount(() => {
    theme = initialTheme()
    if (getTheme() !== theme) document.documentElement.classList.toggle('dark', theme === 'dark')
    railWidth = readStoredRailWidth()
    if (railWidth > 0) lastOpenRailWidth = railWidth
    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancelPlacement()
      if (event.key === 'Enter' && placementMode && (placementMode.placementKind ?? 'point') === 'polygon') {
        event.preventDefault()
        finishPolygonPlacement()
      }
    }
    const handleClick = (event: MouseEvent): void => {
      if (!placementMode) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.map-region')) return
      cancelPlacement()
      event.stopImmediatePropagation()
      event.stopPropagation()
      event.preventDefault()
    }
    window.addEventListener('keydown', handleKeydown)
    window.addEventListener('click', handleClick, { capture: true })
    startupMinimumTimer = window.setTimeout(() => {
      startupMinimumElapsed = true
      startupMinimumTimer = null
    }, 5_000)
    routeMode = routeModeFromPath()
    completeStep('route')
    completeStep('interface')
    if (routeMode === 'picker') {
      void loadInstances()
      return () => {
        if (startupMinimumTimer !== null) window.clearTimeout(startupMinimumTimer)
        window.removeEventListener('keydown', handleKeydown)
        window.removeEventListener('click', handleClick, { capture: true })
        stopRailResize()
      }
    }
    void loadMapSurface()
    void joinControlInstance()
    return () => {
      if (startupMinimumTimer !== null) window.clearTimeout(startupMinimumTimer)
      window.removeEventListener('keydown', handleKeydown)
      window.removeEventListener('click', handleClick, { capture: true })
      stopRailResize()
    }
  })

  onDestroy(() => {
    if (startupMinimumTimer !== null) window.clearTimeout(startupMinimumTimer)
    stopRailResize()
    controlInstanceSocket?.close()
    controlInstanceSocket = null
  })

  $: selectedControllerObject = selectedControllerObjectFor(objects, selectedControllerId, activePack)
  $: categoryRows = categoryRowsFor(objects, activePack)
  $: placementCursor = placementCursorFor(placementMode, activePack)
  $: startupModalVisible = startupModalShouldShow({
    routeMode,
    dismissed: startupDismissed,
    minimumElapsed: startupMinimumElapsed,
    steps: startupSteps,
  })
</script>

{#if routeMode === 'picker'}
  <InstancePicker {instances} {status} {createInstance} {openInstance} />
{:else}
  <div class:rail-collapsed={railWidth === 0} class="app-shell" style={`--rail-width: ${railWidth}px`}>
    <ControlRail
      {status}
      {appVersion}
      {theme}
      collapsed={railWidth === 0}
      {commandStatus}
      {categoryRows}
      {placementMode}
      {selectedControllerId}
      {selectedControllerObject}
      {objects}
      {iconForPresentation}
      {presentationFor}
      {detailLines}
      {hasNewInfo}
      {markSeen}
      {selectObject}
      {beginPlacement}
      {cancelPlacement}
      {cancelDestination}
      {toggleTheme}
    />
    <button
      class="rail-resize-handle"
      class:collapsed={railWidth === 0}
      type="button"
      aria-label={railWidth === 0 ? 'Show control rail' : 'Resize control rail'}
      title={railWidth === 0 ? 'Show control rail' : 'Drag to resize control rail'}
      on:pointerdown={startRailResize}
    ></button>

    <main class="map-region">
      {#if MapSurface}
        <MapSurface
          {objects}
          {selectedControllerId}
          {placementMode}
          {placementCursor}
          {routeRevision}
          {layoutRevision}
          {hasNewInfo}
          {presentationFor}
          onObjectSelected={selectObject}
          onPlacementPoint={placeObjectDraft}
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
  <StartupModal steps={startupSteps} retry={joinControlInstance} close={closeStartupModal} />
{/if}

{#if createDraft}
  <CreateObjectModal {createDraft} {createObject} cancelCreate={cancelPlacement} />
{/if}
