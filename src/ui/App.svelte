<script lang="ts">
  import { onMount } from 'svelte'
  import maplibregl, { type Map as MapLibreMap, type Marker } from 'maplibre-gl'
  import type { GeoJsonPoint, ObjectId, OperationalObject, SessionId } from '../core/model/index.ts'
  import { geoPointFromLonLat } from '../core/model/index.ts'
  import {
    cancelDestinationCommandKind,
    createObjectCommandKind,
    setDestinationCommandKind,
    type CreatableAmbulanceObjectType,
  } from '../domains/ambulance/commands.ts'
  import { iconHtml } from './icons.ts'

  interface SessionSnapshot {
    readonly objects: ReadonlyArray<OperationalObject>
    readonly seq: number
  }

  interface SessionResponse {
    readonly id: SessionId
    readonly snapshot: SessionSnapshot
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
    readonly objectType: CreatableAmbulanceObjectType
    readonly point: GeoJsonPoint
    label: string
  }

  let mapElement: HTMLDivElement
  let map: MapLibreMap | null = null
  let sessionId: SessionId | null = null
  let objects: OperationalObject[] = []
  let selectedAmbulanceId: string | null = null
  let placementMode: CreatableAmbulanceObjectType | null = null
  let createDraft: CreateDraft | null = null
  let status = 'Starting'
  let commandStatus = ''
  let markers = new Map<string, Marker>()

  const hospitals = (): OperationalObject[] =>
    objects.filter(object => object.kind === 'facility' && domainType(object) === 'hospital')

  const ambulances = (): OperationalObject[] =>
    objects.filter(object => object.kind === 'mobile_entity')

  const incidents = (): OperationalObject[] =>
    objects.filter(object => object.kind === 'incident')

  const selectedAmbulance = (): OperationalObject | null =>
    objects.find(object => object.id === selectedAmbulanceId) ?? null

  const domainType = (object: OperationalObject): string | undefined =>
    typeof object.domainData === 'object' && object.domainData !== null
      ? String((object.domainData as { readonly type?: unknown }).type ?? '')
      : undefined

  const pointOf = (object: OperationalObject): GeoJsonPoint | null =>
    object.spatial.position?.point ?? null

  const iconFor = (object: OperationalObject): 'ambulance' | 'hospital' | 'crash' => {
    if (object.kind === 'mobile_entity') return 'ambulance'
    if (object.kind === 'facility') return 'hospital'
    return 'crash'
  }

  const categoryLabel = (type: CreatableAmbulanceObjectType): string => {
    if (type === 'hospital') return 'Hospital'
    if (type === 'ambulance') return 'Ambulance'
    return 'Incident'
  }

  const defaultName = (type: CreatableAmbulanceObjectType): string => {
    if (type === 'hospital') return `Hospital ${hospitals().length + 1}`
    if (type === 'ambulance') return `Ambulance ${ambulances().length + 1}`
    return `Incident ${incidents().length + 1}`
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
    }
  }

  const createObject = async (): Promise<void> => {
    if (!createDraft) return
    const draft = createDraft
    createDraft = null
    placementMode = null
    commandStatus = `Creating ${draft.objectType}`
    await sendCommand(createObjectCommandKind, {
      objectType: draft.objectType,
      label: draft.label.trim() || defaultName(draft.objectType),
      point: draft.point,
    })
  }

  const setDestination = async (destination: OperationalObject): Promise<void> => {
    const ambulance = selectedAmbulance()
    if (!ambulance) {
      commandStatus = 'Select an ambulance first'
      return
    }
    if (destination.id === ambulance.id) return
    commandStatus = `Sending ${ambulance.label} to ${destination.label}`
    await sendCommand(setDestinationCommandKind, {
      ambulanceId: ambulance.id,
      destinationId: destination.id,
    }, [ambulance.id, destination.id])
  }

  const cancelDestination = async (): Promise<void> => {
    const ambulance = selectedAmbulance()
    if (!ambulance) return
    commandStatus = `Stopping ${ambulance.label}`
    await sendCommand(cancelDestinationCommandKind, { ambulanceId: ambulance.id }, [ambulance.id])
  }

  const selectObject = (object: OperationalObject): void => {
    if (object.kind === 'mobile_entity') {
      selectedAmbulanceId = object.id
      commandStatus = `Selected ${object.label}; click an incident or hospital target`
      return
    }
    if (selectedAmbulanceId && (object.kind === 'incident' || domainType(object) === 'hospital')) {
      void setDestination(object)
    }
  }

  const applyObject = (object: OperationalObject): void => {
    objects = [...objects.filter(existing => existing.id !== object.id), object]
    refreshMarkers()
  }

  const removeObject = (objectId: string): void => {
    objects = objects.filter(object => object.id !== objectId)
    markers.get(objectId)?.remove()
    markers.delete(objectId)
    if (selectedAmbulanceId === objectId) selectedAmbulanceId = null
  }

  const markerElement = (object: OperationalObject): HTMLElement => {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `map-marker map-marker-${iconFor(object)}${selectedAmbulanceId === object.id ? ' selected' : ''}`
    el.innerHTML = iconHtml(iconFor(object), { size: 24, title: object.label })
    el.addEventListener('click', (event) => {
      event.stopPropagation()
      selectObject(object)
    })
    return el
  }

  const refreshMarkers = (): void => {
    const current = map
    if (!current) return
    const liveIds = new Set(objects.map(object => object.id))
    for (const [id, marker] of markers.entries()) {
      if (!liveIds.has(id)) {
        marker.remove()
        markers.delete(id)
      }
    }
    for (const object of objects) {
      const point = pointOf(object)
      if (!point) continue
      const [lon, lat] = point.coordinates
      const existing = markers.get(object.id)
      if (existing) {
        existing.remove()
        markers.delete(object.id)
      }
      const marker = new maplibregl.Marker({ element: markerElement(object), anchor: 'center' })
        .setLngLat([lon, lat])
        .addTo(current)
      markers.set(object.id, marker)
    }
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
    selectedAmbulanceId = ambulances()[0]?.id ?? null
    connectWebSocket(body.id)
    refreshMarkers()
  }

  const beginPlacement = (type: CreatableAmbulanceObjectType): void => {
    placementMode = type
    createDraft = null
    commandStatus = `Click map to place new ${type}`
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
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
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
      void createSession()
    })
  })

  $: refreshMarkers()
