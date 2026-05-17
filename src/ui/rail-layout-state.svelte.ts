import {
  defaultRailWidth,
  minRailWidth,
  railWidthFromPointer,
  readStoredRailWidth,
  storeRailWidth,
} from './rail-state.ts'

export interface RailLayoutState {
  readonly width: number
  readonly collapsed: boolean
  readonly layoutRevision: number
  readonly initialize: () => void
  readonly startResize: (event: PointerEvent) => void
  readonly stopResize: () => void
}

export const createRailLayoutState = (): RailLayoutState => {
  let width = $state(defaultRailWidth)
  let lastOpenWidth = $state(defaultRailWidth)
  let resizing = $state(false)
  let widthBeforeResize = $state(defaultRailWidth)
  let layoutRevision = $state(0)

  const setWidth = (nextWidth: number, persist = false): void => {
    width = nextWidth
    if (nextWidth >= minRailWidth) lastOpenWidth = nextWidth
    layoutRevision += 1
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

  return {
    get width() {
      return width
    },
    get collapsed() {
      return width === 0
    },
    get layoutRevision() {
      return layoutRevision
    },
    initialize,
    startResize,
    stopResize,
  }
}
