<script lang="ts">
  import { onMount } from 'svelte'
  import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
  import type { GeoJsonPoint, OperationalObject, SessionId } from '../core/model/index.ts'
  import { geoPointFromLonLat } from '../core/model/index.ts'
  import { createPackRegistry } from '../core/packs/registry.ts'
  import type { LeitbildPack, PackCreateObjectType, PackObjectCategory, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { ambulancePack } from '../domains/ambulance/pack.ts'
  import { iconHtml, iconSvgDataUrl, isIconName, type IconName } from './icons.ts'
  import {
    createObjectFeatureCollection,
    createRouteFeatureCollection,
    mapLayerIds,
    mapSourceIds,
    pointOf,
  } from './map-features.ts'

  interface SessionSnapshot {
    readonly objects: ReadonlyArray<OperationalObject>
    readonly seq: number
  }

  interface SessionResponse {
    readonly id: SessionId
    readonly snapshot: SessionSnapshot
  }

  interface CommandResponse {
    readonly result: {
      readonly ok: boolean
      readonly reason?: string
    }
  }

  interface EventMessage {
    readonly type: 'event'
    readonly event: {
      readonly type: string
      readonly object?: OperationalObject
      readonly objectId?: string
      readonly result?: { readonly ok: boolean; readonly reason?: string }
    }
  }

  interface CreateDraft {
    readonly objectType: PackCreateObjectType
    readonly point: GeoJsonPoint
    label: string
  }

  interface CategoryRow {
    readonly category: PackObjectCategory
    readonly objects: ReadonlyArray<OperationalObject>
    readonly createType?: PackCreateObjectType
  }

  let mapElement: HTMLDivElement
  let map: MapLibreMap | null = null
  const packRegistry = createPackRegistry([ambulancePack])
  const activePack: LeitbildPack = packRegistry.require('ambulance')
  let sessionId: SessionId | null = null
  let objects: OperationalObject[] = []
  let selectedControllerId: string | null = null
  let placementMode: PackCreateObjectType | null = null
  let createDraft: CreateDraft | null = null
  let status = 'Starting'
  let commandStatus = ''
  let seenRevisions = new Map<string, number>()
  let markerPopup: maplibregl.Popup | null = null
  let selectedControllerObject: OperationalObject | null = null
  let categoryRows: ReadonlyArray<CategoryRow> = []
  const interactiveObjectLayerIds = [
    mapLayerIds.objectHitArea,
    mapLayerIds.objectIcons,
    mapLayerIds.objectHalos,
    mapLayerIds.objectNewInfo,
  ]

  const escapeHtml = (value: string): string =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

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
    refreshObjectSource()
  }

  const refreshObjectSource = (): void => {
    const current = map
    if (!current) return
    const source = current.getSource(mapSourceIds.objects) as GeoJSONSource | undefined
    if (source) source.setData(createObjectFeatureCollection(objects, selectedControllerId, hasNewInfo, presentationFor))
  }

  const refreshRouteSource = (): void => {
    const current = map
    if (!current) return
    const source = current.getSource(mapSourceIds.plannedRoutes) as GeoJSONSource | undefined
    if (source) source.setData(createRouteFeatureCollection(objects, selectedControllerId))
  }

  const defaultName = (type: PackCreateObjectType): string =>
    activePack.defaultObjectLabel(type.id, { objects })

  const syncSessionSnapshot = async (): Promise<void> => {
    if (!sessionId) return
    const response = await fetch(`/api/session/${encodeURIComponent(sessionId)}/snapshot`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`snapshot sync failed: ${response.status}`)
    const body = await response.json() as SessionResponse
    objects = [...body.snapshot.objects]
    refreshObjectSource()
    refreshRouteSource()
  }

  const sendCommand = async (kind: string, payload: unknown, targetObjectIds: readonly string[] = []): Promise<void> => {
    if (!sessionId) return
    const response = await fetch(`/api/session/${encodeURIComponent(sessionId)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, targetObjectIds, payload }),
    })
    if (!response.ok) {
      commandStatus = `Command failed: ${response.status}`
      return
    }
    const body = await response.json() as CommandResponse
    if (!body.result.ok) {
      commandStatus = `Command rejected: ${body.result.reason ?? 'unknown reason'}`
      return
    }
    commandStatus = 'Command accepted'
    await syncSessionSnapshot()
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

  const applyObject = (object: OperationalObject): void => {
    objects = [...objects.filter(existing => existing.id !== object.id), object]
    refreshObjectSource()
    refreshRouteSource()
  }

  const removeObject = (objectId: string): void => {
    objects = objects.filter(object => object.id !== objectId)
    refreshObjectSource()
    refreshRouteSource()
    if (selectedControllerId === objectId) selectedControllerId = null
  }

  const detailLines = (object: OperationalObject): ReadonlyArray<string> => {
    return presentationFor(object).detailLines
  }

  const hoverCardHtml = (object: OperationalObject): string => {
    const lines = detailLines(object)
      .map(line => `<div>${escapeHtml(line)}</div>`)
      .join('')
    const newInfo = hasNewInfo(object) ? '<div class="hover-new-info">New information</div>' : ''
    return `<strong>${escapeHtml(object.label)}</strong>${newInfo}${lines}`
  }

  const showMarkerPopup = (object: OperationalObject): void => {
    const current = map
    const point = pointOf(object)
    if (!current || !point) return
    const [lon, lat] = point.coordinates
    markerPopup?.remove()
    markerPopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 26,
      className: 'object-popup',
    })
      .setLngLat([lon, lat])
      .setHTML(hoverCardHtml(object))
      .addTo(current)
  }

  const hideMarkerPopup = (): void => {
    markerPopup?.remove()
    markerPopup = null
  }

  const connectWebSocket = (id: SessionId): void => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/ws?session=${encodeURIComponent(id)}`)
    socket.onopen = () => {
      status = 'Connected'
    }
    socket.onclose = () => {
      status = 'Disconnected'
    }
    socket.onerror = () => {
      status = 'WebSocket error'
    }
    socket.onmessage = (message) => {
      const parsed = JSON.parse(message.data as string) as EventMessage
      if (parsed.type !== 'event') return
      if (parsed.event.type === 'object.upserted' && parsed.event.object) applyObject(parsed.event.object)
      if (parsed.event.type === 'object.deleted' && parsed.event.objectId) removeObject(parsed.event.objectId)
      if (parsed.event.type === 'command.result' && parsed.event.result) {
        commandStatus = parsed.event.result.ok ? 'Command accepted' : `Command rejected: ${parsed.event.result.reason ?? 'unknown reason'}`
      }
    }
  }

  const createSession = async (): Promise<void> => {
    const response = await fetch('/api/session', { method: 'POST' })
    if (!response.ok) throw new Error(`session creation failed: ${response.status}`)
    const body = await response.json() as SessionResponse
    sessionId = body.id
    objects = [...body.snapshot.objects]
    selectedControllerId = objects.find(object => activePack.isController(object))?.id ?? null
    connectWebSocket(body.id)
    seenRevisions = new Map(objects.map(object => [object.id, object.revision]))
    refreshObjectSource()
    refreshRouteSource()
  }

  const beginPlacement = (type: PackCreateObjectType): void => {
    placementMode = type
    createDraft = null
    commandStatus = `Click map to place new ${type.label.toLowerCase()}`
  }

  const registerMapIcon = async (current: MapLibreMap, iconId: string, iconName: IconName, color: string): Promise<void> => {
    if (current.hasImage(iconId)) return
    const image = new Image(40, 40)
    image.src = iconSvgDataUrl(iconName, { stroke: color, size: 40, strokeWidth: 2.4 })
    await image.decode()
    current.addImage(iconId, image, { pixelRatio: 2 })
  }

  const objectFromMapEvent = (event: maplibregl.MapLayerMouseEvent): OperationalObject | null => {
    const objectId = String(event.features?.[0]?.properties?.id ?? '')
    return objects.find(candidate => candidate.id === objectId) ?? null
  }

  onMount(() => {
    map = new maplibregl.Map({
      container: mapElement,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [{
          id: 'osm',
          type: 'raster',
          source: 'osm',
          paint: {
            'raster-contrast': 0.18,
            'raster-saturation': 0.12,
          },
        }],
      },
      center: [10.7522, 59.9139],
      zoom: 12,
    })
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
    map.on('click', (event) => {
      if (!placementMode) return
      const type = placementMode
      createDraft = {
        objectType: type,
        point: geoPointFromLonLat(event.lngLat.lng, event.lngLat.lat),
        label: defaultName(type),
      }
    })
    map.on('load', () => {
      const current = map
      if (!current) return
      void (async () => {
        await registerMapIcon(current, 'object-ambulance', 'ambulance', '#22845d')
        await registerMapIcon(current, 'object-hospital', 'hospital', '#245b9f')
        await registerMapIcon(current, 'object-crash', 'crash', '#c7352b')
        refreshObjectSource()
      })()
      map?.addSource(mapSourceIds.plannedRoutes, {
        type: 'geojson',
        data: createRouteFeatureCollection(objects, selectedControllerId),
      })
      map?.addLayer({
        id: mapLayerIds.routeCasing,
        type: 'line',
        source: mapSourceIds.plannedRoutes,
        paint: {
          'line-color': '#ffffff',
          'line-width': ['case', ['get', 'selected'], 10, 8],
          'line-opacity': 0.92,
          'line-blur': 0.15,
        },
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
      })
      map?.addLayer({
        id: mapLayerIds.routeLine,
        type: 'line',
        source: mapSourceIds.plannedRoutes,
        paint: {
          'line-color': ['case', ['get', 'selected'], '#0b57d0', '#2563eb'],
          'line-width': ['case', ['get', 'selected'], 6, 4],
          'line-opacity': ['case', ['get', 'selected'], 1, 0.82],
        },
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
      })
      map?.addSource(mapSourceIds.objects, {
        type: 'geojson',
        data: createObjectFeatureCollection(objects, selectedControllerId, hasNewInfo, presentationFor),
      })
      map?.addLayer({
        id: mapLayerIds.objectHitArea,
        type: 'circle',
        source: mapSourceIds.objects,
        paint: {
          'circle-radius': 22,
          'circle-color': '#ffffff',
          'circle-opacity': 0,
        },
      })
      map?.addLayer({
        id: mapLayerIds.objectHalos,
        type: 'circle',
        source: mapSourceIds.objects,
        filter: ['==', ['get', 'selected'], true],
        paint: {
          'circle-radius': 22,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#1d66d2',
          'circle-stroke-width': 3,
          'circle-opacity': 0.82,
        },
      })
      map?.addLayer({
        id: mapLayerIds.objectIcons,
        type: 'symbol',
        source: mapSourceIds.objects,
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': 1,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      })
      map?.addLayer({
        id: mapLayerIds.objectNewInfo,
        type: 'circle',
        source: mapSourceIds.objects,
        filter: ['==', ['get', 'hasNewInfo'], true],
        paint: {
          'circle-radius': 6,
          'circle-color': '#c7352b',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-translate': [12, -12],
        },
      })
      for (const layerId of interactiveObjectLayerIds) {
        map?.on('click', layerId, (event) => {
          const object = objectFromMapEvent(event)
          if (object) selectObject(object)
        })
        map?.on('mouseenter', layerId, (event) => {
          const currentMap = map
          if (!currentMap) return
          currentMap.getCanvas().style.cursor = 'pointer'
          const object = objectFromMapEvent(event)
          if (!object) return
          markSeen(object)
          showMarkerPopup(object)
        })
        map?.on('mouseleave', layerId, () => {
          const currentMap = map
          if (currentMap) currentMap.getCanvas().style.cursor = ''
          hideMarkerPopup()
        })
      }
      void createSession()
    })
  })

  $: selectedControllerObject = objects.find(object => object.id === selectedControllerId && activePack.isController(object)) ?? null
  $: categoryRows = activePack.categories.map(category => ({
    category,
    objects: objects.filter(object => category.matches(object)),
    createType: activePack.createObjectTypes.find(type => type.categoryId === category.id),
  }))
  $: refreshObjectSource()
  $: refreshRouteSource()
</script>

<div class="app-shell">
  <aside class="control-rail">
    <header class="rail-header">
      <div class="brand">Leitbild</div>
      <div class="object-meta">{status}</div>
    </header>

    {#if placementMode}
      <div class="placement-banner">
        Click map to place new {placementMode.label.toLowerCase()}
        <button class="icon-button" on:click={() => { placementMode = null; createDraft = null }}>{@html iconHtml('x', { size: 16 })}</button>
      </div>
    {/if}

    {#each categoryRows as row (row.category.id)}
      <section class="category">
        <div class="category-header">
          <h2>{row.category.label} <span>{row.objects.length}</span></h2>
          {#if row.createType}
            <button
              class="icon-button"
              title="Add {row.category.label.toLowerCase()}"
              on:click={() => row.createType && beginPlacement(row.createType)}
            >{@html iconHtml('plus', { size: 16 })}</button>
          {/if}
        </div>
        {#if row.objects.length === 0}
          <div class="empty-row">{row.category.emptyLabel}</div>
        {/if}
        {#each row.objects as object (object.id)}
          <button class:selected={selectedControllerId === object.id} class:has-new-info={hasNewInfo(object)} class="object-row" on:mouseenter={() => markSeen(object)} on:focus={() => markSeen(object)} on:click={() => selectObject(object)}>
            <span>{@html iconHtml(iconForPresentation(presentationFor(object)), { size: 18 })}</span>
            <span>
              <span class="row-title">{object.label}{#if hasNewInfo(object)} <span class="new-info-dot">new</span>{/if}</span>
              <span class="object-meta">{presentationFor(object).summary}</span>
            </span>
            <span class="row-hover-card">
              <strong>{object.label}</strong>
              {#each detailLines(object) as line}<span>{line}</span>{/each}
            </span>
          </button>
        {/each}
      </section>
    {/each}

    <footer class="rail-footer">
      {#if selectedControllerObject}
        <div class="selected-card">
          <strong>{selectedControllerObject.label}</strong>
          <div class="object-meta">{selectedControllerObject.operational.status}</div>
          {#if selectedControllerObject.tasking?.currentTaskId}
            <div class="object-meta">Destination: {objects.find(object => object.id === selectedControllerObject?.tasking?.currentTaskId)?.label ?? selectedControllerObject.tasking.currentTaskId}</div>
            <button class="command-button" on:click={cancelDestination}>{@html iconHtml('stop', { size: 16 })} Cancel destination</button>
          {:else}
            <div class="object-meta">Click a valid target.</div>
          {/if}
        </div>
      {/if}
      {#if commandStatus}
        <div class="object-meta">{commandStatus}</div>
      {/if}
    </footer>
  </aside>

  <main class="map-region">
    <div class="map" bind:this={mapElement}></div>
  </main>
</div>

{#if createDraft}
  <div class="modal-backdrop">
    <form class="modal" on:submit|preventDefault={createObject}>
      <h2>Create new {createDraft.objectType.label}</h2>
      <label>
        Name
        <input bind:value={createDraft.label} />
      </label>
      <div class="modal-actions">
        <button type="button" on:click={() => { createDraft = null; placementMode = null }}>Cancel</button>
        <button type="submit" class="primary">Create</button>
      </div>
    </form>
  </div>
{/if}
