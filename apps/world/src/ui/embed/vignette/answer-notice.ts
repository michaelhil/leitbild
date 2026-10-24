// What an answer's vignette says of itself (plan v5 W8.2, regression #15):
// why the Assistant composed it, when, and whether what it shows has moved on
// from the answer: the Run was reset after it (its clock went back behind the
// answer's time, or between two samples while open), or a model it reads
// changed after it. Nothing is stored per Run: the state keeps the answer's
// time and models, the samples bring the Run's time.

type Stamp = { readonly at: string; readonly clock: 'simulation' | 'wall' }

/**
 * Whether a sample says the Run was reset after the answer: on the answer's clock, the Run stands before the answer's
 * own time, or before the sample read just ahead of it. A paused Run, or one read again at the same time, is not.
 */
export const resetSeen = (composed: Stamp, previous: Stamp | undefined, sample: Stamp): boolean =>
  sample.clock === composed.clock && (Date.parse(sample.at) < Date.parse(composed.at) || (previous?.clock === sample.clock && Date.parse(sample.at) < Date.parse(previous.at)))

/** The notices an answer's vignette leads its line with, the most consequential first. */
export const answerNotices = (state: { readonly reset: boolean; readonly modelChanged: boolean }): ReadonlyArray<string> => [
  ...(state.reset ? ['Run reset after this answer'] : []),
  ...(state.modelChanged ? ['Model changed after this answer'] : []),
]
