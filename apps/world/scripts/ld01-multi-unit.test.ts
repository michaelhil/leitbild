import { describe, expect, test } from 'bun:test'
import { createRodLine, createValveLine, rodDecisionLagFrames } from './ld01-multi-unit.ts'

// Soak rule r2's rod and valve lines with amendment A7, on synthetic frames: e = the rod law's own error (K), the bank's travel
// (m, larger is withdrawn), the governor's opening (a fraction, 1 fully open). The numbers are the test's own, not the wiki block's:
// the driver reads those from the unit's ld01-rod-control block.
const law = { deadBandK: 0.8, maximumSpeedErrorK: 1.6 }
const run = (frames: ReadonlyArray<readonly [number, number] | readonly [number, number, boolean]>, lag = rodDecisionLagFrames) => {
  const line = createRodLine(law, lag)
  frames.forEach(([e, bank, auto], k) => line.note(k, e, bank, auto ?? true))
  return { summary: line.summary(frames.length), interval: line.takeInterval() }
}

describe('the soak rod line (r2 amendment A7)', () => {
  test('a frame\'s decision moves the bank one frame later (R4-ROD-DELAY)', () => {
    expect(rodDecisionLagFrames).toBe(1)
  })

  test('inside the band every frame passes; the bank must still move once', () => {
    const still = run([[0.1, 3], [-0.5, 3], [0.79, 3], [-0.8, 3]]).summary
    expect([still.frames_outside_band, still.frames_outside_band_not_correcting, still.bank_moved, still.holds]).toEqual([0, 0, false, false])
    const moved = run([[0.1, 3], [-0.5, 3.001], [0.3, 3.001], [0.2, 3.001]]).summary
    expect([moved.frames_outside_band, moved.bank_moved, moved.holds]).toEqual([0, true, true])
    expect(moved.first_bank_move).toEqual({ k: 1, direction: 'withdraw', fromM: 3, toM: 3.001 })
  })

  test('alignment: the travel over the decision\'s in-force interval passes; read one frame early, the same series fails', () => {
    // e < 0 (too cold) from frame 1: each frame's decision withdraws the bank over the next frame but one (k + 1 -> k + 2).
    const frames = [[-0.7, 3], [-0.85, 3], [-0.84, 3], [-0.82, 3.002], [-0.7, 3.004], [-0.6, 3.006], [-0.5, 3.006], [-0.4, 3.006]] as const
    const aligned = run(frames).summary
    expect([aligned.frames_outside_band, aligned.frames_outside_band_not_correcting, aligned.holds]).toEqual([3, 0, true])
    const early = run(frames, 0).summary
    expect([early.frames_outside_band, early.frames_outside_band_not_correcting, early.holds]).toEqual([3, 1, false])
  })

  test('mismatch: the law\'s own error inside the band passes, where Tavg - Tref alone would read outside it', () => {
    // The law's error carries the mismatch term: 0.79 K while Tavg - Tref is 0.81 K, and the law, inside its band, leaves the bank still.
    const lawError = run([[0.5, 3], [0.79, 3], [0.79, 3], [0.6, 3], [0.5, 3], [0.4, 3.001]]).summary
    expect([lawError.frames_outside_band, lawError.frames_outside_band_not_correcting, lawError.holds]).toEqual([0, 0, true])
    const temperatureOnly = run([[0.5, 3], [0.81, 3], [0.81, 3], [0.6, 3], [0.5, 3], [0.4, 3.001]]).summary
    expect([temperatureOnly.frames_outside_band_not_correcting, temperatureOnly.holds]).toEqual([2, false])
  })

  test('outside the band and not correcting fails: the bank still, or moving the wrong way', () => {
    const still = run([[0.1, 3.1], [-0.9, 3.1], [-0.9, 3.1], [0.2, 3.101], [0.1, 3.101]]).summary
    expect([still.frames_outside_band, still.frames_outside_band_not_correcting, still.holds]).toEqual([2, 1, false])
    const wrongWay = run([[-0.9, 3], [-0.5, 3], [0.1, 2.999], [0.1, 2.999]]).summary
    expect([wrongWay.frames_outside_band_not_correcting, wrongWay.holds]).toEqual([1, false])
    // The last frames outside the band have no in-force interval yet: not judged, so the line does not hold.
    const last = run([[0.1, 3], [0.2, 3.001], [0.3, 3.001], [0.9, 3.001]]).summary
    expect([last.final_frames_outside_band_unjudged, last.holds]).toEqual([1, false])
  })

  test('at or past maximumSpeedError_K fails, however the bank moves', () => {
    const at = run([[0.1, 3], [-1.6, 3], [-1.5, 3.001], [-0.5, 3.01], [-0.4, 3.02]]).summary
    expect([at.frames_at_or_over_maximum_speed_error, at.frames_outside_band_not_correcting, at.holds]).toEqual([1, 0, false])
  })

  test('frames under HOLD are counted, not judged', () => {
    const held = run([[0.1, 3], [-0.9, 3, false], [-0.9, 3, false], [0.1, 3.001], [0.1, 3.001]]).summary
    expect([held.frames_not_auto, held.frames_outside_band, held.frames_outside_band_not_correcting, held.holds]).toEqual([2, 0, 0, true])
  })
})

describe('the soak valve line (r2 amendment A7)', () => {
  const valve = (openings: ReadonlyArray<number>) => {
    const line = createValveLine()
    openings.forEach((opening, k) => line.note(k, opening, Math.round(opening * 100)))
    return line.summary(openings.length)
  }

  test('an opening of 0.9999 is below the stop and passes, reported with its 1 % indication of 100', () => {
    const below = valve([0.98, 0.9937, 0.9999, 0.995])
    expect([below.frames_at_or_over_stop, below.worst_opening, below.worst_opening_at_k, below.worst_adm_pos, below.holds]).toEqual([0, 0.9999, 2, 100, true])
  })

  test('an opening of 1 is at the full-open stop and fails', () => {
    const at = valve([0.99, 1, 0.999])
    expect([at.frames_at_or_over_stop, at.worst_opening, at.holds]).toEqual([1, 1, false])
  })
})
