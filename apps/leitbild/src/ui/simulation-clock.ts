import type { IsoTimestamp, SimulationClockState } from '../core/model/index.ts'

export const simulationTimeAt = (
  clock: SimulationClockState | undefined,
  wallTimeMs: number = Date.now(),
): IsoTimestamp | undefined => {
  if (!clock) return undefined
  const currentTimeMs = Date.parse(clock.currentTime)
  if (!Number.isFinite(currentTimeMs)) return undefined
  if (clock.paused) return clock.currentTime
  const updatedAtMs = Date.parse(clock.updatedAt)
  if (!Number.isFinite(updatedAtMs)) return clock.currentTime
  return new Date(currentTimeMs + Math.max(0, wallTimeMs - updatedAtMs) * clock.speed).toISOString() as IsoTimestamp
}
