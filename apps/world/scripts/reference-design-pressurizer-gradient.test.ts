import { expect, test } from 'bun:test'
import { parseGradientBasis } from './reference-design-pressurizer-gradient'

const transport = { pressure_MPa: 14.914398370832105, vesselVolume_m3: 60, area_m2: 5, initialVolume_m3: 30,
  initial: { temperature_K: 570, boron_ppm: 1200 }, cold: { temperature_K: 430, boron_ppm: 0 },
  warm: { temperature_K: 520, boron_ppm: 600 }, sourceMass_kg: 5000, receiverMass_kg: 1000,
  strokeRate_kg_s: 20, strokes: [{ kind: 'admit', source: 'cold', mass_kg: 2500 },
    { kind: 'hold', duration_s: 120 }, { kind: 'withdraw', mass_kg: 1500 },
    { kind: 'admit', source: 'warm', mass_kg: 2000 }, { kind: 'hold', duration_s: 60 },
    { kind: 'withdraw', mass_kg: 3500 }], bands: [48, 96, 192], subdivisions: [4, 16, 64],
  costBands: [384, 768, 1536], costSubdivisions: 128,
  maximumOutletMeanAbsoluteError_K: 3, maximumRelativeWithdrawnEnthalpyError: .01 }
const block = (name: string, value: unknown) => '```' + name + '\n' + JSON.stringify(value) + '\n```\n'
const owner = block('reference-pressurizer-transport', transport)

test('gradient comparison owns explicit manufactured heating, not hidden wall parameters', () => {
  expect(parseGradientBasis(owner + block('reference-pressurizer-gradient', { specificHeatingRate_W_kg: 500 })).gradient)
    .toEqual({ specificHeatingRate_W_kg: 500 })
  for (const bad of [{}, { specificHeatingRate_W_kg: -1 }, { specificHeatingRate_W_kg: 0 },
    { specificHeatingRate_W_kg: 500, turbulence: 1 }])
    expect(() => parseGradientBasis(owner + block('reference-pressurizer-gradient', bad))).toThrow()
  const heat = block('reference-pressurizer-gradient', { specificHeatingRate_W_kg: 500 })
  expect(() => parseGradientBasis(owner)).toThrow()
  expect(() => parseGradientBasis(owner + heat + heat)).toThrow()
  expect(() => parseGradientBasis(heat)).toThrow()
})
