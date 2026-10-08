import { expect, test } from 'bun:test'
import { compilePrhrOperatingGeometry } from './reference-design-prhr-operating'
import { auditPrhrGeometry, parsePrhrGeometry } from './reference-design-prhr-geometry'
import { auditPrhrIsolation, parsePrhrIsolation } from './reference-design-prhr-isolation'

const wiki = process.env.LEITBILD_REFERENCE_WIKI
const ownerTest = wiki ? test : test.skip
const read = () => Bun.file(wiki + '/systems/passive-cooling/residual-heat-exchanger.md').text()

ownerTest('operating PRHR partitions actual water/steel and displaced WST geometry once', async () => {
  const text = await read(), p = compilePrhrOperatingGeometry(text)
  const b = parsePrhrGeometry(text), a = auditPrhrGeometry(b), iso = auditPrhrIsolation(b, parsePrhrIsolation(text))
  expect(p.parts.length).toBe(19)
  expect(p.steel.length).toBe(36)
  expect(p.disc.length).toBe(2)
  expect(p.totals.waterVolume_m3).toBeCloseTo(iso.geometry.revisedPrimaryWater_m3, 12)
  expect(p.totals.upstreamCavity_m3).toBeCloseTo(iso.geometry.closedHotConnectedWater_m3, 14)
  expect(p.totals.bankWater_m3).toBeCloseTo(iso.geometry.closedBankConnectedWater_m3, 12)
  expect(p.pool.displacement_m3).toBe(a.pool.displacement_m3)
  expect(p.pool.hardwareFirstMoment_m4).toBeCloseTo(a.pool.displacement_m3 * 12, 10)
  expect(p.parts.filter(q => q.immersed).reduce((s, q) => s + q.steelVolume_m3, 0))
    .toBeCloseTo(a.tube.steel_m3 + a.headers.steel_m3, 12)
  expect(p.steel.filter(q => q.id.endsWith('.SHELL')).reduce((s, q) => s + q.capacity_J_K, 0))
    .toBeCloseTo(iso.material.spoolShellHeatCapacity_J_K, 8)
  expect(p.disc.reduce((s, q) => s + q.capacity_J_K, 0)).toBe(iso.material.discHeatCapacity_J_K)
})

ownerTest('two C-paths retain actual single-tube diameter, elevations and parallel inventories', async () => {
  const p = compilePrhrOperatingGeometry(await read()), b = p.geometry
  for (const group of [1, 2]) {
    const parts = p.parts.filter(q => q.id.startsWith('PRHR.TUBE.' + group + '.'))
    expect(parts.length).toBe(5)
    expect(parts.every(q => q.parallel === 150 && q.diameter_m === .05)).toBe(true)
    expect(parts.reduce((s, q) => s + q.length_m, 0)).toBeCloseTo(
      2 * b.tubes.straightLeg_m + b.tubes.top_m - b.tubes.bottom_m - 2 * b.tubes.bendRadius_m
      + Math.PI * b.tubes.bendRadius_m, 12)
    expect(parts.reduce((s, q) => s + q.waterVolume_m3 * q.elevation_m, 0)
      / parts.reduce((s, q) => s + q.waterVolume_m3, 0)).toBeCloseTo(12, 12)
  }
  expect(p.parts.filter(q => /PRHR\.(UPPER|LOWER)\./.test(q.id)).every(q => q.length_m === 15)).toBe(true)
})

ownerTest('closing only the actual seat preserves the SG connection and bank internal loop', async () => {
  const p = compilePrhrOperatingGeometry(await read())
  expect(p.links.filter(l => l.seat).length).toBe(1)
  const reached = new Set(['SG.A.PRIMARY.outlet'])
  for (let iteration = 0; iteration < p.parts.length; iteration++) for (const l of p.links) {
    if (l.seat) continue
    if (reached.has(l.from)) reached.add(l.to)
    if (reached.has(l.to)) reached.add(l.from)
  }
  expect(reached.has('PRHR.SEAT.DOWN')).toBe(true)
  expect(reached.has('PRHR.SEAT.UP')).toBe(false)
  expect(reached.has('HOT.A.after')).toBe(false)
  expect(p.parts.filter(q => q.id !== 'PRHR.SEAT.UP').every(q => reached.has(q.id))).toBe(true)
  expect(p.links.filter(l => l.from.startsWith('PRHR.TUBE') && l.to.startsWith('PRHR.LOWER')).length).toBe(2)
})

ownerTest('series losses allocate real material lengths and distinct bores without duplicating friction', async () => {
  const p = compilePrhrOperatingGeometry(await read())
  const total = p.links.flatMap(l => l.segments).reduce((s, q) => s + q.length_m, 0)
  // Upper-far and lower-near tails beyond the representative group junctions
  // own fluid/steel but carry no net throughflow; do not invent their loss.
  // Their thermal stock is lumped into the corresponding finite header cell.
  const blindLength = p.geometry.header.length_m / 2
  expect(total).toBeCloseTo(p.parts.reduce((s, q) => s + q.length_m, 0) - blindLength, 12)
  const inlet = p.links.find(l => l.from === 'PRHR.RISER')!
  expect(inlet.segments.map(s => s.diameter_m)).toEqual([.5, .6])
  for (const group of [1, 2]) {
    const loss = p.links.filter(l => l.from.startsWith(`PRHR.TUBE.${group}.`)
      || l.to.startsWith(`PRHR.TUBE.${group}.`)).flatMap(l => l.segments).reduce((s, q) => s + q.fixedLoss, 0)
    expect(loss).toBeCloseTo(1.5 + 2 * p.geometry.tubes.bendLoss_K, 14)
  }
  expect(p.valveK).toBeGreaterThan(0)
})

ownerTest('radial center resistances recover one real wall and finite shell/disc memory', async () => {
  const p = compilePrhrOperatingGeometry(await read()), k = p.geometry.steelConductivity_W_mK
  for (const part of p.parts) {
    const steel = p.steel.filter(s => s.water === part.id)
    const g = 2 * Math.PI * k * part.length_m * part.parallel
    if (steel.length === 1) {
      expect(steel[0]!.innerResistance_K_W + steel[0]!.outerResistance_K_W)
        .toBeCloseTo(Math.log(part.outsideDiameter_m / part.diameter_m) / g, 14)
    } else {
      expect(steel.length).toBe(2)
      const inner = steel[0]!, outer = steel[1]!
      const centerResistance = Math.log(outer.radius_m / inner.radius_m) / g
      expect(inner.innerResistance_K_W + centerResistance + outer.outerResistance_K_W)
        .toBeCloseTo(Math.log(part.outsideDiameter_m / part.diameter_m) / g, 14)
      expect(inner.capacity_J_K).toBe(outer.capacity_J_K)
    }
  }
  expect(p.discCenterConductance_W_K).toBeGreaterThan(0)
  expect(p.shellCenterConductance_W_K).toBeGreaterThan(0)
})

ownerTest('unsupported geometry changes refuse rather than retain hardcoded losses or counts', async () => {
  const text = await read()
  expect(() => compilePrhrOperatingGeometry(text.replace('"count":300', '"count":299'))).toThrow()
  expect(() => compilePrhrOperatingGeometry(text.replace('"entryExitLoss_K":1.5', '"entryExitLoss_K":2'))).toThrow()
  expect(() => compilePrhrOperatingGeometry(text.replace('"penetrationBores":1', '"penetrationBores":100'))).toThrow()
  expect(() => compilePrhrOperatingGeometry(text.replace('reference-prhr-isolation', 'old-prhr-isolation'))).toThrow()
})
