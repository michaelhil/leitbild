import type { Map as MapLibreMap } from 'maplibre-gl'
import type { MapRuntimeDiagnosticDetail } from './types.ts'

export interface BaseMapReadinessSnapshot {
  readonly container: { readonly width: number; readonly height: number }
  readonly canvas: { readonly cssWidth: number; readonly cssHeight: number; readonly bufferWidth: number; readonly bufferHeight: number }
  readonly styleLoaded: boolean
  readonly styleGraphReady: boolean
  readonly mapLoaded: boolean
  readonly baseSourcePresent: boolean
  readonly requiredLayersPresent: boolean
  readonly missingLayerIds: ReadonlyArray<string>
  readonly sawRender: boolean
  readonly sawIdle: boolean
  readonly healthy: boolean
}

export interface BaseMapReadinessResult {
  readonly snapshot: BaseMapReadinessSnapshot
  readonly details: ReadonlyArray<MapRuntimeDiagnosticDetail>
}

export interface BaseMapReadinessOptions {
  readonly timeoutMs?: number
  readonly baseSourceId?: string
  readonly requiredLayerIds?: ReadonlyArray<string>
  readonly isCancelled?: () => boolean
}

export interface BaseMapReadinessFailure extends Error {
  readonly snapshot: BaseMapReadinessSnapshot
}

export const isBaseMapReadinessFailure = (err: unknown): err is BaseMapReadinessFailure =>
  err instanceof Error && 'snapshot' in err

const defaultTimeoutMs = 8_000
const defaultBaseSourceId = 'leitbild-osm'
const defaultRequiredLayerIds: ReadonlyArray<string> = [
  'water',
  'landuse',
  'landcover',
  'road',
  'place-label',
]

const visibleDimension = (value: number): boolean =>
  Number.isFinite(value) && value >= 1

const safeBoolean = (read: () => boolean): boolean => {
  try {
    return read()
  } catch (err) {
    void err
    return false
  }
}

export const inspectBaseMapReadiness = (
  map: MapLibreMap,
  options: BaseMapReadinessOptions = {},
  eventState: { readonly sawRender?: boolean; readonly sawIdle?: boolean } = {},
): BaseMapReadinessSnapshot => {
  const containerRect = map.getContainer().getBoundingClientRect()
  const canvas = map.getCanvas()
  const canvasRect = canvas.getBoundingClientRect()
  const requiredLayerIds = options.requiredLayerIds ?? defaultRequiredLayerIds
  const missingLayerIds = requiredLayerIds.filter(layerId => !map.getLayer(layerId))
  const baseSourcePresent = Boolean(map.getSource(options.baseSourceId ?? defaultBaseSourceId))
  const styleLoaded = safeBoolean(() => map.isStyleLoaded() === true)
  const mapLoaded = safeBoolean(() => map.loaded() === true)
  const styleGraphReady = baseSourcePresent && missingLayerIds.length === 0
  const presentable = visibleDimension(containerRect.width)
    && visibleDimension(containerRect.height)
    && visibleDimension(canvasRect.width)
    && visibleDimension(canvasRect.height)
    && canvas.width > 0
    && canvas.height > 0
  const sawRender = eventState.sawRender === true
  const sawIdle = eventState.sawIdle === true
  return {
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
    styleGraphReady,
    mapLoaded,
    baseSourcePresent,
    requiredLayersPresent: missingLayerIds.length === 0,
    missingLayerIds,
    sawRender,
    sawIdle,
    healthy: presentable && styleGraphReady && sawRender,
  }
}

export const baseMapReadinessDetails = (
  snapshot: BaseMapReadinessSnapshot,
): ReadonlyArray<MapRuntimeDiagnosticDetail> => [
  { label: 'Container', value: `${snapshot.container.width}x${snapshot.container.height}` },
  { label: 'Canvas', value: `${snapshot.canvas.cssWidth}x${snapshot.canvas.cssHeight}/${snapshot.canvas.bufferWidth}x${snapshot.canvas.bufferHeight}` },
  { label: 'Style', value: snapshot.styleLoaded ? 'loaded' : snapshot.styleGraphReady ? 'graph-ready' : 'loading' },
  { label: 'Map tiles', value: snapshot.mapLoaded ? 'settled' : 'loading' },
  { label: 'Base source', value: snapshot.baseSourcePresent ? 'present' : 'missing' },
  { label: 'Base layers', value: snapshot.requiredLayersPresent ? 'present' : `missing ${snapshot.missingLayerIds.join(', ')}` },
  { label: 'Render event', value: snapshot.sawRender ? 'seen' : 'pending' },
  { label: 'Idle event', value: snapshot.sawIdle ? 'seen' : 'pending' },
]

export const waitForBaseMapReadiness = (
  map: MapLibreMap,
  options: BaseMapReadinessOptions = {},
): Promise<BaseMapReadinessResult> => new Promise((resolve, reject) => {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  let sawRender = false
  let sawIdle = false
  let settled = false
  let timeout: number | null = null
  let frame: number | null = null

  const cleanup = (): void => {
    map.off('render', onRender)
    map.off('idle', onIdle)
    map.off('style.load', onStyleLoad)
    if (timeout !== null) window.clearTimeout(timeout)
    if (frame !== null) cancelAnimationFrame(frame)
    timeout = null
    frame = null
  }

  const settle = (snapshot: BaseMapReadinessSnapshot): void => {
    if (settled) return
    settled = true
    cleanup()
    resolve({ snapshot, details: baseMapReadinessDetails(snapshot) })
  }

  const fail = (snapshot: BaseMapReadinessSnapshot): void => {
    if (settled) return
    settled = true
    cleanup()
    const error = new Error(
      `Base map did not become ready; style=${snapshot.styleLoaded ? 'loaded' : snapshot.styleGraphReady ? 'graph-ready' : 'loading'}; `
      + `source=${snapshot.baseSourcePresent ? 'present' : 'missing'}; `
      + `layers=${snapshot.missingLayerIds.join(',') || 'ok'}; `
      + `container=${snapshot.container.width}x${snapshot.container.height}; `
      + `canvas=${snapshot.canvas.cssWidth}x${snapshot.canvas.cssHeight}/${snapshot.canvas.bufferWidth}x${snapshot.canvas.bufferHeight}`,
    ) as BaseMapReadinessFailure
    Object.assign(error, { snapshot })
    reject(error)
  }

  const inspect = (): BaseMapReadinessSnapshot =>
    inspectBaseMapReadiness(map, options, { sawRender, sawIdle })

  const maybeSettle = (): void => {
    if (settled) return
    if (options.isCancelled?.() === true) {
      settle(inspect())
      return
    }
    const snapshot = inspect()
    if (snapshot.healthy) settle(snapshot)
  }

  function onRender(): void {
    sawRender = true
    maybeSettle()
  }

  function onIdle(): void {
    sawIdle = true
    maybeSettle()
  }

  function onStyleLoad(): void {
    maybeSettle()
  }

  map.on('render', onRender)
  map.on('idle', onIdle)
  map.on('style.load', onStyleLoad)
  timeout = window.setTimeout(() => {
    const snapshot = inspect()
    if (snapshot.healthy) settle(snapshot)
    else fail(snapshot)
  }, timeoutMs)
  frame = requestAnimationFrame(() => {
    frame = null
    maybeSettle()
    map.triggerRepaint()
  })
  maybeSettle()
})
