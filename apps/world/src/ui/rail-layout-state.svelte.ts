import {
  defaultRailWidth,
  minRailWidth,
  railWidthFromPointer,
  readStoredRailWidth,
  storeRailWidth,
  railPresentation,
} from './rail-state.ts'

export interface RailLayoutState {
  readonly width: number
  readonly collapsed: boolean
  readonly drawer: boolean
  readonly panelWidth: number
  readonly setPaneWidth: (width: number) => void
  readonly toggleDrawer: () => void
  readonly initialize: () => void
  /** Collapses the rail for this page without storing it; the operator's stored width returns on the next expand. */
  readonly collapse: () => void
  readonly startResize: (event: PointerEvent) => void
  readonly stopResize: () => void
}

export const createRailLayoutState = (): RailLayoutState => {
  let width = $state(defaultRailWidth)
  let lastOpenWidth = $state(defaultRailWidth)
  let resizing = $state(false)
  let widthBeforeResize = $state(defaultRailWidth)
  let paneWidth = $state(typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth)
  let drawerOpen = $state(false)
  const presentation = $derived(railPresentation(width, paneWidth, lastOpenWidth))

  const setWidth = (nextWidth: number, persist = false): void => {
    width = nextWidth
    if (nextWidth >= minRailWidth) lastOpenWidth = nextWidth
    if (persist) storeRailWidth(nextWidth)
  }

  const handlePointerMove = (event: PointerEvent): void => {
    if (!resizing) return
    setWidth(railWidthFromPointer(event.clientX))
  }

  const stopResize = (): void => {
    if (!resizing) return
    resizing = false
    document.body.classList.remove('rail-resizing')
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', stopResize)
    lastOpenWidth = width === 0 ? widthBeforeResize : width
    storeRailWidth(width)
  }

  const startResize = (event: PointerEvent): void => {
    event.preventDefault()
    if (width === 0) {
      setWidth(lastOpenWidth || defaultRailWidth, true)
      return
    }
    widthBeforeResize = width
    resizing = true
    document.body.classList.add('rail-resizing')
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
  }

  const initialize = (): void => {
    width = readStoredRailWidth()
    if (width > 0) lastOpenWidth = width
  }

  const collapse = (): void => {
    if (presentation.drawer) { drawerOpen = false; return }
    if (width > 0) lastOpenWidth = width
    width = 0
  }

  return {
    get width() {
      return presentation.width
    },
    get collapsed() {
      return presentation.drawer ? !drawerOpen : width === 0
    },
    get drawer() { return presentation.drawer },
    get panelWidth() { return presentation.panelWidth },
    setPaneWidth: next => { if (Number.isFinite(next) && next >= 0) paneWidth = next },
    toggleDrawer: () => { drawerOpen = !drawerOpen },
    initialize,
    collapse,
    startResize,
    stopResize,
  }
}
