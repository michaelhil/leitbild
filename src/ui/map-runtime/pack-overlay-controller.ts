import type { GeoJsonPolygon, IsoTimestamp } from '../../core/model/index.ts'
import type { PackMapAreaFeature } from '../../core/packs/protocol.ts'
import type { MapPerformanceDiagnostics } from './map-performance-diagnostics.ts'
import type { MapRuntimeHandle } from './types.ts'

export interface PackOverlayControllerRefreshContext {
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
  readonly currentTime?: IsoTimestamp
  readonly signal?: AbortSignal
}

export interface PackOverlayControllerConfig {
  readonly getRuntime: () => MapRuntimeHandle | null
  readonly getViewport: () => GeoJsonPolygon | null
  readonly getCurrentTime: () => IsoTimestamp | undefined
  readonly getSourceRevisionKey: () => string
  readonly enabled: () => boolean
  readonly loadFeatures: (context: PackOverlayControllerRefreshContext) => Promise<ReadonlyArray<PackMapAreaFeature>>
  readonly setFeatures: (features: ReadonlyArray<PackMapAreaFeature>) => void
  readonly onFeaturesChanged: () => void
  readonly onError: (message: string) => void
  readonly performanceDiagnostics: MapPerformanceDiagnostics
  readonly refreshIntervalMs?: number
}

export interface PackOverlayController {
  readonly refresh: () => Promise<void>
  readonly syncEnabled: () => void
  readonly setCameraGestureActive: (active: boolean) => void
  readonly abort: (reason: string) => void
  readonly destroy: () => void
}

const defaultRefreshIntervalMs = 2_000

const roundedKey = (value: number, digits: number): string =>
  value.toFixed(digits)

const viewportKeyFor = (
  viewport: GeoJsonPolygon,
  zoom: number,
): string => {
  const coordinates = viewport.coordinates.flatMap(ring => ring)
  const west = Math.min(...coordinates.map(coordinate => coordinate[0]))
  const east = Math.max(...coordinates.map(coordinate => coordinate[0]))
  const south = Math.min(...coordinates.map(coordinate => coordinate[1]))
  const north = Math.max(...coordinates.map(coordinate => coordinate[1]))
  const digits = zoom < 7 ? 2 : zoom < 10 ? 3 : 4
  return [
    roundedKey(west, digits),
    roundedKey(south, digits),
    roundedKey(east, digits),
    roundedKey(north, digits),
  ].join(',')
}

const timeBucketKey = (time: IsoTimestamp | undefined): string => {
  if (!time) return 'none'
  const epochMs = Date.parse(time)
  if (!Number.isFinite(epochMs)) return String(time)
  return String(Math.floor(epochMs / 2_000))
}

const requestKeyFor = (config: {
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
  readonly currentTime?: IsoTimestamp
  readonly sourceRevisionKey: string
}): string => [
  viewportKeyFor(config.viewport, config.zoom),
  String(Math.floor(config.zoom * 4) / 4),
  timeBucketKey(config.currentTime),
  config.sourceRevisionKey,
].join('|')

