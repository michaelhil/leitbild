// How much of a trip line stands on its one row (plan v5 W2.4, §2 rules 2 and 4: nothing draws over anything, no
// label or age is cut). Its messages give way first, by whole words down to nothing, as the row's flex does; where its
// labels and ages still do not fit, the actuations collapse to their count ("ACTUATED: 2"), then the later leads, last
// first, into "+n"; the first lead always stands. From the natural widths the row measures of each part.

/** Natural widths in px of the parts that never give way, as the row draws them. */
export interface TripWidths {
  /** Each lead with its message empty: its label, its age and the gaps between. */
  readonly leads: ReadonlyArray<number>
  /** The actuations: listed, and counted ("ACTUATED: 2"); null where none hold. */
  readonly actuated: { readonly listed: number; readonly counted: number } | null
  /** "+n" at the most leads it can stand for. */
  readonly more: number
  /** A separator with the gap either side of it. */
  readonly sep: number
}

/** How many leads stand (the rest counted in "+n"), and whether the actuations stand counted. */
export interface TripFit {
  readonly leads: number
  readonly counted: boolean
}

/** The row's width at a fit. */
export const tripWidth = (widths: TripWidths, fit: TripFit): number => {
  const parts = [
    ...widths.leads.slice(0, fit.leads),
    ...(fit.leads < widths.leads.length ? [widths.more] : []),
    ...(widths.actuated === null ? [] : [fit.counted ? widths.actuated.counted : widths.actuated.listed]),
  ]
  return parts.reduce((sum, width) => sum + width, 0) + Math.max(0, parts.length - 1) * widths.sep
}

/** The most that stands in `room`: everything; else the actuations counted; else fewer leads, never fewer than one. */
export const tripFit = (widths: TripWidths, room: number): TripFit => {
  const all = widths.leads.length
  const tries: ReadonlyArray<TripFit> = [
    { leads: all, counted: false },
    ...(widths.actuated === null ? [] : [{ leads: all, counted: true }]),
    ...Array.from({ length: Math.max(0, all - 1) }, (_, fewer) => ({ leads: all - 1 - fewer, counted: widths.actuated !== null })),
  ]
  return tries.find(fit => tripWidth(widths, fit) <= room) ?? tries.at(-1)!
}
