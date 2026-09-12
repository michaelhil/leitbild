/** Offline physical route/loss/material-face check. No transient or property solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseGeometryBasis, tankGeometry, ringArea, type GeometryBasis } from './reference-design-cmt-geometry.ts'

const positive = z.number().finite().positive()
const schema = z.object({ headerElevation_m: z.number().finite(), bore_m: positive, roughness_m: positive,
  balanceReferenceFlow_kg_s: positive, balanceReferenceLoss_Pa: positive, Cd: positive, Cv: positive,
  hotDensity_kg_m3: positive, hotViscosity_Pa_s: positive, coldDensity_kg_m3: positive, coldViscosity_Pa_s: positive,
  dviNeckLength_m: positive, dviNeckBore_m: positive, dviReferenceFlow_kg_s: positive, dviReferenceLoss_Pa: positive }).strict()
export type BalancePathBasis = z.infer<typeof schema>
export function parseBalancePathBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-cmt-balance-path\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-balance-path block')
  const b = schema.parse(JSON.parse(blocks[0]![1]!))
  if (!(b.Cd <= b.Cv && b.Cv <= 1 && b.roughness_m < b.bore_m && b.roughness_m < b.dviNeckBore_m))
    throw new Error('Invalid selected conductance/roughness')
  return b
}
const area = (d: number) => Math.PI * d * d / 4
/** Same laminar/Colebrook/linear-transition friction selection as the finite outlet reference. */
export function darcyGradient(m: number, rho: number, mu: number, diameter: number, roughness: number) {
  if (![m, rho, mu, diameter, roughness].every(Number.isFinite) || rho <= 0 || mu <= 0 || diameter <= 0 || roughness < 0 || roughness >= diameter)
    throw new Error('Invalid Darcy arguments')
  if (m === 0) return 0
  const A = area(diameter), Re = Math.abs(m) * diameter / (A * mu)
  const laminar = 64 / Re
  let turbulent = laminar
  if (Re > 2000) {
    let lo = .001, hi = .2
    const residual = (f: number) => 1 / Math.sqrt(f) + 2 * Math.log10(roughness / (3.7 * diameter) + 2.51 / (Re * Math.sqrt(f)))
    if (!(residual(lo) > 0 && residual(hi) < 0)) throw new Error('Colebrook root outside declared bracket')
    for (let k = 0; k < 60; k++) {
      const f = (lo + hi) / 2
      const r = residual(f)
      if (r > 0) lo = f; else hi = f
    }
    turbulent = (lo + hi) / 2
  }
  const f = Re <= 2000 ? laminar : Re >= 4000 ? turbulent : laminar + (turbulent - laminar) * (Re - 2000) / 2000
  return f * m * Math.abs(m) / (2 * rho * A * A * diameter)
}

