import { expect, test } from 'bun:test'
import { parseTransportBasis } from './reference-design-pressurizer-transport'

const basis: ReturnType<typeof parseTransportBasis> = { pressure_MPa: 14.914398370832105, vesselVolume_m3: 60, area_m2: 5, initialVolume_m3: 30,
  initial: { temperature_K: 570, boron_ppm: 1200 }, cold: { temperature_K: 430, boron_ppm: 0 },
  warm: { temperature_K: 520, boron_ppm: 600 }, sourceMass_kg: 5000, receiverMass_kg: 1000,
  strokeRate_kg_s: 20, strokes: [{ kind: 'admit', source: 'cold', mass_kg: 2500 },
    { kind: 'hold', duration_s: 120 }, { kind: 'withdraw', mass_kg: 1500 },
    { kind: 'admit', source: 'warm', mass_kg: 2000 }, { kind: 'hold', duration_s: 60 },
    { kind: 'withdraw', mass_kg: 3500 }], bands: [48, 96, 192], subdivisions: [4, 16, 64],
  costBands: [384, 768, 1536], costSubdivisions: 128,
  maximumOutletMeanAbsoluteError_K: 3, maximumRelativeWithdrawnEnthalpyError: .01 }
const page = (b: unknown) => '```reference-pressurizer-transport\n' + JSON.stringify(b) + '\n```\n'

test('liquid-history reference requires explicit, unambiguous physical and numerical inputs', () => {
  expect(parseTransportBasis(page(basis))).toEqual(basis)
  expect(() => parseTransportBasis(page(basis) + page(basis))).toThrow()
  expect(() => parseTransportBasis('')).toThrow()
  for (const bad of [{ ...basis, pressure_MPa: 0 }, { ...basis, initialVolume_m3: 60 },
    { ...basis, bands: [48, 48, 192] }, { ...basis, subdivisions: [64, 16, 4] },
    { ...basis, sourceMass_kg: 2500 }, { ...basis, automaticSaturationReset: true },
    { ...basis, cold: { ...basis.cold, boron_ppm: -1 } },
    { ...basis, strokes: [{ kind: 'admit', source: 'infinite-reservoir', mass_kg: 1 }] },
    { ...basis, strokes: [{ kind: 'withdraw', mass_kg: -1 }] },
    { ...basis, strokes: [{ kind: 'hold', duration_s: 0 }] }])
    expect(() => parseTransportBasis(page(bad))).toThrow()
  expect(() => parseTransportBasis(page({ ...basis, strokes: basis.strokes.map((s, i) => i === 0 ? { ...s, mass_kg: 2400 } : s) }))).toThrow('frozen benchmark')
})
