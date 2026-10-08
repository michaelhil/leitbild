/** Physical PRHR compilation for the offline cold operating kernel.
 * Geometry only: no TypeScript heat/flow law or imposed cooling duty. */
import { auditPrhrGeometry, parsePrhrGeometry } from './reference-design-prhr-geometry'
import { auditPrhrIsolation, parsePrhrIsolation } from './reference-design-prhr-isolation'
import { parsePrhrMixing } from './reference-design-prhr-mixing'
import { parsePrhrContact } from './reference-design-prhr-phase-contact'

export type PrhrPart = {
  id: string; length_m: number; diameter_m: number; outsideDiameter_m: number
  parallel: number; elevation_m: number; waterVolume_m3: number
  steelVolume_m3: number; immersed: boolean
}
export type PrhrLossSegment = {
  length_m: number; area_m2: number; diameter_m: number; roughness_m: number; fixedLoss: number
}
export type PrhrLink = { from: string; to: string; segments: PrhrLossSegment[]; seat: boolean }

/** Two physical tube groups and four header regions, not a mixed-bank UA.
 * Boundary names identify physical tap planes; the native assembly must
 * reconstruct those taps rather than silently alias a centroid or surge tee. */
export function compilePrhrOperatingGeometry(document: string) {
  const b = parsePrhrGeometry(document), isolation = parsePrhrIsolation(document)
  const audit = auditPrhrGeometry(b), iso = auditPrhrIsolation(b, isolation)
  const mixing = parsePrhrMixing(document), contact = parsePrhrContact(document)
  if (b.tubes.count % 2 !== 0) throw Error('Two equal physical tube groups require an even tube count')
  if (b.tubes.entryExitLoss_K !== 1.5) throw Error('Unselected tube entrance/discharge loss split')
  const parts: PrhrPart[] = [], links: PrhrLink[] = []
  const add = (id: string, length: number, diameter: number, outside: number, parallel: number,
    elevation: number, immersed: boolean, displacement = 0) => {
    if (parts.some(p => p.id === id)) throw Error('Duplicate PRHR part ' + id)
    const p = { id, length_m: length, diameter_m: diameter, outsideDiameter_m: outside, parallel,
      elevation_m: elevation, waterVolume_m3: parallel * Math.PI * diameter ** 2 * length / 4 - displacement,
      steelVolume_m3: parallel * Math.PI * (outside ** 2 - diameter ** 2) * length / 4, immersed }
    if (!(p.waterVolume_m3 > 0 && p.steelVolume_m3 > 0)) throw Error('Invalid PRHR material allocation')
    parts.push(p); return p
  }
  const segment = (p: PrhrPart, fraction: number, fixedLoss = 0): PrhrLossSegment => ({
    length_m: p.length_m * fraction, area_m2: p.parallel * Math.PI * p.diameter_m ** 2 / 4,
    diameter_m: p.diameter_m, roughness_m: b.roughness_m, fixedLoss })
  const link = (from: string, to: string, segments: PrhrLossSegment[], seat = false) => {
    if (from === to || links.some(l => l.from === from && l.to === to)) throw Error('Invalid PRHR link')
    links.push({ from, to, segments, seat })
  }
  const cavity = isolation.spoolLength_m / 2, hot = b.hotConnector, cold = b.coldConnector
  const upstream = add('PRHR.SEAT.UP', cavity, hot.id_m, hot.od_m, 1, b.hotTerminal_m, false,
    iso.geometry.discVolume_m3 / 2)
  const downstream = add('PRHR.SEAT.DOWN', cavity, hot.id_m, hot.od_m, 1, b.hotTerminal_m, false,
    iso.geometry.discVolume_m3 / 2)
  const riser = add('PRHR.RISER', hot.length_m - isolation.spoolLength_m, hot.id_m, hot.od_m, 1,
    (b.hotTerminal_m + b.tubes.top_m) / 2, false)
  const upper = [0, 1].map(i => add(`PRHR.UPPER.${i + 1}`, b.header.length_m / 2,
    b.header.id_m, b.header.od_m, 1, b.tubes.top_m, true))
  const lower = [0, 1].map(i => add(`PRHR.LOWER.${i + 1}`, b.header.length_m / 2,
    b.header.id_m, b.header.od_m, 1, b.tubes.bottom_m, true))
  const r = b.tubes.bendRadius_m, top = b.tubes.top_m, bottom = b.tubes.bottom_m
  const tubeGroups = [0, 1].map(i => {
    const lengths = [b.tubes.straightLeg_m, Math.PI * r / 2, top - bottom - 2 * r,
      Math.PI * r / 2, b.tubes.straightLeg_m]
    const elevations = [top, top - r + 2 * r / Math.PI, (top + bottom) / 2,
      bottom + r - 2 * r / Math.PI, bottom]
    if (lengths.some(l => l <= 0)) throw Error('Operating C-path requires a positive vertical region')
    return lengths.map((length, j) => add(`PRHR.TUBE.${i + 1}.${j + 1}`, length,
      b.tubes.id_m, b.tubes.od_m, b.tubes.count / 2, elevations[j]!, true))
  })
  // An actual entrance-length region preserves decay of SG stirring; its
  // length is geometry, not a temporal relaxation or extra water stock.
  const entrance = mixing.penetrationBores * cold.id_m
  if (!(entrance > 0 && entrance < cold.length_m)) throw Error('Return entrance must fit the real pipe')
  const z = (s: number) => b.coldTerminal_m + (bottom - b.coldTerminal_m) * s / cold.length_m
  const returns = [add('PRHR.RETURN.ENTRANCE', entrance, cold.id_m, cold.od_m, 1,
    z(entrance / 2), false), add('PRHR.RETURN.BANK', cold.length_m - entrance, cold.id_m,
    cold.od_m, 1, z((entrance + cold.length_m) / 2), false)]
  link('HOT.A.after', upstream.id, [segment(upstream, .5)])
  const A = Math.PI * hot.id_m ** 2 / 4, cal = b.calibration
  const valveK = 2 * cal.density_kg_m3 * A ** 2 * audit.calibration.selectedValveDrop_Pa / cal.flow_kg_s ** 2
  link(upstream.id, downstream.id, [segment(upstream, .5), segment(downstream, .5)], true)
  link(downstream.id, riser.id, [segment(downstream, .5), segment(riser, .5, b.connectorLoss_K / 2)])
  link(riser.id, upper[0]!.id, [segment(riser, .5), segment(upper[0]!, .5)])
  link(upper[0]!.id, upper[1]!.id, [segment(upper[0]!, .5), segment(upper[1]!, .5)])
  link(lower[0]!.id, lower[1]!.id, [segment(lower[0]!, .5), segment(lower[1]!, .5)])
  for (const [i, tubes] of tubeGroups.entries()) {
    link(upper[i]!.id, tubes[0]!.id, [segment(tubes[0]!, .5, b.tubes.entryExitLoss_K / 3)])
    for (let j = 1; j < tubes.length; j++) {
      const previous = tubes[j - 1]!, next = tubes[j]!
      const bend = (p: PrhrPart) => /\.[24]$/.test(p.id) ? b.tubes.bendLoss_K / 2 : 0
      link(previous.id, next.id, [segment(previous, .5, bend(previous)), segment(next, .5, bend(next))])
    }
    link(tubes.at(-1)!.id, lower[i]!.id, [segment(tubes.at(-1)!, .5, 2 * b.tubes.entryExitLoss_K / 3)])
  }
  link(lower[1]!.id, returns[1]!.id, [segment(lower[1]!, .5), segment(returns[1]!, .5)])
  link(returns[1]!.id, returns[0]!.id, [segment(returns[1]!, .5), segment(returns[0]!, .5, b.connectorLoss_K / 2)])
  const returnA = Math.PI * cold.id_m ** 2 / 4
  const meterK = 2 * cal.density_kg_m3 * returnA ** 2 * cal.meterDrop_Pa / cal.flow_kg_s ** 2
  link(returns[0]!.id, 'SG.A.PRIMARY.outlet', [segment(returns[0]!, .5, meterK)])

  const steel = parts.flatMap(p => {
    const shell = p.id.startsWith('PRHR.SEAT.')
    const ri = p.diameter_m / 2, ro = p.outsideDiameter_m / 2
    const rm = Math.sqrt((ri ** 2 + ro ** 2) / 2)
    const centroid = (a: number, c: number) => 2 * (c ** 3 - a ** 3) / (3 * (c ** 2 - a ** 2))
    const centroids = [centroid(ri, rm), centroid(rm, ro)]
    const shellRadius = centroid(ri, ro)
    return shell ? [{ id: p.id + '.SHELL', water: p.id, capacity_J_K: p.steelVolume_m3 * b.steelDensity_kg_m3 * b.steelCp_J_kgK,
      innerResistance_K_W: Math.log(shellRadius / ri) / (2 * Math.PI * b.steelConductivity_W_mK * p.length_m),
      outerResistance_K_W: Math.log(ro / shellRadius) / (2 * Math.PI * b.steelConductivity_W_mK * p.length_m), radius_m: shellRadius }] : centroids.map((radius, i) => ({
      id: p.id + '.STEEL.' + (i + 1), water: p.id,
      capacity_J_K: p.steelVolume_m3 * b.steelDensity_kg_m3 * b.steelCp_J_kgK / 2,
      innerResistance_K_W: Math.log(radius / ri) / (2 * Math.PI * b.steelConductivity_W_mK * p.length_m * p.parallel),
      outerResistance_K_W: Math.log(ro / radius) / (2 * Math.PI * b.steelConductivity_W_mK * p.length_m * p.parallel), radius_m: radius }))
  })
  const disc = [0, 1].map(i => ({ id: 'PRHR.DISC.' + (i + 1), capacity_J_K: iso.material.discHeatCapacity_J_K / 2 }))
  const waterVolume = parts.reduce((s, p) => s + p.waterVolume_m3, 0)
  const steelCapacity = [...steel, ...disc].reduce((s, p) => s + p.capacity_J_K, 0)
  const expectedSteel = (audit.tube.steel_m3 + audit.headers.steel_m3 + audit.hotConnector.steel_m3
    + audit.coldConnector.steel_m3 + iso.geometry.discVolume_m3) * b.steelDensity_kg_m3 * b.steelCp_J_kgK
  if (Math.abs(waterVolume - iso.geometry.revisedPrimaryWater_m3) > 1e-12 * waterVolume
    || Math.abs(steelCapacity - expectedSteel) > 1e-12 * expectedSteel) throw Error('PRHR physical inventories do not partition')
  const hardwareMoment = (audit.tube.external_m3 + audit.headers.external_m3) * (top + bottom) / 2
  return { geometry: b, isolation, mixing, contact, parts, links, steel, disc, valveK,
    discCenterConductance_W_K: iso.material.discHalfCellConductance_W_K,
    shellCenterConductance_W_K: iso.material.shellHalfCellConductance_W_K,
    pool: { ...audit.pool, initialWater_m3: b.pool.initialWater_m3, floor_m: b.pool.floor_m,
      hardwareFirstMoment_m4: hardwareMoment },
    totals: { waterVolume_m3: waterVolume, steelCapacity_J_K: steelCapacity,
      upstreamCavity_m3: upstream.waterVolume_m3, bankWater_m3: waterVolume - upstream.waterVolume_m3 },
    scope: 'Physical inventory/incidence compilation only; no achieved flow, cooling, surface-film or temporal qualification' }
}
