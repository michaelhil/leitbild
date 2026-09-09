import { describe, expect, test } from 'bun:test'
import { reportedFlow, replay, transfer, type Capture, type Interval, type Meter } from './reference-design-cooling-observations'

const meters: Meter[] = [
  { name: 'GIV', referenceFlow_kg_s: 60, meterDrop_Pa: 5000, span_Pa: 20000 },
  { name: 'RECIRC', referenceFlow_kg_s: 60, meterDrop_Pa: 2000, span_Pa: 8000 },
  { name: 'DVI', referenceFlow_kg_s: 100, meterDrop_Pa: 1000, span_Pa: 9000 },
]
const basis = { sample_s: .1, flowLag_s: .25, rawDPZeroBound_Pa: 5, rawDPQuantum_Pa: .5 }
const pools = { WSTFloor_m: 8, WSTArea_m2: 200, sumpFloor_m: -2, sumpArea_m2: 200 }
// Explicit test-only constant-flow water fixture; not a physical source solve.
function fixture(duration: number, start = 0): Capture {
  const q = 10, rho = 1000, hc = 100000, rows: Interval[] = []
  if (start) rows.push([0, start, [0, 0], [0, 0], [], 1, 1e6, 1e6, 0])
  rows.push([start, duration - start, [q, q], [0, 0], [], 1, 1e6, 1e6, 0])
  const moved = transfer(rows.at(-1)!, start, duration, rho, hc, pools)
  const mass = q * (duration - start)
  return { intervals: rows, result: { name: 'test', step_s: .25, end_s: duration, gravity_onset_s: start,
    WST_delivered_kg: [mass, mass], sump_delivered_kg: [0, 0],
    pool_gravity_transfer_MJ: (moved.energy[0]! + moved.energy[1]! - 2 * mass * hc) / 1e6 } }
}

describe('offline cooling-source observation', () => {
  test('signed calibration, zero ambiguity and saturated bounds', () => {
    expect(reportedFlow(-5000, meters[0]!, 5.25).condition).toBe('reverse_established')
    expect(reportedFlow(0, meters[1]!, 5.25).condition).toBe('indeterminate')
    expect(reportedFlow(21000, meters[0]!, 5.25).upperLiquidCalibration_kg_s).toBeNull()
    expect(reportedFlow(-21000, meters[0]!, 5.25).lowerLiquidCalibration_kg_s).toBeNull()
    expect(() => reportedFlow(NaN, meters[0]!, 5.25)).toThrow()
  })
  test('split overlap preserves actual mass and falling-pool energy', () => {
    const row = fixture(1).intervals[0]!
    const full = transfer(row, 0, 1, 1000, 100000, pools)
    const a = transfer(row, 0, .37, 1000, 100000, pools), b = transfer(row, .37, 1, 1000, 100000, pools)
    expect(a.energy[0]! + b.energy[0]!).toBeCloseTo(full.energy[0]!, 7)
    expect(a.mass[0]! + b.mass[0]!).toBe(full.mass[0]!)
    expect(() => transfer(row, -.1, 1, 1000, 100000, pools)).toThrow()
  })
  test('initial acquisition, positive qualification and truth coverage are distinct', () => {
    const r = replay(fixture(4), meters, basis, 'none', 1000, 100000, pools)
    expect(r.firstPositiveCandidate_s[0]).toBe(.1)
    expect(r.firstPositiveQualified_s[0]).toBe(2.1)
    expect(r.qualityCounts[0]!.UNAVAILABLE).toBe(1)
    expect(r.staticIntervalCoverageDiagnostic[0]!.outsideStaticInterval).toBeGreaterThan(0)
    expect(r.actualMassDuringPriorQualifiedSignal_kg[0]).toBeCloseTo(19, 7)
  })
  test('outage, stale transport and fresh-stuck distinguish blindness from no flow', () => {
    const c = fixture(1251, 1140)
    const outage = replay(c, meters, basis, 'I1_outage', 1000, 100000, pools)
    const stale = replay(c, meters, basis, 'A_transport_hold', 1000, 100000, pools)
    const stuck = replay(c, meters, basis, 'A_fresh_stuck_zero', 1000, 100000, pools)
    expect(outage.firstPositiveCandidate_s[0]).toBeCloseTo(1250.1, 8)
    expect(outage.firstPositiveCandidate_s[1]).toBeCloseTo(1140.1, 8)
    expect(stale.qualityCounts[0]!.STALE).toBeGreaterThan(1000)
    expect(stuck.qualityCounts[0]!.STALE).toBe(0)
    expect(stuck.firstPositiveCandidate_s[0]).toBeCloseTo(1250.1, 8)
    expect(stuck.staticIntervalCoverageDiagnostic[0]!.outsideStaticInterval).toBeGreaterThan(1000)
  })
})
