// The LD-01 unit's I&C frame grid as the World engine names it (R4-GRID's frame rule). The unit's I&C frame owns the
// grid (operating src/ic/mod.rs `Frame`; its period reaches the World as LOAD's `frame_s`): frame k's instant is the f64
// product k · period, and the Grid's exchange grid is the frames m · every. The engine forms the same product, so an
// ADVANCE to frame k and a boundary's `until` carry the unit's own bits.
//
// The engine names frames by index only. The time the unit reports at frame k may be another name of that instant
// (water-ffi src/frame.rs, "One instant": an owner event's or a due change's own time, within stock's resolution of
// the product), so a reported time is never read back as a frame. The Run's time is counted in whole milliseconds and
// turned into frames by integer division: decimal seconds summed in f64 drift below the products and reach the frame
// before.

/** Where the Run's time stands on the grid: the last frame it reaches and the whole milliseconds short of the next. */
export interface Ld01FramePosition {
  readonly frame: number
  readonly remainderMs: number
}

export interface Ld01FrameGrid {
  readonly periodS: number
  readonly periodMs: number
  /** Frame k's instant: the unit's product. */
  readonly instant: (k: number) => number
  /** The frame whose instant `t` is exactly (a start time the unit loads); any other time is refused, naming `what`. */
  readonly frameOf: (t: number, what: string) => number
  /** The exchange grid's first frame after frame k: the next whole multiple of `every` frames. */
  readonly nextExchange: (k: number, every: number) => number
  /** The Run's position `ms` whole milliseconds on. */
  readonly reach: (position: Ld01FramePosition, ms: number) => Ld01FramePosition
  /** Whether a time the unit reports for frame k lies within that frame: strictly between its neighbours' instants. */
  readonly within: (k: number, t: number) => boolean
}

export const ld01FrameGrid = (periodS: number): Ld01FrameGrid => {
  const periodMs = Math.round(periodS * 1_000)
  if (!(Number.isFinite(periodS) && periodMs >= 1 && periodMs / 1_000 === periodS)) {
    throw new Error(`the unit's I&C frame of ${periodS} s is not a whole number of milliseconds`)
  }
  const instant = (k: number): number => k * periodS
  return {
    periodS,
    periodMs,
    instant,
    frameOf: (t, what) => {
      const k = Math.round(t / periodS)
      if (!(Number.isFinite(t) && k >= 0 && instant(k) === t)) throw new Error(`${what} at ${t} s, which is no I&C frame's instant k · ${periodS} s`)
      return k
    },
    nextExchange: (k, every) => (Math.floor(k / every) + 1) * every,
    reach: (position, ms) => {
      if (!(Number.isSafeInteger(ms) && ms >= 0)) throw new Error(`the Run's time moves by whole milliseconds, not ${ms}`)
      const total = position.remainderMs + ms
      return { frame: position.frame + Math.floor(total / periodMs), remainderMs: total % periodMs }
    },
    within: (k, t) => instant(k - 1) < t && t < instant(k + 1),
  }
}
