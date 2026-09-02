import type { IsoTimestamp, SimulationClockState } from '../core/model/index.ts'
import { simulationTimeAt as interpolate } from '../core/model/time.ts'

export const simulationTimeAt = (
  clock: SimulationClockState | undefined,
  wallTimeMs: number = Date.now(),
): IsoTimestamp | undefined => {
  if (!clock) return undefined
  return interpolate(clock, wallTimeMs)
}
