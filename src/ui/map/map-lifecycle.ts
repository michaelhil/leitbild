import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl'
import { Protocol as PmtilesProtocol } from 'pmtiles'
import type { GeoJsonPoint } from '../../core/model/index.ts'
import { geoPointFromLonLat } from '../../core/model/index.ts'
import { assertCameraInteractionContract } from './map-camera.ts'

type Cleanup = () => void

interface MapLifecycleConfig {
  readonly element: HTMLElement
  readonly styleUrl: string
  readonly center: GeoJsonPoint
  readonly zoom: number
  readonly placementActive: () => boolean
  readonly recordDebug: (label: string, event?: Event) => void
  readonly onError: (message: string) => void
  readonly onPlacementPoint: (point: GeoJsonPoint) => void
  readonly onMoveStart: () => void
  readonly onMoveEnd: () => void
  readonly onStyleLoad: (current: MapLibreMap) => void
  readonly onLoad: (current: MapLibreMap) => void
}

export interface MapLifecycle {
  readonly map: MapLibreMap
  readonly destroy: () => void
}

let pmtilesProtocolRefCount = 0

const installPmtilesProtocol = (): Cleanup => {
  const protocol = new PmtilesProtocol({ metadata: true })
  if (pmtilesProtocolRefCount === 0) {
    maplibregl.addProtocol('pmtiles', protocol.tile)
  }
  pmtilesProtocolRefCount += 1
  return () => {
    pmtilesProtocolRefCount -= 1
    if (pmtilesProtocolRefCount === 0) {
      maplibregl.removeProtocol('pmtiles')
    }
  }
}

const applyObservedMapContainerSize = (
  config: Pick<MapLifecycleConfig, 'recordDebug'>,
  current: MapLibreMap,
  observedSize: { readonly width: number; readonly height: number } | null,
  width: number,
  height: number,
  source: string,
): { readonly width: number; readonly height: number } | null => {
  const roundedWidth = Math.round(width)
  const roundedHeight = Math.round(height)
  if (roundedWidth <= 0 || roundedHeight <= 0) return observedSize
  if (
    observedSize?.width === roundedWidth
    && observedSize.height === roundedHeight
  ) return observedSize
  config.recordDebug(`container-resize:${source}:${roundedWidth}x${roundedHeight}`)
  current.resize({ source: `leitbild-container-${source}` })
  return { width: roundedWidth, height: roundedHeight }
}

const installMapContainerResizeObserver = (
  config: Pick<MapLifecycleConfig, 'element' | 'recordDebug'>,
  current: MapLibreMap,
): Cleanup => {
  let observedSize: { readonly width: number; readonly height: number } | null = null
  const initialBounds = config.element.getBoundingClientRect()
  observedSize = applyObservedMapContainerSize(
    config,
    current,
    observedSize,
    initialBounds.width,
    initialBounds.height,
    'initial',
  )
  if (typeof ResizeObserver === 'undefined') {
    return () => {
      observedSize = null
    }
  }
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0]
    if (!entry) return
    observedSize = applyObservedMapContainerSize(
      config,
      current,
      observedSize,
      entry.contentRect.width,
      entry.contentRect.height,
      'observer',
    )
  })
  observer.observe(config.element)
  return () => {
    observer.disconnect()
    observedSize = null
  }
}

export const createMapLifecycle = (config: MapLifecycleConfig): MapLifecycle => {
  const cleanups: Array<Cleanup> = [installPmtilesProtocol()]
  const current = new maplibregl.Map({
    container: config.element,
    style: config.styleUrl,
    center: [config.center.coordinates[0], config.center.coordinates[1]],
    zoom: config.zoom,
    interactive: true,
    dragPan: true,
    scrollZoom: true,
    boxZoom: true,
    doubleClickZoom: true,
    touchZoomRotate: true,
    keyboard: true,
    cooperativeGestures: false,
  })
  assertCameraInteractionContract(current)
  cleanups.push(installMapContainerResizeObserver(config, current))

  current.on('error', (event) => {
    const candidate = event as { readonly error?: unknown }
    config.onError(candidate.error instanceof Error ? candidate.error.message : 'Vector map failed to load')
  })
  current.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
  current.on('click', (event) => {
    if (!config.placementActive()) return
    config.onPlacementPoint(geoPointFromLonLat(event.lngLat.lng, event.lngLat.lat))
  })
  current.on('movestart', config.onMoveStart)
  current.on('moveend', config.onMoveEnd)
  current.on('style.load', () => {
    config.onStyleLoad(current)
  })
  current.on('load', () => {
    config.onLoad(current)
  })

  return {
    map: current,
    destroy: () => {
      current.remove()
      for (let index = cleanups.length - 1; index >= 0; index -= 1) {
        cleanups[index]?.()
      }
    },
  }
}
