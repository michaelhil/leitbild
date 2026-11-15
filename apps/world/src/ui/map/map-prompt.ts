import { Popup, type Map as MapLibreMap, type PositionAnchor } from 'maplibre-gl'
import type { MapPrompt } from '../surface-panel-interaction.ts'

/**
 * The map's one panel prompt: one or two buttons offset from a point, drawn
 * as a MapLibre popup so they stay by their point while the map moves. The
 * popup sits above the point by default and beside or below it only where
 * the map edge leaves no room; it is always offset clear of the point, never
 * over it. A tap on a button confirms that option; the buttons are real
 * controls, so a tap on one never also counts as a click on the ground
 * beneath.
 *
 * The operator dismisses the prompt without confirming by a click anywhere
 * on the map, its × or Esc (`dismiss`, which the map calls for each). A
 * dismissal is never silent: `onDismiss` hears of each one, once, so the
 * surface drops the prompt and tells its panel. A prompt the panel replaces
 * or clears, or the map's teardown, is no dismissal.
 */

/** How far the popup stands off its point, per anchor MapLibre picks: clear of a 44 px tap around the point. */
const clearOfPointPx = 26
const diagonalPx = Math.round(clearOfPointPx * Math.SQRT1_2)
export const mapPromptOffsets: Readonly<Record<PositionAnchor, [number, number]>> = {
  center: [0, -clearOfPointPx],
  top: [0, clearOfPointPx],
  bottom: [0, -clearOfPointPx],
  left: [clearOfPointPx, 0],
  right: [-clearOfPointPx, 0],
  'top-left': [diagonalPx, diagonalPx],
  'top-right': [-diagonalPx, diagonalPx],
  'bottom-left': [diagonalPx, -diagonalPx],
  'bottom-right': [-diagonalPx, -diagonalPx],
}

/** A prompt drawn on the map. */
export interface MapPromptView {
  /** Takes the drawn prompt off the map. */
  readonly remove: () => void
}

/** Draws a prompt; its × calls `dismiss`. */
export type MapPromptDraw = (map: MapLibreMap, prompt: MapPrompt, dismiss: () => void) => MapPromptView

export interface MapPromptController {
  /** Shows the prompt, replacing any other, or clears it with null; the same prompt again changes nothing, dismissed or not. */
  readonly show: (prompt: MapPrompt | null) => void
  /** The operator dismissed the shown prompt; false when none is shown. */
  readonly dismiss: () => boolean
  readonly destroy: () => void
}

/** The MapLibre popup: the options, then the ×. */
const drawPopup: MapPromptDraw = (map, prompt, dismiss) => {
  const buttons = prompt.options.map(option => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = option.tone === 'warning' ? 'map-prompt-button map-prompt-button-warning' : 'map-prompt-button'
    button.textContent = option.label
    button.addEventListener('click', event => {
      event.stopPropagation()
      option.onConfirm()
    })
    return button
  })
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'map-popup-dismiss'
  close.setAttribute('aria-label', 'Dismiss map prompt')
  close.textContent = '×'
  close.addEventListener('click', event => { event.stopPropagation(); dismiss() })
  const content = document.createElement('div')
  content.className = 'map-prompt-actions'
  content.append(...buttons, close)
  const [lon, lat] = prompt.point.coordinates
  const popup = new Popup({ closeButton: false, closeOnClick: false, offset: { ...mapPromptOffsets }, className: 'map-prompt' })
    .setLngLat([lon, lat])
    .setDOMContent(content)
    .addTo(map)
  return {
    remove: () => {
      const restoreFocus = popup.getElement().contains(document.activeElement)
      popup.remove()
      if (restoreFocus) map.getCanvas().focus({ preventScroll: true })
    },
  }
}

export const createMapPromptController = (config: {
  readonly getMap: () => MapLibreMap | null
  /** Each prompt the operator dismissed, once. */
  readonly onDismiss: (prompt: MapPrompt) => void
  /** How a prompt is drawn; the MapLibre popup unless a test draws it. */
  readonly draw?: MapPromptDraw
}): MapPromptController => {
  const draw = config.draw ?? drawPopup
  let view: MapPromptView | null = null
  // The prompt last given; it stays after a dismissal, so the same prompt given again is not drawn again.
  let shown: MapPrompt | null = null

  const remove = (): void => {
    view?.remove()
    view = null
  }

  const dismiss = (): boolean => {
    const prompt = shown
    if (view === null || prompt === null) return false
    remove()
    config.onDismiss(prompt)
    return true
  }

  return {
    show: prompt => {
      if (prompt === shown) return
      remove()
      const map = config.getMap()
      if (prompt === null || map === null) { shown = null; return }
      shown = prompt
      view = draw(map, prompt, dismiss)
    },
    dismiss,
    destroy: () => { remove(); shown = null },
  }
}
