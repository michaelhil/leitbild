import {
  Map as MapLibre,
  NavigationControl,
  type IControl,
  type Map as MapLibreMap,
  type MapOptions,
} from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import type { GeoJsonPoint } from '../../core/model/index.ts'
import { geoPointFromLonLat } from '../../core/model/index.ts'
import { assertCameraInteractionContract } from '../map/map-camera.ts'
import {
  baseMapReadinessDetails,
  inspectBaseMapReadiness,
  isBaseMapReadinessFailure,
  waitForBaseMapReadiness,
} from './base-map-readiness.ts'
import { createMapDiagnostics } from './map-diagnostics.ts'
import { mapPerformanceDiagnostics } from './map-performance-diagnostics.ts'
import type {
  MapRuntimeDiagnosticDetail,
  MapRuntimeDiagnosticsSnapshot,
  MapRuntimeError,
  MapRuntimeHandle,
  MapRuntimeLayers,
  RenderPhase,
} from './types.ts'

type Cleanup = () => void

export interface CreateMapRuntimeConfig {
  readonly element: HTMLElement
  readonly styleUrl: string
  readonly center: GeoJsonPoint
  readonly zoom: number
  readonly preserveDrawingBuffer?: boolean
  readonly placementActive: () => boolean
  readonly onPlacementPoint: (point: GeoJsonPoint) => void
  readonly onMoveStart: () => void
  readonly onMoveEnd: () => void
  readonly onError: (error: MapRuntimeError) => void
  readonly onDiagnostics: (snapshot: MapRuntimeDiagnosticsSnapshot) => void
}

interface MapLibreErrorDetails {
  readonly message: string
  readonly sourceId: string | null
}

const stringFromUnknown = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const mapLibreErrorDetails = (event: unknown): MapLibreErrorDetails => {
  const candidate = event as {
    readonly error?: unknown
    readonly sourceId?: unknown
    readonly source?: { readonly id?: unknown }
  }
  const error = candidate.error
  return {
    message: error instanceof Error
      ? error.message
      : stringFromUnknown(error) ?? 'Vector map failed to load',
    sourceId: stringFromUnknown(candidate.sourceId) ?? stringFromUnknown(candidate.source?.id),
  }
}

const isReferenceDatasetError = (details: MapLibreErrorDetails): boolean =>
  details.sourceId?.startsWith('reference:') === true || details.message.includes('/map/datasets/')

const containerDetails = (element: HTMLElement): ReadonlyArray<MapRuntimeDiagnosticDetail> => {
  const rect = element.getBoundingClientRect()
  return [
    { label: 'Container', value: `${Math.round(rect.width)}x${Math.round(rect.height)}` },
  ]
}

const installResizeObserver = (
  element: HTMLElement,
  map: MapLibreMap,
): Cleanup => {
  let lastWidth = 0
  let lastHeight = 0
  const resizeIfNeeded = (width: number, height: number, source: string): void => {
    const nextWidth = Math.round(width)
    const nextHeight = Math.round(height)
    if (nextWidth < 1 || nextHeight < 1) return
    if (nextWidth === lastWidth && nextHeight === lastHeight) return
    lastWidth = nextWidth
    lastHeight = nextHeight
    map.resize({ source: `leitbild-${source}` })
  }
  const rect = element.getBoundingClientRect()
  resizeIfNeeded(rect.width, rect.height, 'initial-resize')
  if (typeof ResizeObserver === 'undefined') {
    return () => undefined
  }
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0]
    if (!entry) return
    resizeIfNeeded(entry.contentRect.width, entry.contentRect.height, 'observed-resize')
  })
  observer.observe(element)
  return () => {
    observer.disconnect()
  }
}

const waitForBase = async (
  map: MapLibreMap,
  diagnostics: ReturnType<typeof createMapDiagnostics>,
  phase: RenderPhase,
  isCancelled: () => boolean,
): Promise<void> => {
  try {
    const readiness = await mapPerformanceDiagnostics.measureAsync(
      'base',
      'waitForBaseMapReadiness',
      async () => waitForBaseMapReadiness(map, { isCancelled }),
    )
    diagnostics.ready(phase, 'Base map rendered', readiness.details)
  } catch (err) {
    if (isBaseMapReadinessFailure(err)) {
      diagnostics.fail(phase, {
        phase,
        message: err.message,
        recoverable: false,
      }, baseMapReadinessDetails(err.snapshot))
    }
    throw err
  }
}

