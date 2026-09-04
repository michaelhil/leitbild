import { z } from 'zod'

export type IsoTimestamp = string & { readonly __brand: 'IsoTimestamp' }

export const isoTimestampSchema = z.string().datetime().transform(value => value as IsoTimestamp)

export const nowIso = (): IsoTimestamp => new Date().toISOString() as IsoTimestamp

export interface SimulationClockState {
  /** Simulation epoch; advances only while this Run is loaded and unpaused. */
  readonly currentTime: IsoTimestamp
  /** Wall-clock observation time of this clock reading, never a solver time. */
  readonly updatedAt: IsoTimestamp
  readonly paused: boolean
}

export interface SimulationClockUpdate {
  readonly paused?: boolean
}

export const simulationClockStateSchema = z.object({
  currentTime: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  paused: z.boolean(),
})

export const simulationClockUpdateSchema = z.object({
  paused: z.boolean().optional(),
}).strict()

/** One clock calculation for UI interpolation and incoming wire readings. */
export const simulationTimeAt = (clock: SimulationClockState, wallTimeMs = Date.now()): IsoTimestamp =>
  new Date(Date.parse(clock.currentTime) + (clock.paused ? 0 : Math.max(0, wallTimeMs - Date.parse(clock.updatedAt)))).toISOString() as IsoTimestamp

/** A local projection of the Run clock. Monotonic duration, not calendar-clock
 * deltas, drives elapsed simulation time between explicit clock updates. Never
 * persist the monotonic anchor; restore reanchors a saved reading at wall now. */
export const createSimulationClock = (initial: SimulationClockState, source = {
  wallMs: () => Date.now(), monotonicMs: () => performance.now(),
}) => {
  let reading = simulationClockStateSchema.parse(initial) as SimulationClockState
  let anchorMs = source.monotonicMs()
  const read = (): SimulationClockState => ({
    ...reading,
    currentTime: new Date(Date.parse(reading.currentTime) + (reading.paused ? 0 : Math.max(0, source.monotonicMs() - anchorMs))).toISOString() as IsoTimestamp,
    updatedAt: new Date(source.wallMs()).toISOString() as IsoTimestamp,
  })
  return {
    read,
    set: (next: SimulationClockState): void => {
      reading = simulationClockStateSchema.parse(next) as SimulationClockState
      // This is an explicit synchronization boundary, not a network estimate.
      // Never interpret wall-clock changes (including NTP corrections) as work.
      anchorMs = source.monotonicMs()
    },
  }
}

export type SimulationClock = ReturnType<typeof createSimulationClock>
export type SimulationClockReader = Pick<SimulationClock, 'read'>
