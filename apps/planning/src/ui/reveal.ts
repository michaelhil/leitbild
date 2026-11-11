// A panel that opens below or beside the work (the preview, a job's "why") is brought into view and its
// heading takes focus, so the result of a press is never out of sight, at any width.

export interface RevealTarget {
  readonly scrollIntoView: (options?: ScrollIntoViewOptions) => void
  readonly focus: (options?: FocusOptions) => void
}
export interface RevealPanel { readonly querySelector: (selector: string) => RevealTarget | null }

/** Scrolls the panel's heading into view and focuses it (headings carry tabindex="-1"). */
export const revealPanel = (panel: RevealPanel, reduceMotion: boolean): boolean => {
  const heading = panel.querySelector('h2')
  if (heading === null) return false
  heading.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' })
  heading.focus({ preventScroll: true })
  return true
}
