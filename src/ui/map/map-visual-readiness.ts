import type { Map as MapLibreMap } from 'maplibre-gl'

export interface MapVisualReadinessOptions {
  readonly timeoutMs?: number
  readonly recordDebug?: (label: string) => void
  readonly isCancelled?: () => boolean
}

const defaultTimeoutMs = 5_000

const dimensionIsVisible = (value: number): boolean =>
  Number.isFinite(value) && value >= 1

const mapCanvasIsPresentable = (map: MapLibreMap): boolean => {
  try {
    const containerRect = map.getContainer().getBoundingClientRect()
    const canvas = map.getCanvas()
    const canvasRect = canvas.getBoundingClientRect()
    return dimensionIsVisible(containerRect.width)
      && dimensionIsVisible(containerRect.height)
      && dimensionIsVisible(canvasRect.width)
      && dimensionIsVisible(canvasRect.height)
      && canvas.width > 0
      && canvas.height > 0
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

export const waitForMapVisualReadiness = (
  map: MapLibreMap,
  options: MapVisualReadinessOptions = {},
): Promise<void> => new Promise(resolve => {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  let settled = false
  let animationFrame: number | null = null
  let timeout: number | null = null

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

  const settle = (reason: string): void => {
    if (settled) return
    settled = true
    cleanup()
    options.recordDebug?.(`visual-ready:${reason}`)
    resolve()
  }

  const cancelled = (): boolean => options.isCancelled?.() === true

  const maybeSettle = (reason: string): void => {
    if (cancelled()) {
      settle('cancelled')
      return
    }
    if (!mapCanvasIsPresentable(map)) return
    if (mapTilesAreSettled(map)) {
      settle(reason)
    }
  }

  function onRender(): void {
    maybeSettle('loaded-render')
  }

  function onIdle(): void {
    if (!mapCanvasIsPresentable(map)) return
    settle('idle')
  }

  map.on('render', onRender)
  map.on('idle', onIdle)
  timeout = window.setTimeout(() => {
    settle(mapCanvasIsPresentable(map) ? 'timeout-presentable' : 'timeout')
  }, timeoutMs)
  animationFrame = requestAnimationFrame(() => {
    animationFrame = null
    maybeSettle('animation-frame')
    try {
      map.triggerRepaint()
    } catch (err) {
      void err
      settle('repaint-unavailable')
    }
  })
})
