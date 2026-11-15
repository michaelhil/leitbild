import { Popup, type Map as MapLibreMap } from 'maplibre-gl'
import type { MapPrompt } from '../surface-panel-interaction.ts'

/**
 * The map's one panel prompt: a button anchored at a point, drawn as a
 * MapLibre popup so it stays on its point while the map moves. A tap on the
 * button confirms; the button is a real control, so it never also counts as
 * a click on the ground beneath it.
 */

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
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'map-prompt-button'
      button.textContent = prompt.label
      shown = prompt
      button.addEventListener('click', event => {
        event.stopPropagation()
        prompt.onConfirm()
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
      content.append(button, close)
      popup = new Popup({ closeButton: false, closeOnClick: false, anchor: 'bottom', offset: 10, className: 'map-prompt' })
        .setLngLat([lon, lat])
        .setDOMContent(content)
        .addTo(map)
    },
    dismiss,
    destroy: () => { dismiss(); shown = null },
  }
}
