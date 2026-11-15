import { Popup, type Map as MapLibreMap, type PositionAnchor } from 'maplibre-gl'
import type { MapPrompt } from '../surface-panel-interaction.ts'

/**
 * The map's one panel prompt: one or two buttons offset from a point, drawn
 * as a MapLibre popup so they stay by their point while the map moves. The
 * popup sits above the point by default and beside or below it only where
 * the map edge leaves no room; it is always offset clear of the point, never
 * over it. A tap on a button confirms that option; the buttons are real
 * controls, so a tap on one never also counts as a click on the ground
 * beneath. A click anywhere on the map dismisses the prompt without
 * confirming (`dismiss`, called by the map for every click).
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

export interface MapPromptController {
  /** Shows the prompt, replacing any other, or clears it with null. */
  readonly show: (prompt: MapPrompt | null) => void
  readonly dismiss: () => boolean
  readonly destroy: () => void
}

export const createMapPromptController = (config: { readonly getMap: () => MapLibreMap | null }): MapPromptController => {
  let popup: Popup | null = null
  let shown: MapPrompt | null = null

  const dismiss = (): boolean => {
    if (popup === null) return false
    const map = config.getMap()
    const restoreFocus = popup.getElement().contains(document.activeElement)
    popup.remove()
    popup = null
    if (restoreFocus) map?.getCanvas().focus({ preventScroll: true })
    return true
  }

  return {
    show: prompt => {
      if (prompt === shown) return
      dismiss()
      const map = config.getMap()
      if (prompt === null || map === null) { shown = null; return }
      shown = prompt
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
      const [lon, lat] = prompt.point.coordinates
      const content = document.createElement('div')
      content.className = 'map-prompt-actions'
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'map-popup-dismiss'
      close.setAttribute('aria-label', 'Dismiss map prompt')
      close.textContent = '×'
      close.addEventListener('click', event => { event.stopPropagation(); dismiss() })
      content.append(...buttons, close)
      popup = new Popup({ closeButton: false, closeOnClick: false, offset: { ...mapPromptOffsets }, className: 'map-prompt' })
        .setLngLat([lon, lat])
        .setDOMContent(content)
        .addTo(map)
    },
    dismiss,
    destroy: () => { dismiss(); shown = null },
  }
}
