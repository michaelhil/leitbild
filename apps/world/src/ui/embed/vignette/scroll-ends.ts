// Which ends of a drawing that scrolls are out of sight (W4.3): sideways where it is wider than its frame, down where
// its rows do not hold it at its text floor. Judged on every scroll and every change of the scroller's or its
// content's size, so a "drawing continues" mark shows where there is more to see, clear of the scrollbars.

export interface ScrollEnds {
  readonly left: boolean
  readonly right: boolean
  readonly top: boolean
  readonly bottom: boolean
  /** The px the scroller's own scrollbars take at its bottom and right (none where they overlay the drawing). */
  readonly bars: { readonly bottom: number; readonly right: number }
}

export const NO_SCROLL_ENDS: ScrollEnds = { left: false, right: false, top: false, bottom: false, bars: { bottom: 0, right: 0 } }

/** A Svelte action on a scroller: `seen` hears which of its ends are out of sight, now and on every change. */
export const scrollEnds = (scroller: HTMLElement, seen: (ends: ScrollEnds) => void) => {
  const sense = (): void => seen({
    left: scroller.scrollLeft > 1,
    right: scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1,
    top: scroller.scrollTop > 1,
    bottom: scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1,
    bars: { bottom: scroller.offsetHeight - scroller.clientHeight, right: scroller.offsetWidth - scroller.clientWidth },
  })
  const resized = new ResizeObserver(sense)
  resized.observe(scroller)
  if (scroller.firstElementChild !== null) resized.observe(scroller.firstElementChild)
  scroller.addEventListener('scroll', sense, { passive: true })
  sense()
  return { destroy: () => { resized.disconnect(); scroller.removeEventListener('scroll', sense) } }
}
