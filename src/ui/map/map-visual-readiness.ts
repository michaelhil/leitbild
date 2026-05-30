import type { Map as MapLibreMap } from 'maplibre-gl'
import { mapLayerIds, mapSourceIds } from './map-features.ts'

export interface MapVisualReadinessOptions {
  readonly mode?: 'base' | 'operational'
  readonly timeoutMs?: number
  readonly recordDebug?: (label: string) => void
  readonly isCancelled?: () => boolean
  readonly requiredSourceIds?: ReadonlyArray<string>
  readonly requiredLayerIds?: ReadonlyArray<string>
  readonly sampleCanvas?: boolean
}

export interface MapCanvasSample {
  readonly supported: boolean
  readonly visiblePixels: number
  readonly variedPixels: number
  readonly sampleCount: number
  readonly error?: string
}

export interface MapVisualReadinessSnapshot {
  readonly mode: 'base' | 'operational'
  readonly phase: string
  readonly container: { readonly width: number; readonly height: number }
  readonly canvas: {
    readonly cssWidth: number
    readonly cssHeight: number
    readonly bufferWidth: number
    readonly bufferHeight: number
  }
  readonly styleLoaded: boolean
  readonly mapLoaded: boolean
  readonly missingSourceIds: ReadonlyArray<string>
  readonly missingLayerIds: ReadonlyArray<string>
  readonly renderedFeatureCount: number | null
  readonly canvasSample: MapCanvasSample
  readonly healthy: boolean
}

export interface MapVisualReadinessResult {
  readonly reason: string
  readonly snapshot: MapVisualReadinessSnapshot
}

export interface MapVisualReadinessFailure extends Error {
  readonly snapshot: MapVisualReadinessSnapshot
}

export const isMapVisualReadinessFailure = (err: unknown): err is MapVisualReadinessFailure =>
  err instanceof Error && 'snapshot' in err

const defaultTimeoutMs = 5_000
const baseMapSourceId = 'leitbild-osm'
const baseRequiredSourceIds: ReadonlyArray<string> = [baseMapSourceId]
const baseRequiredLayerIds: ReadonlyArray<string> = [
  'water',
  'landuse',
  'landcover',
  'road',
  'place-label',
]
const defaultRequiredSourceIds: ReadonlyArray<string> = [
  mapSourceIds.objects,
  mapSourceIds.placementPreview,
]
const defaultRequiredLayerIds: ReadonlyArray<string> = [
  mapLayerIds.objectHitArea,
  mapLayerIds.objectIcons,
  mapLayerIds.placementPreview,
]
const baseProbeLayerIds: ReadonlyArray<string> = [
  'water',
  'landuse',
  'landcover',
  'road',
  'road-label',
  'place-label',
]

const dimensionIsVisible = (value: number): boolean =>
  Number.isFinite(value) && value >= 1

const emptyCanvasSample = (error?: string): MapCanvasSample => ({
  supported: false,
  visiblePixels: 0,
  variedPixels: 0,
  sampleCount: 0,
  ...(error === undefined ? {} : { error }),
})

const mapStyleIsLoaded = (map: MapLibreMap): boolean => {
  try {
    return map.isStyleLoaded() === true
  } catch (err) {
    void err
    return false
  }
}

const mapTilesAreSettled = (map: MapLibreMap): boolean => {
  try {
    return map.loaded()
  } catch (err) {
    void err
    return false
  }
}

const requiredSourceIdsFor = (
  options: Pick<MapVisualReadinessOptions, 'mode' | 'requiredSourceIds'>,
): ReadonlyArray<string> =>
  options.requiredSourceIds ?? (options.mode === 'base' ? baseRequiredSourceIds : defaultRequiredSourceIds)

const requiredLayerIdsFor = (
  options: Pick<MapVisualReadinessOptions, 'mode' | 'requiredLayerIds'>,
): ReadonlyArray<string> =>
  options.requiredLayerIds ?? (options.mode === 'base' ? baseRequiredLayerIds : defaultRequiredLayerIds)

const webGlContext = (canvas: HTMLCanvasElement): WebGLRenderingContext | WebGL2RenderingContext | null => {
  try {
    return canvas.getContext('webgl2')
      ?? canvas.getContext('webgl')
  } catch (err) {
    void err
    return null
  }
}

