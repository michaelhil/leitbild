// What a Run's page shows in its left pane: the simulation, or the Run's plans
// (the "Simulation | Plans" switch in the Run's bar). The plans open on the
// Library for this Run. A switch changes only `planning` in the address, so
// the Run, its focus and surface and the Assistant stay, and the World frame
// keeps its document behind the plans.

export type RunView = 'simulation' | 'plans'

/** The view a Run's page shows while `planning` holds what the address opens in Planning. */
export const runViewOf = (planning: string | null): RunView => planning === null ? 'simulation' : 'plans'

/** The address of the Run's page at `href` showing `view`. */
export const runViewAddress = (href: string, view: RunView): URL => {
  const url = new URL(href)
  if (view === 'plans') url.searchParams.set('planning', 'library')
  else url.searchParams.delete('planning')
  return url
}

/** The Run's More menu item at phone width, where the switch itself does not show: it switches to the other view. */
export const runViewMenuLabel = (shown: RunView): string => shown === 'plans' ? 'Show the simulation' : 'Show plans'

/** At this width and below the Run's bar shows the More menu item instead of the switch (as App.svelte's stylesheet). */
export const RUN_VIEW_SWITCH_NARROW = '(max-width: 760px)'
