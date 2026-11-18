// A panel that opens below or beside the work (the preview, a job's "why") is brought into view and its
// heading takes focus, so the result of a press is never out of sight, at any width.

export interface RevealTarget {
  readonly scrollIntoView: (options?: ScrollIntoViewOptions) => void
  readonly focus: (options?: FocusOptions) => void
}
export interface RevealPanel { readonly querySelector: (selector: string) => RevealTarget | null }

/** Scrolls the panel's heading into view and focuses it (headings carry tabindex="-1"). */
export const revealPanel = (panel: RevealPanel, reduceMotion: boolean, block: 'start' | 'nearest' = 'start'): boolean => {
  const heading = panel.querySelector('h2')
  if (heading === null) return false
  // Focus first, then scroll: a focus during a smooth scroll can stop it short of the panel.
  heading.focus({ preventScroll: true })
  // 'nearest' is for a panel beside the work (the detail column): one already in view does not move the page.
  heading.scrollIntoView({ block, behavior: reduceMotion ? 'auto' : 'smooth' })
  return true
}