const sampleCanvasPixels = (map: MapLibreMap): MapCanvasSample => {
  try {
    const canvas = map.getCanvas()
    const gl = webGlContext(canvas)
    if (!gl) return emptyCanvasSample('webgl context unavailable for readiness sampling')
    const width = gl.drawingBufferWidth
    const height = gl.drawingBufferHeight
    if (width <= 0 || height <= 0) return emptyCanvasSample('drawing buffer has no visible pixels')
    const points: ReadonlyArray<readonly [number, number]> = [
      [0.18, 0.18],
      [0.50, 0.18],
      [0.82, 0.18],
      [0.18, 0.50],
      [0.50, 0.50],
      [0.82, 0.50],
      [0.18, 0.82],
      [0.50, 0.82],
      [0.82, 0.82],
    ]
    let visiblePixels = 0
    let variedPixels = 0
    let previous: readonly [number, number, number, number] | null = null
    const pixel = new Uint8Array(4)
    for (const [xFraction, yFraction] of points) {
      const x = Math.max(0, Math.min(width - 1, Math.round(width * xFraction)))
      const y = Math.max(0, Math.min(height - 1, Math.round(height * yFraction)))
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      const current = [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, pixel[3] ?? 0] as const
      if (current[3] > 0 && (current[0] > 0 || current[1] > 0 || current[2] > 0)) visiblePixels += 1
      if (previous && (
        previous[0] !== current[0]
        || previous[1] !== current[1]
        || previous[2] !== current[2]
        || previous[3] !== current[3]
      )) {
        variedPixels += 1
      }
      previous = current
    }
    return {
      supported: true,
      visiblePixels,
      variedPixels,
      sampleCount: points.length,
    }
  } catch (err) {
    return emptyCanvasSample(err instanceof Error ? err.message : String(err))
  }
}

const countRenderedBaseFeatures = (map: MapLibreMap): number | null => {
  try {
    const availableLayerIds = baseProbeLayerIds.filter(layerId => map.getLayer(layerId))
    if (availableLayerIds.length === 0) return null
    return map.queryRenderedFeatures(undefined, { layers: availableLayerIds }).length
  } catch (err) {
    void err
    return null
  }
}

export const inspectMapVisualReadiness = (
  map: MapLibreMap,
  options: Pick<MapVisualReadinessOptions, 'mode' | 'requiredSourceIds' | 'requiredLayerIds' | 'sampleCanvas'> = {},
  phase = 'inspect',
): MapVisualReadinessSnapshot => {
  const mode = options.mode ?? 'operational'
  try {
    const containerRect = map.getContainer().getBoundingClientRect()
    const canvas = map.getCanvas()
    const canvasRect = canvas.getBoundingClientRect()
    const requiredSourceIds = requiredSourceIdsFor({ ...options, mode })
    const requiredLayerIds = requiredLayerIdsFor({ ...options, mode })
    const missingSourceIds = requiredSourceIds.filter(sourceId => !map.getSource(sourceId))
    const missingLayerIds = requiredLayerIds.filter(layerId => !map.getLayer(layerId))
    const presentable = dimensionIsVisible(containerRect.width)
      && dimensionIsVisible(containerRect.height)
      && dimensionIsVisible(canvasRect.width)
      && dimensionIsVisible(canvasRect.height)
      && canvas.width > 0
      && canvas.height > 0
    const styleLoaded = mapStyleIsLoaded(map)
    const mapLoaded = mapTilesAreSettled(map)
    const renderedFeatureCount = countRenderedBaseFeatures(map)
    const canvasSample = options.sampleCanvas === true
      ? sampleCanvasPixels(map)
      : emptyCanvasSample('canvas sampling disabled for readiness performance')
    const hasRenderedEvidence = (renderedFeatureCount ?? 0) > 0
      || (canvasSample.supported && canvasSample.visiblePixels > 0)
    return {
      mode,
      phase,
      container: {
        width: Math.round(containerRect.width),
        height: Math.round(containerRect.height),
      },
      canvas: {
        cssWidth: Math.round(canvasRect.width),
        cssHeight: Math.round(canvasRect.height),
        bufferWidth: canvas.width,
        bufferHeight: canvas.height,
      },
      styleLoaded,
      mapLoaded,
      missingSourceIds,
      missingLayerIds,
      renderedFeatureCount,
      canvasSample,
      healthy: presentable
        && missingSourceIds.length === 0
        && missingLayerIds.length === 0
        && hasRenderedEvidence,
    }
  } catch (err) {
    return {
      mode,
      phase,
      container: { width: 0, height: 0 },
      canvas: { cssWidth: 0, cssHeight: 0, bufferWidth: 0, bufferHeight: 0 },
      styleLoaded: false,
      mapLoaded: false,
      missingSourceIds: requiredSourceIdsFor({ ...options, mode }),
      missingLayerIds: requiredLayerIdsFor({ ...options, mode }),
      renderedFeatureCount: null,
      canvasSample: emptyCanvasSample(err instanceof Error ? err.message : String(err)),
      healthy: false,
    }
  }
}

