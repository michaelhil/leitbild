// Sidebar resize — drag the handle on the sidebar's right edge to resize.
// Drag below the collapse threshold to fully hide the sidebar (width 0);
// the handle remains at the viewport's left edge as a peek-back grip.
//
// Width is persisted to localStorage. Collapsed state is simply "width === 0".

const MIN_WIDTH = 120     // anything smaller than this snaps to 0 on release
const DEFAULT_WIDTH = 160
const MAX_WIDTH = 400
const STORAGE_KEY = 'leitbild-sidebar-width'

export const initSidebarResize = (): void => {
  const sidebar = document.getElementById('sidebar') as HTMLElement | null
  const handle = document.getElementById('sidebar-resize') as HTMLElement | null
  if (!sidebar || !handle) return

  const savedWidth = localStorage.getItem(STORAGE_KEY)
  const storedWidth = savedWidth === null ? DEFAULT_WIDTH : Number(savedWidth)
  let width = Number.isFinite(storedWidth) && storedWidth >= 0 ? storedWidth : DEFAULT_WIDTH

  const applyWidth = (w: number): void => {
    width = w
    sidebar.style.width = `${w}px`
    // Keep a 1px sliver of sidebar even when collapsed so the border-right
    // remains visible as a "there's something hidden here" hint. The handle
    // itself sits on top of that border.
    handle.style.left = `${w}px`
  }

  applyWidth(width)

  let dragging = false
  let lastWidth = width || DEFAULT_WIDTH

  const onMouseMove = (e: MouseEvent): void => {
    if (!dragging) return
    const raw = Math.max(0, Math.min(MAX_WIDTH, e.clientX))
    // Snap to 0 below MIN_WIDTH so you get a crisp collapse instead of a
    // cramped 40px sidebar.
    const w = raw < MIN_WIDTH ? 0 : raw
    if (w > 0) lastWidth = w
    applyWidth(w)
  }

  const onMouseUp = (): void => {
    if (!dragging) return
    dragging = false
    handle.classList.remove('dragging')
    document.body.classList.remove('sidebar-dragging')
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    localStorage.setItem(STORAGE_KEY, String(width))
  }

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    // Click (no drag) when the sidebar is collapsed: expand to lastWidth.
    if (width === 0) {
      applyWidth(lastWidth || DEFAULT_WIDTH)
      localStorage.setItem(STORAGE_KEY, String(width))
      return
    }
    dragging = true
    handle.classList.add('dragging')
    document.body.classList.add('sidebar-dragging')
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  })
}