export function checkBalancePath(gb: GeometryBasis, b: BalancePathBasis) {
  const g = tankGeometry(gb), A = area(b.bore_m), Ab = area(gb.bodyEffectiveInnerDiameter_m)
  if (b.bore_m !== gb.feedInnerDiameter_m) throw new Error('BAL bore must join selected feed bore')
  const rise = gb.top_m - b.headerElevation_m, mainVolume = gb.balanceWater_m3 - gb.distributorGroupWater_m3
  const mainLength = mainVolume / A, horizontal = mainLength - rise
  const feedLength = gb.top_m - gb.bodyTop_m, feedVolume = A * feedLength
  const roofVolume = gb.distributorGroupWater_m3 - g.inventories.effectiveBodyWater_m3 - feedVolume
  if (!(rise > 0 && horizontal > 0 && roofVolume > 0)) throw new Error('Selected bore/rise cannot fit retained BAL inventory')
  const roofLength = roofVolume / A, flow = b.balanceReferenceFlow_kg_s
  const totalHoles = gb.ringElevations_m.reduce((s, z) => s + ringArea(gb, z, gb.bodyBottom_m, gb.bodyTop_m), 0)
  const flowBelow = (z: number) => flow * gb.ringElevations_m.reduce((s, zr) => s + ringArea(gb, zr, gb.bodyBottom_m, z), 0) / totalHoles
  const bodyDrop = (n: number) => {
    const dz = (gb.bodyTop_m - gb.bodyBottom_m) / n
    let p = 0
    for (let i = 0; i < n; i++) {
      const local = flowBelow(gb.bodyBottom_m + (i + .5) * dz)
      p += darcyGradient(local, b.hotDensity_kg_m3, b.hotViscosity_Pa_s,
        gb.bodyEffectiveInnerDiameter_m, b.roughness_m) * dz * local / flow
    }
    return p
  }
  const axialBody = bodyDrop(4096), bodyDifference = Math.abs(axialBody - bodyDrop(2048))
  const pipe = darcyGradient(flow, b.hotDensity_kg_m3, b.hotViscosity_Pa_s, b.bore_m, b.roughness_m) * (mainLength + roofLength + feedLength)
  const holes = (flow / (b.Cd * totalHoles)) ** 2 / (2 * b.hotDensity_kg_m3)
  const balanceRemainder = b.balanceReferenceLoss_Pa - pipe - axialBody - holes
  const Ad = area(b.dviNeckBore_m), fd = b.dviReferenceFlow_kg_s
  const dviPipe = darcyGradient(fd, b.coldDensity_kg_m3, b.coldViscosity_Pa_s, b.dviNeckBore_m, b.roughness_m) * b.dviNeckLength_m
  const discharge = fd * fd / (2 * b.coldDensity_kg_m3 * Ad * Ad)
  const dviRemainder = b.dviReferenceLoss_Pa - dviPipe - discharge
  if (!(balanceRemainder > 0 && dviRemainder > 0 && bodyDifference < 1e-5)) throw new Error('Frozen route exceeds loss budget or body quadrature gate')
  const check = (ok: boolean, name: string) => { if (!ok) throw new Error(name) }
  check(Math.abs(mainVolume + roofVolume + feedVolume + g.inventories.effectiveBodyWater_m3 - gb.balanceWater_m3) < 1e-12, 'BAL inventory')
  const bodyCuts = [gb.bodyBottom_m, ...[...gb.ringElevations_m].sort((a, c) => a - c).slice(1).map((z, i) =>
    (z + [...gb.ringElevations_m].sort((a, c) => a - c)[i]!) / 2), gb.bodyTop_m]
  const bodySegments = bodyCuts.slice(1).map((z, i) => ({ bottom_m: bodyCuts[i]!, top_m: z, volume_m3: Ab * (z - bodyCuts[i]!) }))
  check(Math.abs(bodySegments.reduce((s, c) => s + c.volume_m3, 0) - g.inventories.effectiveBodyWater_m3) < 1e-14, 'body inventory')
  // Manufactured simultaneous ring exchange, not a plant pressure/temperature prediction.
  // Equal gross opposite mass, unequal donor total enthalpy/boron; middle ring stationary contact.
  const gross = 2, hotHt = 1.28e6, coldHt = 1.7e5, hotB = .001, coldB = .002
  const signedFaces = gb.ringElevations_m.map((z, i) => {
    const m = i === 0 ? gross : i === 2 ? -gross : 0, donorRho = m >= 0 ? b.hotDensity_kg_m3 : b.coldDensity_kg_m3
    const ar = ringArea(gb, z, gb.bodyBottom_m, gb.bodyTop_m)
    const dp = Math.sign(m) * (m / (b.Cd * ar)) ** 2 / (2 * donorRho)
    const v = Math.sign(m) * b.Cv * Math.sqrt(2 * Math.abs(dp) / donorRho)
    const Ht = m >= 0 ? hotHt : coldHt, concentration = m >= 0 ? hotB : coldB
    return { z_m: z, area_m2: ar, mass_kg_s: m, head_Pa: dp, emergingRadialVelocity_m_s: v,
      tankEnergy_W: m * Ht, tankBoron_kg_s: m * concentration, advectiveRadialMomentum_N: m * v,
      staticH_J_kg: Ht - 9.80665 * z - v * v / 2,
      kinetic_W: m * v * v / 2 }
  })
  const netMass = signedFaces.reduce((s, f) => s + f.mass_kg_s, 0)
  const netEnergy = signedFaces.reduce((s, f) => s + f.tankEnergy_W, 0)
  const netB = signedFaces.reduce((s, f) => s + f.tankBoron_kg_s, 0)
  check(netMass === 0 && netEnergy === gross * (hotHt - coldHt) && netB === gross * (hotB - coldB), 'gross material exchange')
  for (const f of signedFaces) check(Math.abs(f.mass_kg_s * (f.staticH_J_kg + 9.80665 * f.z_m) + f.kinetic_W - f.tankEnergy_W) < 1e-8, 'one total enthalpy')
  const commonSources = [25, 50, -5], combined = commonSources.reduce((s, m) => s + m, 0)
  const commonDrop = (m: number) => darcyGradient(m, b.coldDensity_kg_m3, b.coldViscosity_Pa_s, b.dviNeckBore_m, b.roughness_m) * b.dviNeckLength_m +
    (dviRemainder + discharge) * m * Math.abs(m) / (fd * fd)
  check(commonDrop(combined) > commonDrop(25) && commonDrop(-combined) === -commonDrop(combined), 'shared DVI competition/reversal')
  // Finite side-entry parcel: ambient axial momentum survives radial injection.
  // A reverse parcel removes its own actual donor axial momentum, not just its mass.
  const receiverM = 100, receiverV = 3, parcelM = 2, radialV = 1
  const oldP = receiverM * receiverV, oldK = .5 * receiverM * receiverV ** 2
  const afterEntryK = oldP ** 2 / (2 * (receiverM + parcelM))
  const entryThermalization = oldK + .5 * parcelM * radialV ** 2 - afterEntryK
  const reversedP = oldP - parcelM * receiverV, afterWithdrawalK = reversedP ** 2 / (2 * (receiverM - parcelM))
  check(entryThermalization > .5 * parcelM * radialV ** 2 && reversedP / (receiverM - parcelM) === receiverV &&
    Math.abs(oldK - afterWithdrawalK - .5 * parcelM * receiverV ** 2) < 1e-12, 'moving receiver momentum ownership')
  return { scope: 'Fictional finite route and conservative signed-face arithmetic; no nonlinear receiving trajectory or mixing qualification',
    route: { area_m2: A, mainLength_m: mainLength, headerHorizontal_m: horizontal, rise_m: rise,
      roofHorizontal_m: roofLength, feedLength_m: feedLength, mainVolume_m3: mainVolume, roofVolume_m3: roofVolume,
      feedVolume_m3: feedVolume, bodySegments, totalBAL_m3: gb.balanceWater_m3,
      externalBAL_m3: g.inventories.externalBAL_m3, hotMainResidence_s: mainVolume * b.hotDensity_kg_m3 / flow,
      massFlowInertance_1_m: (mainLength + roofLength + feedLength) / A,
      hotRiseHead_Pa: b.hotDensity_kg_m3 * 9.80665 * rise },
    balanceSizing: { pipe_Pa: pipe, body_Pa: axialBody, bodyQuadratureDifference_Pa: bodyDifference, holes_Pa: holes,
      fictionalRemainder_Pa: balanceRemainder, total_Pa: b.balanceReferenceLoss_Pa },
    dviNeck: { length_m: b.dviNeckLength_m, area_m2: Ad, additionalWater_m3: Ad * b.dviNeckLength_m,
      massFlowInertance_1_m: b.dviNeckLength_m / Ad, residenceAtReference_s: Ad * b.dviNeckLength_m * b.coldDensity_kg_m3 / fd,
      pipe_Pa: dviPipe, discharge_Pa: discharge, fictionalRemainder_Pa: dviRemainder, total_Pa: b.dviReferenceLoss_Pa },
    signedFaces, simultaneousExchange: { netMass_kg_s: netMass, tankEnergy_W: netEnergy, tankBoron_kg_s: netB },
    sharedDVI: { sourceFlows_kg_s: commonSources, combined_kg_s: combined, commonDrop_Pa: commonDrop(combined), loneCMTDrop_Pa: commonDrop(25) },
    movingDowncomerParcel: { receiverM_kg: receiverM, receiverAxialVelocity_m_s: receiverV, parcelM_kg: parcelM,
      incomingRadialVelocity_m_s: radialV, axialMomentumBeforeAndAfterEntry_kg_m_s: oldP,
      thermalizedKinetic_J: entryThermalization, axialMomentumAfterWithdrawal_kg_m_s: reversedP,
      unchangedDonorVelocityAfterWithdrawal_m_s: reversedP / (receiverM - parcelM) },
    physicalDefinitionChecksPassed: true, nonlinearReceivingQualified: false }
}

if (import.meta.main) {
  const [owner] = process.argv.slice(2)
  if (!owner || process.argv.length !== 3) throw new Error('Usage: reference-design-cmt-balance-path.ts cmt-receiving-geometry.md')
  const document = await Bun.file(owner).text(), input = { geometry: parseGeometryBasis(document), path: parseBalancePathBasis(document) }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const sourceHash = hash(await Bun.file(import.meta.path).text()), geometrySourceHash = hash(await Bun.file(new URL('./reference-design-cmt-geometry.ts', import.meta.url)).text())
  console.log(JSON.stringify({ input, inputHash: hash(JSON.stringify(input)), sourceHash, geometrySourceHash, bunVersion: Bun.version,
    ...checkBalancePath(input.geometry, input.path) }, null, 2))
}
