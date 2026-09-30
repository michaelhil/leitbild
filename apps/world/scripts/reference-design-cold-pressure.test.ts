import { expect, test } from 'bun:test'
import { coldReliefAssemblyArea, parseColdPressure } from './reference-design-cold-pressure'
const basis = { opening_Pa: 3000000, reseat_Pa: 2800000, limit_Pa: 4000000, reliefArea_m2: .0008, isolationArea_m2: .004, stroke_s: .05,
  volume_m3: 100, initialPressure_Pa: 1000000, temperatures_K: [313.15, 423.15], inflow_kg_s: 10,
  inletTemperature_K: 313.15, heat_W: [30000000, 100000000], receivers_Pa: [101325, 2800000], duration_s: 30,
  coldPzr: { temperature_K: 300, hotPressure_Pa: 300000, liquidPreparationHeight_m: 4 } }
const doc = (b: unknown) => '```reference-cold-pressure\n'+JSON.stringify(b)+'\n```\n'
test('cold pressure selection is explicit, finite and independently identified', () => {
  expect(parseColdPressure(doc(basis))).toEqual(basis)
})
test('series isolation is not an upstream pressure sensor or an aperture product', () => {
  const full = .0007844645405527362
  expect(coldReliefAssemblyArea(.0008, 1, .004, 1)).toBeCloseTo(full, 14)
  expect(coldReliefAssemblyArea(.0008, 1, .004, 0)).toBe(0)
  expect(coldReliefAssemblyArea(.0008, 0, .004, 1)).toBe(0)
  expect(coldReliefAssemblyArea(.0008, .5, .004, 1)).toBeGreaterThan(.5 * full)
  expect(() => coldReliefAssemblyArea(.0008, 2, .004, 1)).toThrow()
})
test('invalid sequence, domain, resource and duplicate owner cannot silently pass', () => {
  for (const b of [{ ...basis, opening_Pa: 5000000 }, { ...basis, reseat_Pa: 3000000 }, { ...basis, stroke_s: 0 },
    { ...basis, initialPressure_Pa: 3000000 }, { ...basis, temperatures_K: [299, 400] },
    { ...basis, coldPzr: { ...basis.coldPzr, liquidPreparationHeight_m: 2 } }, { ...basis, extra: 1 }])
    expect(() => parseColdPressure(doc(b))).toThrow()
  for (const d of ['', doc(basis)+doc(basis)]) expect(() => parseColdPressure(d)).toThrow()
})
