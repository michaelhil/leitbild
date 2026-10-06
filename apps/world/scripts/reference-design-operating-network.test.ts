import { expect, test } from 'bun:test'
import { annularLaminarGeometry, compileOperatingNetwork, foldedPieceCentroid,
  parseOperatingGuideDrag, parseOperatingNoncoreLosses, parseOperatingSgColdContact,
  parseOperatingSgSecondary } from './reference-design-operating-network'
import { foldedGeometry } from './reference-design-primary-mechanics'

const wiki = process.env.LEITBILD_REFERENCE_WIKI

test('folded pieces partition the authored developed-length first moment', () => {
  for (const crest of [12, 12.1]) {
    const means = Array.from({ length: 4 }, (_, i) => foldedPieceCentroid(20, 2.5, crest, 3, 5 * i, 5 * (i + 1)))
    expect(means.reduce((a, b) => a + b, 0) / 4).toBeCloseTo(foldedGeometry(20, 2.5, crest, 3).meanElevation_m, 12)
  }
  expect(() => foldedPieceCentroid(20, 2.5, 12, 3, 5, 5)).toThrow()
  expect(() => foldedPieceCentroid(20, 2.5, 12, 3, -1, 5)).toThrow()
})

test('annular molecular geometry recovers circular64/Re and parallel conductance', () => {
  const L = 2, r = .0055, A = Math.PI * r * r, D = 2 * r
  const lam = annularLaminarGeometry(L, r, 0, 1)
  expect(2 * lam * A * D * D / L).toBeCloseTo(64, 12)
  expect(annularLaminarGeometry(L, r, .00475, 2)).toBeCloseTo(annularLaminarGeometry(L, r, .00475, 1) / 2, 8)
  expect(() => annularLaminarGeometry(L, r, r, 1)).toThrow()
})

test('selected prose/table inputs fail closed, rather than supplying plausible coefficients', () => {
  const table = '## Current nonnegative physical loss allocation\n'
    + '| HOT path | 0.499095 | none |\n| Folded SG primary | 7.511812 | none |\n'
    + '| Each pump passage / COLD entry | 1.127752 | 1 |\n## Retained prescribed-temperature reference'
  expect(parseOperatingNoncoreLosses(table)).toEqual({ hot: .499095, sg: 7.511812, pump: 1.127752 })
  expect(() => parseOperatingNoncoreLosses(table.replace('7.511812', 'unknown'))).toThrow()
  expect(() => parseOperatingNoncoreLosses(table.replace('| HOT path |', '| Historical HOT |'))).toThrow()
  expect(() => parseOperatingSgColdContact('')).toThrow()
  expect(() => parseOperatingSgSecondary('')).toThrow()
  expect(() => parseOperatingGuideDrag('')).toThrow()
})

