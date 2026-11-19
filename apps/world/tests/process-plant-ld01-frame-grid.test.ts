import { describe, expect, test } from 'bun:test'
import { ld01FrameGrid, type Ld01FramePosition } from '../src/packs/process-plant/engine/frame-grid.ts'

// R4-GRID's frame rule over 10^7 frames (11.6 days at 0.1 s): the World engine's frame grid (engine/frame-grid.ts)
// against ld01-unit's own rules, transcribed operation for operation in f64 from operating src/ic/mod.rs `Frame`,
// water-ffi src/frame.rs `same_instant` and the driver's start, and water-ffi src/bin/ld01-unit.rs `exchange_after`
// and `on_exchange`. The unit may answer frame k at any name of its instant (frame.rs, "One instant"); every name
// below is tried: the product k · 0.1, the decimal k / 10, an owner's sum from the previous frame or from the last
// exchange, and the farthest doubles on either side still within the instant.

const frames = 10_000_000
const period = 0.1
const every = 10
const grid = ld01FrameGrid(period)

// ld01-unit, transcribed.
const sameInstant = (a: number, b: number): boolean => Math.abs(a - b) <= 100 * Number.EPSILON * (Math.abs(a) + Math.abs(b))
const unitInstant = (k: number): number => k * period
const atOrAfter = (t: number): number => {
  let k = Math.ceil(t / period)
  if (unitInstant(k) < t) k += 1
  if (k > 0 && unitInstant(k - 1) >= t) k -= 1
  return k
}
/** The driver's first unobserved frame after a start at `t0`: `Driver::new` (at_or_after), then `start` (one instant). */
const firstAfterStart = (t0: number): number => {
  const k = atOrAfter(t0)
  return sameInstant(unitInstant(k), t0) ? k + 1 : k
}
const exchangeAfter = (t: number): number => {
  let m = Math.floor(t / (every * period))
  for (;;) {
    const instant = unitInstant(m * every)
    if (instant > t && !sameInstant(instant, t)) return instant
    m += 1
  }
}
// f64::round is half away from zero: Math.round for t >= 0.
const onExchange = (t: number): boolean => sameInstant(unitInstant(Math.round(t / (every * period)) * every), t)

// The neighbouring doubles of a positive double, through its two 32-bit words (little-endian).
const cell = new Float64Array(1)
const words = new Uint32Array(cell.buffer)
const [low, high] = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1 ? [0, 1] : [1, 0]
const up = (x: number): number => {
  cell[0] = x
  if (words[low] === 0xffff_ffff) { words[low] = 0; words[high] = words[high]! + 1 } else words[low] = words[low]! + 1
  return cell[0]
}
const down = (x: number): number => {
  cell[0] = x
  if (words[low] === 0) { words[low] = 0xffff_ffff; words[high] = words[high]! - 1 } else words[low] = words[low]! - 1
  return cell[0]
}
/** The farthest double below (or above) the product that is still the same instant. */
const farthest = (p: number, below: boolean): number => {
  if (p === 0) return 0
  let t = below ? p * (1 - 100 * Number.EPSILON) / (1 + 100 * Number.EPSILON) : p * (1 + 100 * Number.EPSILON) / (1 - 100 * Number.EPSILON)
  const outward = below ? down : up
  const inward = below ? up : down
  while (!sameInstant(t, p)) t = inward(t)
  while (sameInstant(outward(t), p)) t = outward(t)
  return t
}

describe('the LD-01 frame grid (R4-GRID frame rule)', () => {
  test('over 10^7 frames, every name the unit may answer a frame at is that frame to the World engine and to the unit', () => {
    const disagreements = new Map<string, number[]>()
    const note = (check: string, k: number): void => {
      const ks = disagreements.get(check) ?? []
      if (ks.length < 5) ks.push(k)
      disagreements.set(check, ks)
    }
    const names = new Float64Array(6)
    let belowProduct = 0
    for (let k = 0; k <= frames; k += 1) {
      const p = grid.instant(k)
      if (p !== unitInstant(k)) note('instant: engine and unit products', k)
      if (grid.frameOf(p, 'the start') !== k || firstAfterStart(p) !== k + 1) note('start: a frame instant and the unit\'s first frame after it', k)
      const exchange = grid.instant(grid.nextExchange(k, every))
      const onGrid = k % every === 0
      const last = Math.floor(k / every) * every
      names[0] = p
      names[1] = k / 10
      names[2] = k === 0 ? 0 : unitInstant(k - 1) + period
      names[3] = unitInstant(last) + (k - last) * period
      names[4] = farthest(p, true)
      names[5] = farthest(p, false)
      for (let name = 0; name < names.length; name += 1) {
        const t = names[name]!
        if (t < p) belowProduct += 1
        if (!sameInstant(t, p)) note(`name ${name} is not the frame's instant`, k)
        // The engine: the unit answering frame k at t stands at frame k (its protocol bracket).
        if (!grid.within(k, t)) note(`within: name ${name}`, k)
        // The unit at t: its next exchange is the engine's, bit for bit (an ADVANCE's end, a boundary's until).
        if (exchangeAfter(t) !== exchange) note(`next exchange: name ${name}`, k)
        if (onExchange(t) !== onGrid) note(`exchange instant: name ${name}`, k)
      }
    }
    expect(Object.fromEntries(disagreements)).toEqual({})
    // Names below the product were tried: an engine reading the unit's time back as a frame takes them for the frame before.
    expect(belowProduct).toBeGreaterThan(frames)
  }, 300_000)

  test('a start time between frames or beside a product is refused, not rounded', () => {
    for (let k = 1; k <= frames; k += 9_973) {
      const p = grid.instant(k)
      for (const t of [down(p), up(p), farthest(p, true), farthest(p, false), p + period / 2]) {
        expect(() => grid.frameOf(t, 'the start')).toThrow('which is no I&C frame\'s instant')
      }
    }
    expect(() => ld01FrameGrid(0.1 + Number.EPSILON)).toThrow('not a whole number of milliseconds')
  })

  test('the Run\'s whole milliseconds reach frame start + n after n frames\' worth, however they are sliced, over 10^7 frames', () => {
    for (const start of [0, 36_551]) {
      let tick: Ld01FramePosition = { frame: start, remainderMs: 0 }
      let sliced: Ld01FramePosition = { frame: start, remainderMs: 0 }
      let wrong = 0
      for (let n = 1; n <= frames; n += 1) {
        tick = grid.reach(tick, 100)
        sliced = grid.reach(grid.reach(sliced, 30), 70)
        if (tick.frame !== start + n || tick.remainderMs !== 0 || sliced.frame !== tick.frame || sliced.remainderMs !== 0) wrong += 1
      }
      expect(wrong).toBe(0)
      expect(grid.reach({ frame: start, remainderMs: 0 }, frames * 100)).toEqual({ frame: start + frames, remainderMs: 0 })
    }
    expect(() => grid.reach({ frame: 0, remainderMs: 0 }, 0.5)).toThrow('whole milliseconds')
  }, 300_000)
})
