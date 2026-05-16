<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
  import type { GeoJsonPoint, OperationalObject } from '../core/model/index.ts'
  import { geoPointFromLonLat } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { iconSvgDataUrl, type IconName } from './icons.ts'
  import {
    createObjectFeatureCollection,
    createRouteFeatureCollection,
    mapLayerIds,
    mapSourceIds,
    pointOf,
  } from './map-features.ts'

  export let objects: ReadonlyArray<OperationalObject>
  export let selectedControllerId: string | null
  export let placementMode: PackCreateObjectType | null
  export let placementCursor: { readonly icon: IconName; readonly color: string } | null
  export let routeRevision: number
  export let hasNewInfo: (object: OperationalObject) => boolean
  export let presentationFor: (object: OperationalObject) => PackObjectPresentation
  export let onObjectSelected: (object: OperationalObject) => void
  export let onPlacementPoint: (point: GeoJsonPoint) => void
  export let onObjectSeen: (object: OperationalObject) => void

  let mapElement: HTMLDivElement
  let map: MapLibreMap | null = null
  let markerPopup: maplibregl.Popup | null = null
  let loaded = false
  let renderRevision = 0
  let refreshFrame: number | null = null
  let objectSourceDirty = false
  let routeSourceDirty = false
  let lastRouteRevision = -1
  let lastSelectedControllerId: string | null = null

  const interactiveObjectLayerIds = [
    mapLayerIds.objectHitArea,
    mapLayerIds.objectIcons,
    mapLayerIds.objectHalos,
    mapLayerIds.objectNewInfo,
  ]

  const escapeHtml = (value: string): string =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

  const refreshObjectSource = (): void => {
    const current = map
    if (!current || !loaded) return
    const source = current.getSource(mapSourceIds.objects) as GeoJSONSource | undefined
    if (source) source.setData(createObjectFeatureCollection([...objects], selectedControllerId, hasNewInfo, presentationFor))
  }

  const refreshRouteSource = (): void => {
    const current = map
    if (!current || !loaded) return
    const source = current.getSource(mapSourceIds.plannedRoutes) as GeoJSONSource | undefined
    if (source) source.setData(createRouteFeatureCollection([...objects], selectedControllerId))
  }

  const refreshSources = (): void => {
    refreshObjectSource()
    refreshRouteSource()
  }

  const scheduleSourceRefresh = (dirty: { readonly objects?: boolean; readonly routes?: boolean }): void => {
    objectSourceDirty = objectSourceDirty || dirty.objects === true
    routeSourceDirty = routeSourceDirty || dirty.routes === true
    if (refreshFrame !== null) return
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = null
      if (objectSourceDirty) refreshObjectSource()
      if (routeSourceDirty) refreshRouteSource()
      objectSourceDirty = false
      routeSourceDirty = false
    })
  }

  const placementCursorCss = (): string => {
    if (!placementCursor) return ''
    const url = iconSvgDataUrl(placementCursor.icon, { stroke: placementCursor.color, size: 32, strokeWidth: 2.6 })
    return `url("${url}") 16 16, pointer`
  }

  const refreshCanvasCursor = (): void => {
    const canvas = map?.getCanvas()
    if (!canvas) return
    canvas.style.cursor = placementCursorCss()
  }

  const detailLines = (object: OperationalObject): ReadonlyArray<string> =>
    presentationFor(object).detailLines

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

  const addMapSourcesAndLayers = (current: MapLibreMap): void => {
    current.addSource(mapSourceIds.plannedRoutes, {
      type: 'geojson',
      data: createRouteFeatureCollection([...objects], selectedControllerId),
    })
    current.addLayer({
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
    current.addLayer({
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
    current.addSource(mapSourceIds.objects, {
      type: 'geojson',
      data: createObjectFeatureCollection([...objects], selectedControllerId, hasNewInfo, presentationFor),
    })
    current.addLayer({
      id: mapLayerIds.objectHitArea,
      type: 'circle',
      source: mapSourceIds.objects,
      paint: {
        'circle-radius': 22,
        'circle-color': '#ffffff',
        'circle-opacity': 0,
      },
    })
    current.addLayer({
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
    current.addLayer({
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
    current.addLayer({
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
  }

  const addObjectInteractions = (current: MapLibreMap): void => {
    for (const layerId of interactiveObjectLayerIds) {
      current.on('click', layerId, (event) => {
        const object = objectFromMapEvent(event)
        if (object) onObjectSelected(object)
      })
      current.on('mouseenter', layerId, (event) => {
        current.getCanvas().style.cursor = placementCursor ? placementCursorCss() : 'pointer'
        const object = objectFromMapEvent(event)
        if (!object) return
        onObjectSeen(object)
        renderRevision += 1
        showMarkerPopup(object)
      })
      current.on('mouseleave', layerId, () => {
        refreshCanvasCursor()
        hideMarkerPopup()
      })
    }
  }

  onMount(() => {
    const current = new maplibregl.Map({
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
    map = current
    current.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
    current.on('click', (event) => {
      if (!placementMode) return
      onPlacementPoint(geoPointFromLonLat(event.lngLat.lng, event.lngLat.lat))
    })
    current.on('load', () => {
      void (async () => {
        await registerMapIcon(current, 'object-ambulance', 'ambulance', '#22845d')
        await registerMapIcon(current, 'object-hospital', 'hospital', '#245b9f')
        await registerMapIcon(current, 'object-crash', 'crash', '#c7352b')
        addMapSourcesAndLayers(current)
        addObjectInteractions(current)
        loaded = true
        lastRouteRevision = routeRevision
        lastSelectedControllerId = selectedControllerId
        refreshSources()
      })()
    })
  })

  onDestroy(() => {
    if (refreshFrame !== null) cancelAnimationFrame(refreshFrame)
    hideMarkerPopup()
    map?.remove()
    map = null
    loaded = false
  })

  $: {
    objects
    selectedControllerId
    routeRevision
    renderRevision
    const routesChanged = routeRevision !== lastRouteRevision || selectedControllerId !== lastSelectedControllerId
    lastRouteRevision = routeRevision
    lastSelectedControllerId = selectedControllerId
    scheduleSourceRefresh({ objects: true, routes: routesChanged })
  }

  $: {
    placementCursor
    refreshCanvasCursor()
  }
</script>

<div class="map" bind:this={mapElement}></div>