export const createPackOverlayController = (
  config: PackOverlayControllerConfig,
): PackOverlayController => {
  let refreshInterval: ReturnType<typeof setInterval> | null = null
  let requestSerial = 0
  let requestInFlight = false
  let refreshQueued = false
  let abortController: AbortController | null = null
  let requestKey: string | null = null
  let cacheKey: string | null = null
  let cameraGestureActive = false
  let featuresApplied = false
  let disabledReadyReported = false

  const stopAutoRefresh = (): void => {
    if (refreshInterval === null) return
    clearInterval(refreshInterval)
    refreshInterval = null
  }

  const clearFeatures = (): void => {
    if (!featuresApplied && disabledReadyReported) return
    const runtime = config.getRuntime()
    if (!featuresApplied && !runtime) return
    config.setFeatures([])
    featuresApplied = false
    cacheKey = null
    requestKey = null
    runtime?.reportDiagnosticPhase({
      phase: 'operational-static',
      status: 'ready',
      message: 'No pack area features active',
      details: [],
    })
    disabledReadyReported = Boolean(runtime)
    config.onFeaturesChanged()
  }

  const abort = (reason: string): void => {
    if (!abortController) return
    requestSerial += 1
    abortController.abort(new Error(reason))
    abortController = null
    requestKey = null
  }

  const refresh = async (): Promise<void> => {
    if (!config.enabled()) {
      clearFeatures()
      return
    }
    const runtime = config.getRuntime()
    const viewport = config.getViewport()
    if (!runtime || !viewport) return
    disabledReadyReported = false
    const zoom = runtime.map.getZoom()
    const currentTime = config.getCurrentTime()
    const nextRequestKey = requestKeyFor({
      viewport,
      zoom,
      sourceRevisionKey: config.getSourceRevisionKey(),
      ...(currentTime === undefined ? {} : { currentTime }),
    })
    if (cacheKey === nextRequestKey) return
    if (requestInFlight) {
      if (requestKey === nextRequestKey) return
      refreshQueued = true
      return
    }

    const serial = ++requestSerial
    const nextAbortController = new AbortController()
    abortController = nextAbortController
    requestKey = nextRequestKey
    requestInFlight = true
    runtime.reportDiagnosticPhase({
      phase: 'operational-static',
      status: 'running',
      message: 'Refreshing pack area features',
      details: [
        { label: 'Zoom', value: zoom.toFixed(2) },
      ],
    })
    try {
      const features = await config.performanceDiagnostics.measureAsync(
        'operational-static',
        'packOverlay.loadFeatures',
        async () => config.loadFeatures({
          viewport,
          zoom,
          signal: nextAbortController.signal,
          ...(currentTime === undefined ? {} : { currentTime }),
        }),
        { zoom: Number(zoom.toFixed(2)) },
      )
      if (serial !== requestSerial) return
      config.setFeatures(features)
      featuresApplied = features.length > 0
      cacheKey = nextRequestKey
      runtime.reportDiagnosticPhase({
        phase: 'operational-static',
        status: 'ready',
        message: 'Pack area features ready',
        details: [
          { label: 'Features', value: String(features.length) },
          { label: 'Zoom', value: zoom.toFixed(2) },
        ],
      })
      config.onFeaturesChanged()
    } catch (err) {
      if (serial !== requestSerial) return
      const message = err instanceof Error ? err.message : String(err)
      runtime.reportDiagnosticPhase({
        phase: 'operational-static',
        status: 'failed',
        message,
        error: {
          phase: 'operational-static',
          message,
          recoverable: true,
        },
      })
      config.onError(message)
    } finally {
      if (abortController === nextAbortController) abortController = null
      if (requestKey === nextRequestKey) requestKey = null
      requestInFlight = false
      if (refreshQueued) {
        refreshQueued = false
        window.setTimeout(() => { void refresh() }, 0)
      }
    }
  }

  const startAutoRefresh = (): void => {
    if (refreshInterval !== null) return
    refreshInterval = setInterval(() => {
      if (!config.enabled() || cameraGestureActive) return
      void refresh()
    }, config.refreshIntervalMs ?? defaultRefreshIntervalMs)
  }

  return {
    refresh,
    syncEnabled: () => {
      if (!config.enabled()) {
        abort('pack area features disabled')
        stopAutoRefresh()
        clearFeatures()
        return
      }
      startAutoRefresh()
      void refresh()
    },
    setCameraGestureActive: active => {
      cameraGestureActive = active
    },
    abort,
    destroy: () => {
      stopAutoRefresh()
      abort('pack overlay controller was destroyed')
      requestInFlight = false
      refreshQueued = false
      cacheKey = null
      requestKey = null
      cameraGestureActive = false
      featuresApplied = false
      disabledReadyReported = false
    },
  }
}
