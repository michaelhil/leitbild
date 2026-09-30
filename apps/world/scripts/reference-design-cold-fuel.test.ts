import { expect, test } from 'bun:test'
import { parseColdFuel } from './reference-design-cold-fuel'

const input = { length_m: .25, pressure_Pa: 15000000, film_W_m2_K: 250,
  preparationTemperature_K: 400, duration_s: 1000, referenceStep_s: 5,
  coldMinimum_K: 300, join_K: 500, hotMaximum_K: 2000,
  cooling: { fuel_K: 550, clad_K: 500, water_K: 323, water_kg: .2, weakWater_kg: .002 },
  heating: { fuel_K: 350, clad_K: 350, water_K: 560, water_kg: .2 } } as const
const doc = (value: unknown) => '```reference-cold-fuel\n' + JSON.stringify(value) + '\n```\n'

test('cold apparatus selection is explicit and finite', () => {
  expect(parseColdFuel(doc(input))).toEqual(input)
})
test('cold source selection cannot silently change its joins or domains', () => {
  for (const bad of [doc({ ...input, coldMinimum_K: 250 }), doc({ ...input, join_K: 600 }),
    doc({ ...input, hotMaximum_K: 2500 }), doc({ ...input, extra: 1 }), '', doc(input) + doc(input)])
    expect(() => parseColdFuel(bad)).toThrow()
})
test('coupon rejects impossible resource comparisons and unsupported preparations', () => {
  for (const bad of [doc({ ...input, film_W_m2_K: 0 }), doc({ ...input, duration_s: -1 }),
    doc({ ...input, preparationTemperature_K: 299 }),
    doc({ ...input, cooling: { ...input.cooling, weakWater_kg: .3 } }),
    doc({ ...input, heating: { ...input.heating, fuel_K: 299 } })])
    expect(() => parseColdFuel(bad)).toThrow()
})
