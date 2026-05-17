<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { GeoJsonPoint, OperationalObject, ControlInstanceId } from '../core/model/index.ts'
  import { createCompositePack } from '../core/packs/composite.ts'
  import type { LeitbildPack, PackCreateObjectType, PackObjectPresentation } from '../core/packs/protocol.ts'
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
  import MapSurface from './MapSurface.svelte'
  import type { CategoryRow, ControlInstanceSummary, CreateDraft } from './types.ts'

  const activePack: LeitbildPack = createCompositePack({
    id: 'leitbild-control',
    name: 'Leitbild Control',
    packs: [ambulancePack, trafficPack],
  })
  let controlInstanceId: ControlInstanceId | null = null
  let objects: OperationalObject[] = []
  let selectedControllerId: string | null = null
  let placementMode: PackCreateObjectType | null = null
  let createDraft: CreateDraft | null = null
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
    const command = activePack.buildCreateObjectCommand(
      draft.objectType.id,
      draft.label.trim() || defaultName(draft.objectType),
      draft.point,
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
    socket.onopen = () => {
      status = 'Connected'
    }
    socket.onclose = () => {
      if (controlInstanceSocket === socket) controlInstanceSocket = null
      status = 'Disconnected'
    }
    socket.onerror = () => {
      status = 'WebSocket error'
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
    const id = controlInstanceIdFromPath()
    const body = await joinControlInstanceClient(id)
    controlInstanceId = body.id
    objects = [...body.snapshot.objects]
    selectedControllerId = objects.find(object => activePack.isController(object))?.id ?? null
    connectWebSocket(body.id)
    seenRevisions = new Map(objects.map(object => [object.id, object.revision]))
  }

  const beginPlacement = (type: PackCreateObjectType): void => {
    if (!isIconName(type.icon)) throw new Error(`pack ${activePack.id} requested unknown create cursor icon: ${type.icon}`)
    placementMode = type
    createDraft = null
    commandStatus = `Click map to place new ${type.label.toLowerCase()}`
  }

  const placeObjectDraft = (point: GeoJsonPoint): void => {
    if (!placementMode) return
    const type = placementMode
    createDraft = {
      objectType: type,
      point,
      label: defaultName(type),
    }
    placementMode = null
  }

  const cancelPlacement = (): void => {
    placementMode = null
    createDraft = null
  }

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancelPlacement()
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
    routeMode = routeModeFromPath()
    if (routeMode === 'picker') {
      void loadInstances()
      return () => {
        window.removeEventListener('keydown', handleKeydown)
        window.removeEventListener('click', handleClick, { capture: true })
      }
    }
    void joinControlInstance()
    return () => {
      window.removeEventListener('keydown', handleKeydown)
      window.removeEventListener('click', handleClick, { capture: true })
    }
  })

  onDestroy(() => {
    controlInstanceSocket?.close()
    controlInstanceSocket = null
  })

  $: selectedControllerObject = selectedControllerObjectFor(objects, selectedControllerId, activePack)
  $: categoryRows = categoryRowsFor(objects, activePack)
  $: placementCursor = placementCursorFor(placementMode, activePack)
</script>

{#if routeMode === 'picker'}
  <InstancePicker {instances} {status} {createInstance} {openInstance} />
{:else}
  <div class="app-shell">
    <ControlRail
      {status}
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
    />

    <main class="map-region">
      <MapSurface
        {objects}
        {selectedControllerId}
        {placementMode}
        {placementCursor}
        {routeRevision}
        {hasNewInfo}
        {presentationFor}
        onObjectSelected={selectObject}
        onPlacementPoint={placeObjectDraft}
        onObjectSeen={markSeen}
      />
    </main>
  </div>
{/if}

{#if createDraft}
  <CreateObjectModal {createDraft} {createObject} cancelCreate={cancelPlacement} />
{/if}
