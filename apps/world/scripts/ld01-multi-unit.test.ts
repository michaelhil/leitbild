import { describe, expect, test } from 'bun:test'
import { createRodLine } from './ld01-multi-unit.ts'

// Soak rule r2's rod line with amendment A2, on synthetic frames: e = Tavg − Tref (K), the bank's travel (m, larger is withdrawn).
// The numbers are the test's own, not the wiki block's: the driver reads those from the unit's ld01-rod-control block.
const law = { deadBandK: 0.8, maximumSpeedErrorK: 1.6 }
const run = (frames: ReadonlyArray<readonly [number, number]>) => {
  const line = createRodLine(law)
  frames.forEach(([e, bank], k) => line.note(k, e, bank))
  return { summary: line.summary(frames.length), interval: line.takeInterval() }
}

describe('the soak rod line (r2 amendment A2)', () => {
  test('inside the band every frame passes; the bank must still move once', () => {
    const still = run([[0.1, 3], [-0.5, 3], [0.79, 3], [-0.8, 3]]).summary
    expect([still.frames_outside_band, still.frames_outside_band_not_correcting, still.bank_moved, still.holds]).toEqual([0, 0, false, false])
    const moved = run([[0.1, 3], [-0.5, 3.001], [0.3, 3.001]]).summary
    expect([moved.frames_outside_band, moved.bank_moved, moved.holds]).toEqual([0, true, true])
    expect(moved.first_bank_move).toEqual({ k: 1, direction: 'withdraw', fromM: 3, toM: 3.001 })
  })

  test('outside the band and correcting passes: the frame is judged on the travel its decision puts in force, one frame later', () => {
    // Tavg below Tref (e < 0): the bank withdraws; above (e > 0): it inserts.
    const result = run([[-0.7, 3], [-0.85, 3], [-0.84, 3.002], [-0.82, 3.004], [0.9, 3.006], [0.7, 3.001], [0.1, 3.001]])
    expect([result.summary.frames_outside_band, result.summary.frames_outside_band_not_correcting, result.summary.holds]).toEqual([4, 0, true])
    expect(result.summary.worst_abs_e_k).toBe(0.9)
    expect(result.interval).toEqual({ outsideBand: 4, notCorrecting: 0 })
  })

  test('outside the band and not correcting fails: the bank still, or moving the wrong way', () => {
    const still = run([[0.1, 3.1], [-0.9, 3], [-0.9, 3], [0.2, 3.001]]).summary
    expect([still.frames_outside_band, still.frames_outside_band_not_correcting, still.holds]).toEqual([2, 1, false])
    const wrongWay = run([[-0.9, 3], [-0.5, 2.999], [0.1, 2.999]]).summary
    expect([wrongWay.frames_outside_band_not_correcting, wrongWay.holds]).toEqual([1, false])
    // A last frame outside the band has no next frame to show its correction: not judged, so the line does not hold.
    const last = run([[0.1, 3], [0.2, 3.001], [0.9, 3.001]]).summary
    expect([last.final_frame_outside_band_unjudged, last.holds]).toEqual([true, false])
  })

  test('at or past maximumSpeedError_K fails, however the bank moves', () => {
    const at = run([[0.1, 3], [-1.6, 3.001], [-1.5, 3.01], [-0.5, 3.02]]).summary
    expect([at.frames_at_or_over_maximum_speed_error, at.frames_outside_band_not_correcting, at.holds]).toEqual([1, 0, false])
    const past = run([[0.1, 3], [1.7, 3], [1.2, 2.99], [0.1, 2.98]]).summary
    expect([past.frames_at_or_over_maximum_speed_error, past.holds]).toEqual([1, false])
  })
})