</script>

<div class="app-shell">
  <aside class="control-rail">
    <header class="rail-header">
      <div class="brand">Leitbild</div>
      <div class="object-meta">{status}</div>
    </header>

    {#if placementMode}
      <div class="placement-banner">
        Click map to place new {placementMode}
        <button class="icon-button" on:click={() => { placementMode = null; createDraft = null }}>{@html iconHtml('x', { size: 16 })}</button>
      </div>
    {/if}

    <section class="category">
      <div class="category-header">
        <h2>Hospitals</h2>
        <button class="icon-button" title="Add hospital" on:click={() => beginPlacement('hospital')}>{@html iconHtml('plus', { size: 16 })}</button>
      </div>
      {#each hospitals() as object (object.id)}
        <button class="object-row" on:click={() => selectObject(object)}>
          <span>{@html iconHtml('hospital', { size: 18 })}</span>
          <span>{object.label}</span>
        </button>
      {/each}
    </section>

    <section class="category">
      <div class="category-header">
        <h2>Ambulances</h2>
        <button class="icon-button" title="Add ambulance" on:click={() => beginPlacement('ambulance')}>{@html iconHtml('plus', { size: 16 })}</button>
      </div>
      {#each ambulances() as object (object.id)}
        <button class:selected={selectedAmbulanceId === object.id} class="object-row" on:click={() => selectObject(object)}>
          <span>{@html iconHtml('ambulance', { size: 18 })}</span>
          <span>
            <span>{object.label}</span>
            <span class="object-meta">{object.operational.status}</span>
          </span>
        </button>
      {/each}
    </section>

    <section class="category">
      <div class="category-header">
        <h2>Incidents</h2>
        <button class="icon-button" title="Add incident" on:click={() => beginPlacement('incident')}>{@html iconHtml('plus', { size: 16 })}</button>
      </div>
      {#each incidents() as object (object.id)}
        <button class="object-row" on:click={() => selectObject(object)}>
          <span>{@html iconHtml('crash', { size: 18 })}</span>
          <span>
            <span>{object.label}</span>
            <span class="object-meta">{object.operational.status}</span>
          </span>
        </button>
      {/each}
    </section>

    <footer class="rail-footer">
      {#if selectedAmbulance() as ambulance}
        <div class="selected-card">
          <strong>{ambulance.label}</strong>
          <div class="object-meta">{ambulance.operational.status}</div>
          {#if ambulance.tasking?.currentTaskId}
            <div class="object-meta">Destination: {objects.find(object => object.id === ambulance.tasking?.currentTaskId)?.label ?? ambulance.tasking.currentTaskId}</div>
            <button class="command-button" on:click={cancelDestination}>{@html iconHtml('stop', { size: 16 })} Cancel destination</button>
          {:else}
            <div class="object-meta">Click a hospital or incident target.</div>
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
      <h2>Create new {categoryLabel(createDraft.objectType)}</h2>
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
