import { expect, test } from 'bun:test'
import { preparationGeometry, initialPressureCommand } from './reference-design-pressurizer-preparation'
import { heaterBankGeometry } from './reference-design-pressurizer-heater-banks'

test('ten disjoint fluid volumes include both fixed banks', () => {
  const regions = preparationGeometry()
  expect(regions).toHaveLength(10)
  expect(regions.reduce((v, r) => v + r.volume_m3, 0) + heaterBankGeometry(6).totalSolid_m3).toBeCloseTo(60, 12)
  expect(regions.filter(r => r.phase === 'liquid')).toHaveLength(6)
  expect(regions.filter(r => r.phase === 'steam').reduce((v, r) => v + r.volume_m3, 0)).toBe(30)
  expect(regions[0]!.centroid_m).toBe(7)
  expect(regions.at(-1)!.centroid_m).toBe(17)
})

test('fresh actual acquisition retains old setpoint rather than balancing heaters', () => {
  const result = initialPressureCommand(15e6)
  expect(result.acquired_Pa).toBe(15e6)
  expect(result.heaterRequest_W).toBe(0)
  expect(result.controlledSprayRequest).toBe(1)
  expect(() => initialPressureCommand(NaN)).toThrow()
})
