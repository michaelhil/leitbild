// Which ends of a drawing that scrolls sideways are out of sight (W4.3): judged on every scroll and every change of the
// scroller's or its content's size, so a "drawing continues" mark shows where there is more to see.

export interface ScrollEnds { readonly left: boolean; readonly right: boolean }

/** A Svelte action on a scroller: `seen` hears which of its ends are out of sight, now and on every change. */
export const scrollEnds = (scroller: HTMLElement, seen: (ends: ScrollEnds) => void) => {
  const sense = (): void => seen({ left: scroller.scrollLeft > 1, right: scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1 })
  const resized = new ResizeObserver(sense)
  resized.observe(scroller)
  if (scroller.firstElementChild !== null) resized.observe(scroller.firstElementChild)
  scroller.addEventListener('scroll', sense, { passive: true })
  sense()
  return { destroy: () => { resized.disconnect(); scroller.removeEventListener('scroll', sense) } }
}
