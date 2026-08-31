<script lang="ts">
  import 'maplibre-gl/dist/maplibre-gl.css'
  import { getWorkerUrl, Map as MapLibre, NavigationControl, setWorkerUrl, type GeoJSONSource, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl'
  import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'

  interface BuilderPoint {
    readonly id: string
    readonly label: string
    readonly coordinates: readonly [number, number]
  }

  interface Props {
    readonly center: readonly [number, number]
    readonly zoom: number
    readonly points: ReadonlyArray<BuilderPoint>
    readonly selectedId: string | null
    readonly placementActive: boolean
    readonly editView: boolean
    readonly onviewchange: (center: [number, number], zoom: number) => void
    readonly onplace: (coordinates: [number, number]) => void
    readonly onselect: (id: string) => void
  }

  const { center, zoom, points, selectedId, placementActive, editView, onviewchange, onplace, onselect }: Props = $props()
  let element = $state<HTMLDivElement | null>(null)
  let map = $state<MapLibreMap | null>(null)
  let ready = $state(false)

  const data = () => ({
    type: 'FeatureCollection' as const,
    features: points.map(point => ({
      type: 'Feature' as const,
      id: point.id,
      properties: { id: point.id, label: point.label, selected: point.id === selectedId },
      geometry: { type: 'Point' as const, coordinates: [...point.coordinates] },
    })),
  })

  const updateSource = (): void => {
    const source = map?.getSource('scenario-items') as GeoJSONSource | undefined
    if (source) source.setData(data())
  }

  const handleClick = (event: MapMouseEvent): void => {
    if (!map) return
    if (placementActive) {
      onplace([event.lngLat.lng, event.lngLat.lat])
      return
    }
    const feature = map.queryRenderedFeatures(event.point, { layers: ['scenario-item-circles'] })[0]
    const id = feature?.properties?.id
    if (typeof id === 'string') onselect(id)
  }

  runOnMount(() => {
    if (!element) return
    if (getWorkerUrl() !== maplibreWorkerUrl) setWorkerUrl(maplibreWorkerUrl)
    const instance = new MapLibre({
      container: element,
      style: '/map/style.json',
      center: [...center],
      zoom,
      attributionControl: false,
    })
    map = instance
    instance.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
    instance.on('load', () => {
      instance.addSource('scenario-items', { type: 'geojson', data: data() })
      instance.addLayer({
        id: 'scenario-item-circles',
        type: 'circle',
        source: 'scenario-items',
        paint: {
          'circle-radius': ['case', ['get', 'selected'], 9, 7],
          'circle-color': ['case', ['get', 'selected'], '#f59e0b', '#1d66d2'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      })
      instance.addLayer({
        id: 'scenario-item-labels',
        type: 'symbol',
        source: 'scenario-items',
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 12,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
        },
        paint: { 'text-color': '#17202a', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
      })
      ready = true
    })
    instance.on('click', handleClick)
    instance.on('moveend', () => {
      if (!editView) return
      const next = instance.getCenter()
      onviewchange([next.lng, next.lat], instance.getZoom())
    })
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(element)
    return () => {
      observer.disconnect()
      instance.remove()
      map = null
    }
  })

  $effect(() => {
    points
    selectedId
    ready
    updateSource()
  })
</script>

<div class:placing={placementActive} class="scenario-builder-map" bind:this={element} aria-label="Scenario map"></div>