export const createMapRuntime = async (
  config: CreateMapRuntimeConfig,
): Promise<MapRuntimeHandle> => {
  const diagnostics = createMapDiagnostics()
  diagnostics.start('base', 'Creating vector map', containerDetails(config.element))

  const cleanups: Cleanup[] = []
  let destroyed = false
  let operationalDiagnosticsReported = false
  const snapshot = (): MapRuntimeDiagnosticsSnapshot => ({
    ...diagnostics.snapshot(),
    performance: mapPerformanceDiagnostics.snapshot(),
  })
  const emitDiagnostics = (): void => config.onDiagnostics(snapshot())
  emitDiagnostics()
  const reportError = (error: MapRuntimeError): void => {
    diagnostics.fail(error.phase, error, diagnostics.snapshot().phases.find(phase => phase.phase === error.phase)?.details ?? [])
    emitDiagnostics()
    config.onError(error)
  }

  const mapOptions: MapOptions & { readonly preserveDrawingBuffer?: boolean } = {
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
    preserveDrawingBuffer: config.preserveDrawingBuffer === true,
  }
  const current = mapPerformanceDiagnostics.measure(
    'base',
    'MapLibre constructor',
    () => new MapLibre(mapOptions),
    { styleUrl: config.styleUrl },
  )
  assertCameraInteractionContract(current)

  let overlay: MapboxOverlay | null = null
  const installDeckOverlay = (): void => {
    diagnostics.start('operational-dynamic', 'Installing deck overlay')
    const nextOverlay = mapPerformanceDiagnostics.measure(
      'operational-dynamic',
      'Deck overlay constructor',
      () => new MapboxOverlay({
        interleaved: false,
        layers: [],
      }),
    )
    overlay = nextOverlay
    mapPerformanceDiagnostics.measure(
      'operational-dynamic',
      'add Deck overlay control',
      () => current.addControl(nextOverlay as unknown as IControl),
    )
    diagnostics.ready('operational-dynamic', 'Deck overlay installed')
    emitDiagnostics()
  }
  mapPerformanceDiagnostics.measure(
    'base',
    'add navigation control',
    () => current.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right'),
  )
  cleanups.push(installResizeObserver(config.element, current))
  let resourcesDestroyed = false
  const destroyResources = (): void => {
    if (resourcesDestroyed) return
    resourcesDestroyed = true
    destroyed = true
    overlay?.setProps({ layers: [] })
    current.remove()
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      cleanups[index]?.()
    }
  }

  const warnedReferenceErrors = new Set<string>()
  current.on('error', (event) => {
    const details = mapLibreErrorDetails(event)
    if (isReferenceDatasetError(details)) {
      const key = `${details.sourceId ?? 'reference'}:${details.message}`
      if (!warnedReferenceErrors.has(key)) {
        warnedReferenceErrors.add(key)
        diagnostics.details('reference', [
          { label: 'Reference warning', value: details.message },
        ])
        emitDiagnostics()
      }
      return
    }
    reportError({
      phase: 'runtime',
      message: details.message,
      recoverable: false,
      ...(details.sourceId ? { sourceId: details.sourceId } : {}),
    })
  })

  const canvas = current.getCanvas()
  let contextLossTimer: ReturnType<typeof setTimeout> | null = null
  const onContextLost = (event: Event): void => {
    event.preventDefault()
    diagnostics.fail('runtime', {
      phase: 'runtime',
      message: 'Vector map WebGL context was lost',
      recoverable: true,
    })
    emitDiagnostics()
    contextLossTimer = setTimeout(() => {
      reportError({
        phase: 'runtime',
        message: 'Vector map WebGL context did not recover',
        recoverable: false,
      })
    }, 2_000)
  }
  const onContextRestored = (): void => {
    if (contextLossTimer !== null) {
      clearTimeout(contextLossTimer)
      contextLossTimer = null
    }
    diagnostics.ready('runtime', 'WebGL context restored')
    emitDiagnostics()
    current.resize({ source: 'leitbild-context-restored' })
    current.triggerRepaint()
  }
  canvas.addEventListener('webglcontextlost', onContextLost, false)
  canvas.addEventListener('webglcontextrestored', onContextRestored, false)
  cleanups.push(() => {
    if (contextLossTimer !== null) clearTimeout(contextLossTimer)
    contextLossTimer = null
    canvas.removeEventListener('webglcontextlost', onContextLost, false)
    canvas.removeEventListener('webglcontextrestored', onContextRestored, false)
  })

  current.on('click', (event) => {
    if (!config.placementActive()) return
    config.onPlacementPoint(geoPointFromLonLat(event.lngLat.lng, event.lngLat.lat))
  })
  current.on('movestart', config.onMoveStart)
  current.on('moveend', config.onMoveEnd)

  diagnostics.details('base', baseMapReadinessDetails(inspectBaseMapReadiness(current)))
  emitDiagnostics()
  try {
    await waitForBase(current, diagnostics, 'base', () => destroyed)
  } catch (err) {
    emitDiagnostics()
    destroyResources()
    throw err
  }
  emitDiagnostics()
  installDeckOverlay()

  return {
    map: current,
    updateLayers: (layers: MapRuntimeLayers) => {
      const activeOverlay = overlay
      if (activeOverlay === null) {
        throw new Error('Deck overlay is not installed')
      }
      mapPerformanceDiagnostics.measure(
        'operational-dynamic',
        'deckOverlay.setProps',
        () => activeOverlay.setProps({ layers: [...layers.deckLayers] }),
        { deckLayers: layers.deckLayers.length },
      )
      if (operationalDiagnosticsReported) return
      operationalDiagnosticsReported = true
      diagnostics.start('operational-dynamic', `Applying ${layers.deckLayers.length} deck layers`)
      diagnostics.ready('operational-dynamic', 'Deck overlay ready', [
        { label: 'Deck layers', value: String(layers.deckLayers.length) },
      ])
      emitDiagnostics()
    },
    setStyleUrl: async (styleUrl: string): Promise<void> => {
      diagnostics.start('base', 'Changing vector map style')
      emitDiagnostics()
      mapPerformanceDiagnostics.measure(
        'base',
        'MapLibre setStyle',
        () => current.setStyle(styleUrl),
        { styleUrl },
      )
      try {
        await waitForBase(current, diagnostics, 'base', () => destroyed)
      } catch (err) {
        emitDiagnostics()
        throw err
      }
      emitDiagnostics()
    },
    resize: () => {
      current.resize({ source: 'leitbild-runtime-resize' })
    },
    diagnostics: snapshot,
    destroy: () => {
      destroyResources()
    },
  }
}
