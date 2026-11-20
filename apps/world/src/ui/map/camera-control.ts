import { mount, unmount } from 'svelte'
import type { IControl } from 'maplibre-gl'
import { Focus, House, Maximize } from 'lucide-svelte'
import type { RunCameraActionId, RunCameraButton } from '../run-view-actions.ts'

export interface CameraControl extends IControl {
  update(buttons: ReadonlyArray<RunCameraButton>): void
}

const icons = { home: House, 'fit-visible': Maximize, 'fit-selected': Focus } as const
const order: ReadonlyArray<RunCameraActionId> = ['home', 'fit-visible', 'fit-selected']

/**
 * The map's camera group: one row of icon buttons in a MapLibre control
 * group, showing the buttons its owner lists (`runCameraButtons`). A button
 * that cannot act stays focusable and says why in its hover text.
 *
 * MapLibre puts a control added to a bottom corner above those already there,
 * and the 3D switch is added later, with the layouts. The row therefore keeps
 * itself the top of its corner, so 3D stays directly above zoom.
 */
export const createCameraControl = (options: { readonly initial: ReadonlyArray<RunCameraButton>; readonly onAction: (id: RunCameraActionId) => void }): CameraControl => {
  const container = document.createElement('div')
  container.className = 'maplibregl-ctrl maplibregl-ctrl-group camera-control'
  let shown = new Map(options.initial.map(button => [button.id, button]))
  const elements = new Map(order.map(id => {
    const button = document.createElement('button')
    button.type = 'button'
    const icon = mount(icons[id], { target: button, props: { size: 16, 'aria-hidden': 'true' } })
    button.addEventListener('click', () => { if (shown.get(id)?.disabledReason === null) options.onAction(id) })
    return [id, { button, icon }] as const
  }))
  const render = (): void => {
    let previous: HTMLButtonElement | null = null
    for (const id of order) {
      const { button } = elements.get(id)!, state = shown.get(id)
      if (state === undefined) { button.remove(); continue }
      button.setAttribute('aria-label', state.label)
      button.title = state.disabledReason === null ? state.label : `${state.label} · ${state.disabledReason}`
      if (state.disabledReason === null) button.removeAttribute('aria-disabled')
      else button.setAttribute('aria-disabled', 'true')
      // A button already in its place is left there: moving it would drop keyboard focus.
      const expected: Element | null = previous === null ? container.firstElementChild : previous.nextElementSibling
      if (expected !== button) container.insertBefore(button, expected)
      previous = button
    }
  }
  render()
  let corner: Element | null = null
  const stayOnTop = new MutationObserver(() => { if (corner !== null && container.parentElement === corner && corner.firstElementChild !== container) corner.prepend(container) })
  return {
    onAdd: map => {
      corner = map.getContainer().querySelector('.maplibregl-ctrl-bottom-right')
      if (corner === null) throw new Error('The camera control belongs to the map\'s lower-right control stack')
      stayOnTop.observe(corner, { childList: true })
      return container
    },
    // MapLibre calls this from map.remove() and again from an owner's removeControl.
    onRemove: () => {
      if (corner === null) return
      stayOnTop.disconnect()
      corner = null
      for (const { icon } of elements.values()) void unmount(icon)
      container.remove()
    },
    update: buttons => { shown = new Map(buttons.map(button => [button.id, button])); render() },
  }
}