const ownerTest = wiki ? test : test.skip
ownerTest('actual owners compile both finite SG secondaries and reciprocal metal contacts', async () => {
  const p = await compileOperatingNetwork(wiki!, { horizon_s: 300, remainingBudget_s: 120 })
  expect(p.water.length).toBe(26)
  expect(p.solids.length).toBe(8)
  expect(p.hydraulic.length).toBe(32)
  expect(p.heat.length).toBe(8)
  expect(p.secondaries.length).toBe(2)
  expect(p.secondaryHeat.length).toBe(8)
  expect(p.secondaries.map(s => s.id)).toEqual(['SG.A.SECONDARY', 'SG.B.SECONDARY'])
  for (const s of p.secondaries) expect(s).toMatchObject({ volume_m3: 120, liquidVolume_m3: 72,
    gasVolume_m3: 48, temperature_K: 313.15, pressure_Pa: 101325, nitrogenMass_kg: 0,
    minimumWettedVolume_m3: 71.25 })
  for (const [i, h] of p.secondaryHeat.entries()) expect(h).toEqual({ solid: i,
    secondary: i < 4 ? 0 : 1, area_m2: 1250, diameter_m: .020 })
  expect(p.nativeInput.trim().split('\n').slice(-11)[0]).toBe('2 8')
  expect(p.anchor).toEqual({ pressure_Pa: 300000, temperature_K: 300, elevation_m: 2.5 })
  expect(p.solids.reduce((s, n) => s + n.capacity_J_K, 0)).toBe(300e6)
  expect(p.solids.every(n => n.temperature_K === 313.15)).toBe(true)
  expect(p.water.filter(n => /^P\.[AB][12]\.PASSAGE$/.test(n.id)).length).toBe(4)
  expect(p.water.every(n => !/PZR|SURGE|SECONDARY/.test(n.id))).toBe(true)
  expect(p.omittedWaterSupports.map(n => n.id)).toEqual(['PZR', 'SURGE'])
  expect(p.sourceResolution).toMatchObject({ assemblies: 193, materialHistorySegments: 386,
    comparatorNeutronCoordinates: 35182, comparatorFuelCladCoordinates: 9264, sourceOrHistoryAdvanced: false })
  expect(p.helperIdentities.some(n => n.path.endsWith('.fixture.ts'))).toBe(false)
  expect(p.ownerIdentities.every(n => /^[a-f0-9]{64}$/.test(n.sha256))).toBe(true)
  expect(p.nativeInput.trim().split('\n')[0]!.split(' ').length).toBe(11)
  const sg = p.hydraulic.filter(n => n.id.includes('SG.A') && !n.id.includes('PASSAGE'))
  expect(sg.reduce((s, n) => s + n.length_m, 0)).toBe(20)
  expect(sg.reduce((s, n) => s + n.fixedLoss, 0)).toBeCloseTo(7.511812, 12)
  expect(sg.every(n => n.kind === 0 && n.diameter_m !== p.heat[0]!.thermalDiameter_m)).toBe(true)
  expect(p.hydraulic.filter(n => n.kind === 3).reduce((s, n) => s + n.gridMultiplierOrAnnularDarcyCoefficient, 0)).toBeCloseTo(8 * .35 ** 2, 12)
  expect(p.hydraulic.filter(n => n.kind === 4).every(n => n.fixedLoss === .5 && n.roughness_m === 2e-6)).toBe(true)
  expect(p.hydraulic.filter(n => n.kind === 5).length).toBe(4)
  expect(p.limitations.some(n => n.includes('Re<=500'))).toBe(false)
  expect(p.limitations.some(n => n.includes('no retained contact inertia'))).toBe(true)
  expect(p.limitations.some(n => n.includes('zero-flow guess is not an admitted rest state'))).toBe(true)
  expect(p.limitations.some(n => n.includes('flow inertia') || n.includes('drives qdot'))).toBe(false)
}, 60_000)

test('secondary preparation changes follow the authored physical state and reject incomplete scope', () => {
  const fixture = '## Secondary exposure and local metal storage\n'
    + 'horizontal area **7.5 m²**, bottom **+2.5 m**; crown at +12 m.\n'
    + '### Cold secondary and startup heat-receiving path\n'
    + 'Each SG starts at 40°C, 101325 Pa total absolute pressure, with its existing 120 m³ envelope divided into 72 m³ liquid and 48 m³ shared gas; nitrogen is zero.\n'
  expect(parseOperatingSgSecondary(fixture).minimumWettedVolume_m3).toBe(71.25)
  expect(parseOperatingSgSecondary(fixture.replace('40°C', '35°C')).temperature_K).toBe(308.15)
  for (const changed of [fixture.replace('nitrogen is zero', 'nitrogen unknown'),
    fixture.replace('48 m³ shared gas', '47 m³ shared gas'),
    fixture.replace('72 m³ liquid and 48', '70 m³ liquid and 50'),
    fixture.replace('crown at +12 m', 'crown at +? m')]) expect(() => parseOperatingSgSecondary(changed)).toThrow()
})

test('execution controls require a useful interval and one finite allowance', async () => {
  await expect(compileOperatingNetwork('', { horizon_s: 300, remainingBudget_s: 120 })).rejects.toThrow()
  await expect(compileOperatingNetwork('/nonexistent', { horizon_s: .001, remainingBudget_s: 120 })).rejects.toThrow()
  await expect(compileOperatingNetwork('/nonexistent', { horizon_s: 300, remainingBudget_s: 121 })).rejects.toThrow()
})
