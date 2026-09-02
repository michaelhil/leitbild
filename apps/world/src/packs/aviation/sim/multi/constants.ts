// The aviation multi-runtime id and its single accepted command kind.
// Lives in its own file so the UI can import the string without pulling the
// adapter (and its Node-only fetch graph) into the browser bundle.

export const aviationMultiRuntimeId = 'aviation.multi'
export const aviationMultiAdapterId = aviationMultiRuntimeId

/** Switches the live aircraft source for a Simulation Run. Accepted only by
 *  the aviation.multi adapter. Payload: `{ source: 'opensky' | 'vatsim' }`. */
export const aviationSetSourceCommandKind = 'world.aviation.set-source'

export const aviationSources = ['opensky', 'vatsim'] as const
export type AviationSourceId = typeof aviationSources[number]
