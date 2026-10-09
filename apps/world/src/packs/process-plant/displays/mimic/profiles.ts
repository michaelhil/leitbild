import type { DiagramProfile } from './layout/index.ts'
import { openBridgeDevice } from './text-metrics.ts'

// How a kind of display draws its mimics: the HMI rules every drawing it
// shows keeps, apart from the room a particular display leaves. Profiles are
// data beside each other, so a new kind of display is a new profile, not a
// new drawing path.

export type MimicProfile = Omit<DiagramProfile, 'maxWidth' | 'maxHeight'> & {
  /** Names the profile in refusals and in the drawing's identity. */
  readonly id: string
}

/** OpenBridge's drawing conventions: its 24 px grid, pipe outline and alarm frame. */
const openBridgeDrawing = {
  grid: 24,
  cell: 24,
  pipe: { outline: 6, cornerRadius: 8, crossingHalfGap: 5 },
  textClearance: 9,
  frameMargin: 1,
  flapHeight: openBridgeDevice.flapHeight,
  flapLabelPadding: openBridgeDevice.flapLabelInset,
} as const

/**
 * A mimic beside an answer in chat: about three symbols per loop and eight
 * shared, what an operator takes in at a glance, and enough for one service
 * to all four loops or a diesel to its pump.
 */
export const chatMimicProfile: MimicProfile = {
  id: 'chat',
  ...openBridgeDrawing,
  limits: { symbols: 20, symbolsPerLane: 3, sharedSymbols: 8, lanes: 4, crossings: 6, bendsPerEdge: 3 },
}