export const waitForMapVisualReadiness = (
  map: MapLibreMap,
  options: MapVisualReadinessOptions = {},
): Promise<MapVisualReadinessResult> => new Promise((resolve, reject) => {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  let settled = false
  let animationFrame: number | null = null
  let timeout: number | null = null
  let lastSnapshot = inspectMapVisualReadiness(map, options, 'initial')

  const cleanup = (): void => {
    map.off('render', onRender)
    map.off('idle', onIdle)
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame)
      animationFrame = null
    }
    if (timeout !== null) {
      window.clearTimeout(timeout)
      timeout = null
    }
  }

  const settle = (reason: string, snapshot: MapVisualReadinessSnapshot): void => {
    if (settled) return
    settled = true
    cleanup()
    options.recordDebug?.(`visual-ready:${reason}`)
    resolve({ reason, snapshot })
  }

  const fail = (reason: string, snapshot: MapVisualReadinessSnapshot): void => {
    if (settled) return
    settled = true
    cleanup()
    options.recordDebug?.(`visual-not-ready:${reason}`)
    const error = new Error(
      `Map did not reach a healthy rendered frame: ${reason}; `
      + `mode=${snapshot.mode}; `
      + `container=${snapshot.container.width}x${snapshot.container.height}; `
      + `canvas=${snapshot.canvas.cssWidth}x${snapshot.canvas.cssHeight}/${snapshot.canvas.bufferWidth}x${snapshot.canvas.bufferHeight}; `
      + `styleLoaded=${snapshot.styleLoaded}; mapLoaded=${snapshot.mapLoaded}; `
      + `missingSources=${snapshot.missingSourceIds.join(',') || 'none'}; `
      + `missingLayers=${snapshot.missingLayerIds.join(',') || 'none'}; `
      + `renderedFeatures=${snapshot.renderedFeatureCount ?? 'unknown'}; `
      + `canvasVisiblePixels=${snapshot.canvasSample.visiblePixels}/${snapshot.canvasSample.sampleCount}; `
      + `canvasVariedPixels=${snapshot.canvasSample.variedPixels}`,
    ) as MapVisualReadinessFailure
    Object.assign(error, { snapshot })
    reject(error)
  }

  const cancelled = (): boolean => options.isCancelled?.() === true

  const maybeSettle = (reason: string): void => {
    if (cancelled()) {
      settle('cancelled', inspectMapVisualReadiness(map, options, 'cancelled'))
      return
    }
    lastSnapshot = inspectMapVisualReadiness(map, options, reason)
    if (lastSnapshot.healthy) settle(reason, lastSnapshot)
  }

  function onRender(): void {
    maybeSettle('loaded-render')
  }

  function onIdle(): void {
    maybeSettle('idle')
  }

  map.on('render', onRender)
  map.on('idle', onIdle)
  timeout = window.setTimeout(() => {
    lastSnapshot = inspectMapVisualReadiness(map, { ...options, sampleCanvas: true }, 'timeout')
    if (lastSnapshot.healthy) {
      settle('timeout-healthy', lastSnapshot)
      return
    }
    fail('timeout', lastSnapshot)
  }, timeoutMs)
  animationFrame = requestAnimationFrame(() => {
    animationFrame = null
    maybeSettle('animation-frame')
    try {
      map.triggerRepaint()
    } catch (err) {
      if (cancelled()) {
        settle('repaint-cancelled', inspectMapVisualReadiness(map, options, 'repaint-cancelled'))
        return
      }
      lastSnapshot = inspectMapVisualReadiness(map, options, 'repaint-unavailable')
      fail(err instanceof Error ? err.message : 'repaint unavailable', lastSnapshot)
    }
  })
})
