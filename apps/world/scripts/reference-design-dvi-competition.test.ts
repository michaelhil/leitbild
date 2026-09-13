import { describe, expect, test } from 'bun:test'
import { gravityCompetition } from './reference-design-dvi-competition.ts'

const branches = [
  { name: 'high', sourceHead_Pa: 160000, resistance_Pa_s2_kg2: 14, crack_Pa: 1000, open: true, failedOpen: false },
  { name: 'low', sourceHead_Pa: 103000, resistance_Pa_s2_kg2: 6, crack_Pa: 1000, open: true, failedOpen: false },
]
const loss = (m: number) => m * Math.abs(m)
describe('shared gravity-source hydraulic allocation', () => {
  test('common pressure seats a weak healthy check and is independent of source order', () => {
    const r = gravityCompetition(branches, 100000, loss)
    expect(r.branches[0]!.flow_kg_s).toBeGreaterThan(0)
    expect(r.branches[1]!.flow_kg_s).toBe(0)
    expect(r.branches[1]!.state).toBe('seated')
    const reverse = gravityCompetition([...branches].reverse(), 100000, loss)
    expect(reverse.dviPressure_Pa).toBe(r.dviPressure_Pa)
    expect(reverse.neckFlow_kg_s).toBe(r.neckFlow_kg_s)
    expect(Math.abs(r.pressureResidual_Pa)).toBeLessThan(1e-5)
  })
  test('failed-open weak check permits backfill instead of clipping the solved negative flow', () => {
    const r = gravityCompetition(branches.map(b => ({ ...b, failedOpen: b.name === 'low' })), 100000, loss)
    expect(r.branches[1]!.flow_kg_s).toBeLessThan(0)
    expect(r.branches[1]!.state).toBe('backfilling')
    expect(r.neckFlow_kg_s).toBeLessThan(r.branches[0]!.flow_kg_s)
    expect(r.neckFlow_kg_s).toBe(r.branches.reduce((s, b) => s + b.flow_kg_s, 0))
  })
  test('downcomer overpressure seats healthy checks but does not invent a common-neck check', () => {
    expect(gravityCompetition(branches, 180000, loss).neckFlow_kg_s).toBe(0)
    const r = gravityCompetition(branches.map(b => ({ ...b, failedOpen: true })), 180000, loss)
    expect(r.neckFlow_kg_s).toBeLessThan(0)
    expect(r.dviPressure_Pa).toBeLessThan(180000)
    expect(() => gravityCompetition([{ ...branches[0]!, resistance_Pa_s2_kg2: 0 }], 100000, loss)).toThrow()
  })
})
