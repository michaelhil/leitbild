<script lang="ts">
  import { onMount } from 'svelte'
  import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
  import type { GeoJsonLineString, GeoJsonPoint, KnowledgeFact, ObjectId, OperationalObject, SessionId } from '../core/model/index.ts'
  import { geoPointFromLonLat } from '../core/model/index.ts'
  import {
    cancelDestinationCommandKind,
    createObjectCommandKind,
    setDestinationCommandKind,
    type CreatableAmbulanceObjectType,
  } from '../domains/ambulance/commands.ts'
  import type { AmbulanceDomainData, HospitalDomainData, IncidentDomainData, InjurySummary } from '../domains/ambulance/model.ts'
  import { iconHtml, iconSvgDataUrl, type IconName } from './icons.ts'

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
  let seenRevisions = new Map<string, number>()
  let markerPopup: maplibregl.Popup | null = null
  let hospitalObjects: OperationalObject[] = []
  let ambulanceObjects: OperationalObject[] = []
  let incidentObjects: OperationalObject[] = []
  let selectedAmbulanceObject: OperationalObject | null = null
  const interactiveObjectLayerIds = ['object-icons', 'object-halos', 'object-new-info']

  const domainType = (object: OperationalObject): string | undefined =>
    typeof object.domainData === 'object' && object.domainData !== null
      ? String((object.domainData as { readonly type?: unknown }).type ?? '')
      : undefined

  const pointOf = (object: OperationalObject): GeoJsonPoint | null =>
    object.spatial.position?.point ?? null

  const ambulanceData = (object: OperationalObject): AmbulanceDomainData | null =>
    domainType(object) === 'ambulance' ? object.domainData as AmbulanceDomainData : null

  const incidentData = (object: OperationalObject): IncidentDomainData | null =>
    domainType(object) === 'incident' ? object.domainData as IncidentDomainData : null

  const hospitalData = (object: OperationalObject): HospitalDomainData | null =>
    domainType(object) === 'hospital' ? object.domainData as HospitalDomainData : null

  const factText = <T,>(fact: KnowledgeFact<T> | undefined, formatter: (value: T) => string = String): string =>
    !fact || fact.state === 'unknown' ? 'unknown' : formatter(fact.value)

  const listText = (values: readonly string[]): string =>
    values.length === 0 ? 'none' : values.map(value => value.replaceAll('_', ' ')).join(', ')

  const injuryText = (injuries: readonly InjurySummary[]): string =>
    injuries.length === 0
      ? 'none reported'
      : injuries.map(injury => `${injury.count} ${injury.severity} ${injury.category}`).join(', ')

  const escapeHtml = (value: string): string =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

  const targetLabel = (ambulance: OperationalObject): string =>
    ambulance.tasking?.currentTaskId
      ? objects.find(object => object.id === ambulance.tasking?.currentTaskId)?.label ?? ambulance.tasking.currentTaskId
      : 'idle'

  const routeSummary = (ambulance: OperationalObject): string =>
    ambulance.tasking?.currentTaskId ? `Target: ${targetLabel(ambulance)}` : 'Target: none'

  const hasNewInfo = (object: OperationalObject): boolean =>
    (seenRevisions.get(object.id) ?? object.revision) < object.revision

  const markSeen = (object: OperationalObject): void => {
    if ((seenRevisions.get(object.id) ?? -1) >= object.revision) return
    seenRevisions = new Map([...seenRevisions, [object.id, object.revision]])
    refreshObjectSource()
  }

  const colorFor = (object: OperationalObject): string => {
    if (object.kind === 'mobile_entity') return '#22845d'
    if (object.kind === 'facility') return '#245b9f'
    return '#c7352b'
  }

  const mapIconFor = (object: OperationalObject): IconName => {
    if (object.kind === 'mobile_entity') return 'ambulance'
    if (object.kind === 'facility') return 'hospital'
    return 'crash'
  }

  const objectFeatureCollection = () => ({
    type: 'FeatureCollection' as const,
    features: objects
      .filter(object => pointOf(object))
      .map(object => ({
        type: 'Feature' as const,
        id: object.id,
        geometry: pointOf(object)!,
        properties: {
          id: object.id,
          color: colorFor(object),
          icon: `object-${mapIconFor(object)}`,
          selected: object.id === selectedAmbulanceId,
          hasNewInfo: hasNewInfo(object),
        },
      })),
  })

  const refreshObjectSource = (): void => {
    const current = map
    if (!current || !current.isStyleLoaded()) return
    const source = current.getSource('objects') as GeoJSONSource | undefined
    if (source) source.setData(objectFeatureCollection())
  }

  const routeFeatureCollection = () => ({
    type: 'FeatureCollection' as const,
    features: ambulanceObjects
      .filter(object => object.spatial.route?.planned)
      .map(object => ({
        type: 'Feature' as const,
        id: object.id,
        geometry: object.spatial.route!.planned as GeoJsonLineString,
        properties: {
          selected: object.id === selectedAmbulanceId,
        },
      })),
  })

  const refreshRouteSource = (): void => {
    const current = map
    if (!current || !current.isStyleLoaded()) return
    const source = current.getSource('ambulance-routes') as GeoJSONSource | undefined
    if (source) source.setData(routeFeatureCollection())
  }

  const categoryLabel = (type: CreatableAmbulanceObjectType): string => {
    if (type === 'hospital') return 'Hospital'
    if (type === 'ambulance') return 'Ambulance'
    return 'Incident'
  }

  const defaultName = (type: CreatableAmbulanceObjectType): string => {
    if (type === 'hospital') return `Hospital ${hospitalObjects.length + 1}`
    if (type === 'ambulance') return `Ambulance ${ambulanceObjects.length + 1}`
    return `Incident ${incidentObjects.length + 1}`
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
    const ambulance = selectedAmbulanceObject
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
    const ambulance = selectedAmbulanceObject
    if (!ambulance) return
    commandStatus = `Stopping ${ambulance.label}`
    await sendCommand(cancelDestinationCommandKind, { ambulanceId: ambulance.id }, [ambulance.id])
  }

  const selectObject = (object: OperationalObject): void => {
    markSeen(object)
    if (object.kind === 'mobile_entity') {
      selectedAmbulanceId = object.id
      commandStatus = `Selected ${object.label}; click an incident or hospital target`
      return
    }
    if (selectedAmbulanceId && (object.kind === 'incident' || object.kind === 'facility')) {
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
    if (selectedAmbulanceId === objectId) selectedAmbulanceId = null
  }

  const detailLines = (object: OperationalObject): ReadonlyArray<string> => {
    const ambulance = ambulanceData(object)
    if (ambulance) {
      return [
        `Destination: ${targetLabel(object)}`,
        `Capabilities: ${listText(ambulance.capabilities)}`,
        `Crew: ${factText(ambulance.crew.level)}`,
        `Seats: ${factText(ambulance.crew.availableSeats)}`,
      ]
    }
    const incident = incidentData(object)
    if (incident) {
      return [
        `Triage: ${factText(incident.triage)}`,
        `Victims: ${factText(incident.victims.count, String)}`,
        `Injuries: ${factText(incident.victims.injuries, injuryText)}`,
        `Hazards: ${factText(incident.hazards, listText)}`,
      ]
    }
    const hospital = hospitalData(object)
    if (hospital) {
      return [
        `Trauma beds: ${factText(hospital.emergencyDepartment.traumaBedsAvailable, String)}`,
        `Ambulance bays: ${factText(hospital.emergencyDepartment.ambulanceBaysAvailable, String)}`,
        `Diversion: ${factText(hospital.emergencyDepartment.diversionStatus)}`,
        `Capabilities: ${listText(hospital.capabilities)}`,
      ]
    }
    return [object.operational.status]
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
    selectedAmbulanceId = objects.find(object => object.kind === 'mobile_entity')?.id ?? null
    connectWebSocket(body.id)
    seenRevisions = new Map(objects.map(object => [object.id, object.revision]))
    refreshObjectSource()
    refreshRouteSource()
  }

  const beginPlacement = (type: CreatableAmbulanceObjectType): void => {
    placementMode = type
    createDraft = null
    commandStatus = `Click map to place new ${type}`
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
      map?.addSource('ambulance-routes', {
        type: 'geojson',
        data: routeFeatureCollection(),
      })
      map?.addLayer({
        id: 'ambulance-routes-muted',
        type: 'line',
        source: 'ambulance-routes',
        filter: ['==', ['get', 'selected'], false],
        paint: {
          'line-color': '#174ea6',
          'line-width': 5,
          'line-opacity': 0.55,
        },
      })
      map?.addLayer({
        id: 'ambulance-routes-selected',
        type: 'line',
        source: 'ambulance-routes',
        filter: ['==', ['get', 'selected'], true],
        paint: {
          'line-color': '#0b57d0',
          'line-width': 7,
          'line-opacity': 0.95,
        },
      })
      map?.addSource('objects', {
        type: 'geojson',
        data: objectFeatureCollection(),
      })
      map?.addLayer({
        id: 'object-halos',
        type: 'circle',
        source: 'objects',
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
        id: 'object-icons',
        type: 'symbol',
        source: 'objects',
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': 1,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      })
      map?.addLayer({
        id: 'object-new-info',
        type: 'circle',
        source: 'objects',
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

  $: hospitalObjects = objects.filter(object => object.kind === 'facility')
  $: ambulanceObjects = objects.filter(object => object.kind === 'mobile_entity')
  $: incidentObjects = objects.filter(object => object.kind === 'incident')
  $: selectedAmbulanceObject = ambulanceObjects.find(object => object.id === selectedAmbulanceId) ?? null
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
        Click map to place new {placementMode}
        <button class="icon-button" on:click={() => { placementMode = null; createDraft = null }}>{@html iconHtml('x', { size: 16 })}</button>
      </div>
    {/if}

    <section class="category">
      <div class="category-header">
        <h2>Hospitals <span>{hospitalObjects.length}</span></h2>
        <button class="icon-button" title="Add hospital" on:click={() => beginPlacement('hospital')}>{@html iconHtml('plus', { size: 16 })}</button>
      </div>
      {#if hospitalObjects.length === 0}
        <div class="empty-row">No hospitals</div>
      {/if}
      {#each hospitalObjects as object (object.id)}
        <button class:has-new-info={hasNewInfo(object)} class="object-row" on:mouseenter={() => markSeen(object)} on:focus={() => markSeen(object)} on:click={() => selectObject(object)}>
          <span>{@html iconHtml('hospital', { size: 18 })}</span>
          <span>
            <span class="row-title">{object.label}{#if hasNewInfo(object)} <span class="new-info-dot">new</span>{/if}</span>
            {#if hospitalData(object) as data}
              <span class="object-meta">ER {factText(data.emergencyDepartment.diversionStatus)} · bays {factText(data.emergencyDepartment.ambulanceBaysAvailable, String)}</span>
            {/if}
          </span>
          <span class="row-hover-card">
            <strong>{object.label}</strong>
            {#each detailLines(object) as line}<span>{line}</span>{/each}
          </span>
        </button>
      {/each}
    </section>

    <section class="category">
      <div class="category-header">
        <h2>Ambulances <span>{ambulanceObjects.length}</span></h2>
        <button class="icon-button" title="Add ambulance" on:click={() => beginPlacement('ambulance')}>{@html iconHtml('plus', { size: 16 })}</button>
      </div>
      {#if ambulanceObjects.length === 0}
        <div class="empty-row">No ambulances</div>
      {/if}
      {#each ambulanceObjects as object (object.id)}
        <button class:selected={selectedAmbulanceId === object.id} class:has-new-info={hasNewInfo(object)} class="object-row" on:mouseenter={() => markSeen(object)} on:focus={() => markSeen(object)} on:click={() => selectObject(object)}>
          <span>{@html iconHtml('ambulance', { size: 18 })}</span>
          <span>
            <span class="row-title">{object.label}{#if hasNewInfo(object)} <span class="new-info-dot">new</span>{/if}</span>
            <span class="object-meta">{routeSummary(object)} · {object.operational.status}</span>
          </span>
          <span class="row-hover-card">
            <strong>{object.label}</strong>
            {#each detailLines(object) as line}<span>{line}</span>{/each}
          </span>
        </button>
      {/each}
    </section>

    <section class="category">
      <div class="category-header">
        <h2>Incidents <span>{incidentObjects.length}</span></h2>
        <button class="icon-button" title="Add incident" on:click={() => beginPlacement('incident')}>{@html iconHtml('plus', { size: 16 })}</button>
      </div>
      {#if incidentObjects.length === 0}
        <div class="empty-row">No incidents</div>
      {/if}
      {#each incidentObjects as object (object.id)}
        <button class:has-new-info={hasNewInfo(object)} class="object-row" on:mouseenter={() => markSeen(object)} on:focus={() => markSeen(object)} on:click={() => selectObject(object)}>
          <span>{@html iconHtml('crash', { size: 18 })}</span>
          <span>
            <span class="row-title">{object.label}{#if hasNewInfo(object)} <span class="new-info-dot">new</span>{/if}</span>
            {#if incidentData(object) as data}
              <span class="object-meta">victims {factText(data.victims.count, String)} · triage {factText(data.triage)}</span>
            {:else}
              <span class="object-meta">{object.operational.status}</span>
            {/if}
          </span>
          <span class="row-hover-card">
            <strong>{object.label}</strong>
            {#each detailLines(object) as line}<span>{line}</span>{/each}
          </span>
        </button>
      {/each}
    </section>

    <footer class="rail-footer">
      {#if selectedAmbulanceObject as ambulance}
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
