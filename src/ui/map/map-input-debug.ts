import type { Map as MapLibreMap } from 'maplibre-gl'
import { cameraInteractionDebug } from './map-camera.ts'

type Cleanup = () => void

type InputDebugEvent = Event & {
  readonly clientX?: number
  readonly clientY?: number
  readonly deltaX?: number
  readonly deltaY?: number
  readonly deltaMode?: number
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly shiftKey?: boolean
  readonly altKey?: boolean
  readonly pointerType?: string
  readonly button?: number
  readonly buttons?: number
  readonly scale?: number
  readonly rotation?: number
}

export interface MapInputDebugController {
  readonly install: (current: MapLibreMap) => void
  readonly record: (label: string, event?: Event) => void
  readonly stop: () => void
}

const targetDescription = (target: EventTarget | Element | null): string => {
  if (!(target instanceof Element)) return target === window ? 'window' : target === document ? 'document' : 'unknown'
  const id = target.id ? `#${target.id}` : ''
  const classes = target.classList.length > 0 ? `.${[...target.classList].slice(0, 4).join('.')}` : ''
  return `${target.tagName.toLowerCase()}${id}${classes}`
}

const topElementDescription = (event: InputDebugEvent): string => {
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return 'n/a'
  return targetDescription(document.elementFromPoint(event.clientX!, event.clientY!))
}

const cameraStateDebug = (current: MapLibreMap | null): string => {
  if (!current) return 'camera=no-map'
  const center = current.getCenter()
  const canvas = current.getCanvas()
  const container = current.getContainer()
  return [
    `z=${current.getZoom().toFixed(2)}`,
    `c=${center.lng.toFixed(5)},${center.lat.toFixed(5)}`,
    `moving=${current.isMoving()}`,
    `canvas=${canvas.width}x${canvas.height}`,
    `container=${Math.round(container.clientWidth)}x${Math.round(container.clientHeight)}`,
  ].join(' ')
}

const eventModifierDebug = (event: InputDebugEvent): string => {
  const modifiers = [
    event.ctrlKey ? 'ctrl' : '',
    event.metaKey ? 'meta' : '',
    event.shiftKey ? 'shift' : '',
    event.altKey ? 'alt' : '',
  ].filter(Boolean)
  return modifiers.length > 0 ? modifiers.join('+') : 'no-mod'
}

const eventDetailDebug = (event: InputDebugEvent): string => {
  const details = [
    event.pointerType ? `pointer=${event.pointerType}` : '',
    typeof event.button === 'number' ? `button=${event.button}` : '',
    typeof event.buttons === 'number' ? `buttons=${event.buttons}` : '',
    typeof event.deltaY === 'number' ? `d=${Math.round(event.deltaX ?? 0)},${Math.round(event.deltaY)} mode=${event.deltaMode ?? 'n/a'}` : '',
    typeof event.scale === 'number' ? `scale=${event.scale.toFixed(3)}` : '',
    typeof event.rotation === 'number' ? `rotation=${event.rotation.toFixed(1)}` : '',
  ].filter(Boolean)
  return details.length > 0 ? details.join(' ') : 'no-detail'
}

const addDebugListener = (
  cleanups: Array<Cleanup>,
  target: EventTarget,
  targetName: string,
  eventType: string,
  record: (label: string, event?: Event) => void,
): void => {
  const listener = (event: Event): void => record(`${targetName}:${eventType}`, event)
  target.addEventListener(eventType, listener, { capture: true, passive: true })
  cleanups.push(() => target.removeEventListener(eventType, listener, { capture: true }))
}

export const createMapInputDebugController = (config: {
  readonly enabled: () => boolean
  readonly getMap: () => MapLibreMap | null
  readonly setSummary: (summary: string) => void
  readonly appendEntry: (entry: string) => void
}): MapInputDebugController => {
  let stopDebug: Cleanup | null = null

  const record = (label: string, event?: Event): void => {
    if (!config.enabled()) return
    const inputEvent = event as InputDebugEvent | undefined
    const current = config.getMap()
    const entry = [
      `${performance.now().toFixed(0)}ms`,
      label,
      inputEvent ? `type=${inputEvent.type}` : 'type=note',
      inputEvent ? `target=${targetDescription(inputEvent.target)}` : '',
      inputEvent ? `top=${topElementDescription(inputEvent)}` : '',
      inputEvent ? `default=${inputEvent.defaultPrevented}` : '',
      inputEvent ? eventModifierDebug(inputEvent) : '',
      inputEvent ? eventDetailDebug(inputEvent) : '',
      cameraInteractionDebug(current),
      cameraStateDebug(current),
    ].filter(Boolean).join(' | ')
    config.setSummary(entry)
    config.appendEntry(entry)
  }

  const install = (current: MapLibreMap): void => {
    if (!config.enabled()) return
    stopDebug?.()
    const cleanups: Array<Cleanup> = []
    const canvas = current.getCanvas()
    const container = current.getContainer()
    const canvasContainer = current.getCanvasContainer()
    for (const eventType of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'touchstart', 'touchmove', 'touchend', 'gesturestart', 'gesturechange', 'gestureend']) {
      addDebugListener(cleanups, window, 'window', eventType, record)
      addDebugListener(cleanups, document, 'document', eventType, record)
      addDebugListener(cleanups, container, 'container', eventType, record)
      addDebugListener(cleanups, canvasContainer, 'canvas-container', eventType, record)
      addDebugListener(cleanups, canvas, 'canvas', eventType, record)
    }
    for (const eventType of ['dragstart', 'drag', 'dragend', 'zoomstart', 'zoom', 'zoomend', 'movestart', 'move', 'moveend']) {
      const listener = (event: unknown): void => record(`maplibre:${eventType}`, event instanceof Event ? event : undefined)
      current.on(eventType, listener)
      cleanups.push(() => current.off(eventType, listener))
    }
    stopDebug = () => {
      for (const cleanup of cleanups) cleanup()
      stopDebug = null
    }
    record('debug:installed')
  }

  return {
    install,
    record,
    stop: () => {
      stopDebug?.()
    },
  }
}
