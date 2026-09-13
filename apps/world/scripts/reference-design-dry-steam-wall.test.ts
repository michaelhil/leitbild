import { expect, test } from 'bun:test'
import { drySteamComparisonRejections, drySteamConvection } from './reference-design-dry-steam-wall.ts'

test('CTF dry-steam source has exact zero heat and continuous signed heat at thermal equality', () => {
  const law = (delta: number) => drySteamConvection(300000, 1, .06, .011, delta)
  expect(law(0).heatFlux_W_m2).toBe(0)
  expect(law(100).heatFlux_W_m2).toBeCloseTo(-law(-100).heatFlux_W_m2, 8)
  expect(Math.abs(law(1e-9).heatFlux_W_m2)).toBeLessThan(.00001)
  expect(Math.abs(law(-1e-9).heatFlux_W_m2)).toBeLessThan(.00001)
  expect(law(100).h_W_m2K).toBeCloseTo(Math.max(10, .023 * 300000 ** .8, .07907 * 300000 ** .6774) * .06 / .011, 10)
  expect(() => drySteamConvection(-1, 1, .06, .011, 100)).toThrow()
})

test('remaining liquid, exhausted steam, reversal and unowned heat regimes are not silently admitted', () => {
  const s = { liquidMass: 0, vaporMass: 1, superheated: true, re: 300000, pr: 1,
    massFlux: 800, mach: .08, richardson: .001, radiationFraction: .03 }
  expect(drySteamComparisonRejections(s)).toEqual([])
  for (const delta of [{ liquidMass: 1e-10 }, { vaporMass: 0 }, { superheated: false }, { re: 9000 },
    { massFlux: -1 }, { mach: .4 }, { richardson: .2 }, { radiationFraction: .2 }])
    expect(drySteamComparisonRejections({ ...s, ...delta }).length).toBeGreaterThan(0)
  expect(() => drySteamComparisonRejections({ ...s, vaporMass: NaN })).toThrow()
})
