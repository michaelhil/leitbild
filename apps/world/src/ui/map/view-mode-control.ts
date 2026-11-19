import type { IControl } from 'maplibre-gl'

export type ViewMode = '2d' | '3d'

/** What the owner knows: the representation shown, and why it cannot be changed now (null when it can). */
export interface ViewModeControlInput {
  readonly mode: ViewMode
  readonly disabledReason: string | null
}

export interface ViewModeControlState {
  readonly pressed: boolean
  readonly disabled: boolean
  /** Hover text: what a press does, or why a press does nothing. */
  readonly title: string
  /** The representation a press asks for; null while the control is disabled. */
  readonly next: ViewMode | null
}

export const viewModeControlState = ({ mode, disabledReason }: ViewModeControlInput): ViewModeControlState => ({
  pressed: mode === '3d',
  disabled: disabledReason !== null,
  title: disabledReason ?? (mode === '3d' ? 'Return to the plan view' : 'Show in 3D'),
  next: disabledReason !== null ? null : mode === '3d' ? '2d' : '3d',
})

export interface ViewModeControl extends IControl {
  update(input: ViewModeControlInput): void
}

let descriptions = 0

/**
 * The map's 3D switch: one text button in a MapLibre control group, as wide
 * as the navigation group it stacks with. A disabled switch stays focusable,
 * so its reason reaches hover, keyboard and assistive technology alike.
 */
export const createViewModeControl = (options: { readonly initial: ViewModeControlInput; readonly onChange: (mode: ViewMode) => void }): ViewModeControl => {
  const container = document.createElement('div')
  container.className = 'maplibregl-ctrl maplibregl-ctrl-group'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'view-mode-control'
  button.textContent = '3D'
  const description = document.createElement('span')
  description.id = `view-mode-control-reason-${++descriptions}`
  description.hidden = true
  container.append(button, description)
  let state = viewModeControlState(options.initial)
  const render = (): void => {
    button.setAttribute('aria-pressed', String(state.pressed))
    button.title = state.title
    if (state.disabled) {
      button.setAttribute('aria-disabled', 'true')
      button.setAttribute('aria-describedby', description.id)
      description.textContent = state.title
    } else {
      button.removeAttribute('aria-disabled')
      button.removeAttribute('aria-describedby')
      description.textContent = ''
    }
  }
  button.addEventListener('click', () => { if (state.next !== null) options.onChange(state.next) })
  render()
  return {
    onAdd: () => container,
    // MapLibre calls this from map.remove() and again from the owner's removeControl.
    onRemove: () => container.remove(),
    update: input => { state = viewModeControlState(input); render() },
  }
}
