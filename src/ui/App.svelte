<script lang="ts">
  import { onMount } from 'svelte'
  import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
  import type { OperationalObject, SessionId } from '../core/model/index.ts'
  import { assignToIncidentCommandKind } from '../domains/ambulance/commands.ts'

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

  let mapElement: HTMLDivElement
  let map: MapLibreMap | null = null
  let sessionId: SessionId | null = null
  let objects: OperationalObject[] = []
  let selectedId: string | null = null
  let status = 'Starting'
  let commandStatus = ''

  const selectedObject = (): OperationalObject | null =>
    objects.find(object => object.id === selectedId) ?? objects[0] ?? null

  const ambulanceObjects = (): OperationalObject[] =>
    objects.filter(object => object.kind === 'mobile_entity')

  const incidentObjects = (): OperationalObject[] =>
    objects.filter(object => object.kind === 'incident' && object.lifecycle === 'active')

  const colorFor = (object: OperationalObject): string => {
    if (object.kind === 'incident') return object.operational.priority === 'critical' ? '#c7352b' : '#b7791f'
    if (object.kind === 'facility') return '#586174'
    if (object.operational.status === 'available') return '#22845d'
    if (object.operational.status === 'en_route') return '#1d66d2'
    return '#8b5cf6'
  }

  const featureCollection = () => ({
    type: 'FeatureCollection' as const,
    features: objects
      .filter(object => object.spatial.position)
      .map(object => ({
        type: 'Feature' as const,
        id: object.id,
        geometry: object.spatial.position!.point,
        properties: {
          id: object.id,
          label: object.label,
          kind: object.kind,
          status: object.operational.status,
          color: colorFor(object),
          selected: object.id === selectedId,
        },
      })),
  })

  const refreshMapSource = (): void => {
    const current = map
    if (!current || !current.isStyleLoaded()) return
    const source = current.getSource('objects') as GeoJSONSource | undefined
    if (source) source.setData(featureCollection())
  }

  const applyObject = (object: OperationalObject): void => {
    objects = [...objects.filter(existing => existing.id !== object.id), object]
    if (!selectedId) selectedId = object.id
    refreshMapSource()
  }

  const removeObject = (objectId: string): void => {
    objects = objects.filter(object => object.id !== objectId)
    if (selectedId === objectId) selectedId = objects[0]?.id ?? null
    refreshMapSource()
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
    selectedId = objects[0]?.id ?? null
    connectWebSocket(body.id)
    refreshMapSource()
  }

  const issueDispatch = async (): Promise<void> => {
    if (!sessionId) return
    const ambulance = ambulanceObjects().find(object => object.operational.status === 'available')
    const incident = incidentObjects()[0]
    if (!ambulance || !incident) {
      commandStatus = 'No available ambulance and open incident pair'
      return
    }
    commandStatus = 'Issuing dispatch command'
    const response = await fetch(`/api/session/${encodeURIComponent(sessionId)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: assignToIncidentCommandKind,
        targetObjectIds: [ambulance.id, incident.id],
        payload: {
          ambulanceId: ambulance.id,
          incidentId: incident.id,
        },
        expectedRevision: ambulance.revision,
      }),
    })
    if (!response.ok) {
      commandStatus = `Command request failed: ${response.status}`
    }
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
        layers: [
          {
            id: 'osm',
            type: 'raster',
            source: 'osm',
          },
        ],
      },
      center: [10.7522, 59.9139],
      zoom: 12,
    })
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-left')
    map.on('load', () => {
      if (!map) return
      map.addSource('objects', {
        type: 'geojson',
        data: featureCollection(),
      })
      map.addLayer({
        id: 'object-circles',
        type: 'circle',
        source: 'objects',
        paint: {
          'circle-radius': ['case', ['get', 'selected'], 11, 8],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      })
      map.addLayer({
        id: 'object-labels',
        type: 'symbol',
        source: 'objects',
        layout: {
          'text-field': ['get', 'label'],
          'text-offset': [0, 1.2],
          'text-size': 12,
          'text-anchor': 'top',
        },
        paint: {
          'text-color': '#17202a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      })
      map.on('click', 'object-circles', (event) => {
        const feature = event.features?.[0]
        const id = feature?.properties?.id as string | undefined
        if (id) {
          selectedId = id
          refreshMapSource()
        }
      })
      refreshMapSource()
      void createSession()
    })
  })

  $: refreshMapSource()
</script>

<div class="app-shell">
  <main class="map-region">
    <div class="map" bind:this={mapElement}></div>
    <div class="topbar">
      <span class="brand">Leitbild</span>
      <span class="status-pill">{status}</span>
      {#if sessionId}
        <span class="status-pill">{sessionId}</span>
      {/if}
    </div>
  </main>

  <aside class="side-panel">
    <header class="panel-header">
      <div class="brand">Ambulance Dispatch Sandbox</div>
      <div class="object-meta">{objects.length} operational objects</div>
    </header>

    <section class="object-list">
      {#each objects as object (object.id)}
        <button class:object-row class:selected={selectedId === object.id} on:click={() => { selectedId = object.id; refreshMapSource() }}>
          <span>
            <span class="object-label">{object.label}</span>
            <span class="object-meta">{object.kind} · {object.operational.status}</span>
          </span>
          <span class:severity-critical={object.operational.priority === 'critical'} class:severity-warning={object.operational.priority === 'high'} class:severity-normal={object.operational.priority === 'normal'}>
            {object.operational.priority ?? ''}
          </span>
        </button>
      {/each}

      {#if selectedObject() as object}
        <section>
          <h2>{object.label}</h2>
          <div class="object-meta">Revision {object.revision} · {object.operational.status}</div>
          {#if object.telemetry}
            <div class="signal-grid">
              {#each Object.values(object.telemetry.signals) as signal (signal.signalId)}
                <div class="signal">
                  <div class="object-meta">{signal.label}</div>
                  <div class="signal-value">{signal.latest} {signal.unit}</div>
                  <div class:severity-critical={signal.severity === 'critical'} class:severity-warning={signal.severity === 'warning'} class:severity-normal={signal.severity === 'normal'}>
                    {signal.severity}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {/if}
    </section>

    <footer class="panel-footer">
      <button class="command-button" disabled={!sessionId} on:click={issueDispatch}>Dispatch available ambulance</button>
      {#if commandStatus}
        <div class="object-meta">{commandStatus}</div>
      {/if}
    </footer>
  </aside>
</div>
