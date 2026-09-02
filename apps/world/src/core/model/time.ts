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
  readonly speed: number
}

export interface SimulationClockUpdate {
  readonly paused?: boolean
  readonly speed?: number
}

export const simulationClockStateSchema = z.object({
  currentTime: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  paused: z.boolean(),
  speed: z.number().finite().positive(),
})

export const simulationClockUpdateSchema = z.object({
  paused: z.boolean().optional(),
  speed: z.number().finite().positive().optional(),
}).strict()

/** One clock calculation for UI interpolation and incoming wire readings. */
export const simulationTimeAt = (clock: SimulationClockState, wallTimeMs = Date.now()): IsoTimestamp =>
  new Date(Date.parse(clock.currentTime) + (clock.paused ? 0 : Math.max(0, wallTimeMs - Date.parse(clock.updatedAt)) * clock.speed)).toISOString() as IsoTimestamp

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
    currentTime: new Date(Date.parse(reading.currentTime) + (reading.paused ? 0 : Math.max(0, source.monotonicMs() - anchorMs) * reading.speed)).toISOString() as IsoTimestamp,
    updatedAt: new Date(source.wallMs()).toISOString() as IsoTimestamp,
  })
  return {
    read,
    set: (next: SimulationClockState): void => {
      reading = simulationClockStateSchema.parse(next) as SimulationClockState
      // Account for transport/queue delay once, then use only monotonic time.
      reading = { ...reading, currentTime: simulationTimeAt(reading, source.wallMs()) }
      anchorMs = source.monotonicMs()
    },
  }
}
