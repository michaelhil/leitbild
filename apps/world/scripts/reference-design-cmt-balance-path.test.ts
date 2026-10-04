import { expect, test } from 'bun:test'
import { parseGeometryBasis, type GeometryBasis } from './reference-design-cmt-geometry.ts'
import { allocateMeterLoss, checkConnectedMeters, checkBalancePath, darcyGradient, parseBalancePathBasis, thinScreenFromMass, type BalancePathBasis } from './reference-design-cmt-balance-path.ts'

// Test-only selected inputs: a clean app checkout does not contain the separate wiki repository.
const geometry: GeometryBasis = { freeWater_m3: 60, bottomDatum_m: 6, top_m: 12,
  bodyBottom_m: 11.725, bodyTop_m: 11.975, bodyOuterDiameter_m: .41, bodyEffectiveInnerDiameter_m: .35,
  feedOuterDiameter_m: .22, feedInnerDiameter_m: .20, mouthDiameter_m: .20,
  balanceWater_m3: 1, distributorGroupWater_m3: .05, hardwareSolid_m3: .02,
  holeDiameter_m: .06153846153846154, holesPerRing: 10, ringElevations_m: [11.925, 11.850, 11.775],
  upperTap_m: 11.95, topProbe_m: 11.25, bottomProbe_m: 6.75, probeRadialInset_m: .15, probeAzimuth_deg: 18 }
const path: BalancePathBasis = { headerElevation_m: 3, bore_m: .20, roughness_m: .000045,
  balanceReferenceFlow_kg_s: 25, balanceReferenceLoss_Pa: 2000, Cd: .62, Cv: .98,
  hotDensity_kg_m3: 745.7158573797482, hotViscosity_Pa_s: .00009238956797398296,
  coldDensity_kg_m3: 998.7373535000849, coldViscosity_Pa_s: .0006547658656041072,
  dviNeckLength_m: 1, dviNeckBore_m: .20, dviReferenceFlow_kg_s: 100, dviReferenceLoss_Pa: 10000 }
const record = (v: unknown) => '```reference-cmt-balance-path\n' + JSON.stringify(v) + '\n```'
const owner = '```reference-cmt-geometry\n' + JSON.stringify(geometry) + '\n```\n\n' + record(path)
const g = parseGeometryBasis(owner), b = parseBalancePathBasis(owner)

test('thin screen keeps whole-hole viscous scale, exact zero and signed reversal', () => {
  const input = { mass_kg_s: .001, donorDensity_kg_m3: 1000, leftViscosity_Pa_s: .001,
    rightViscosity_Pa_s: .002, patchArea_m2: .01, wholeHoleDiameter_m: .06, Cd: .62, Cv: .98 }
  const f = thinScreenFromMass(input), reverse = thinScreenFromMass({ ...input, mass_kg_s: -input.mass_kg_s,
    leftViscosity_Pa_s: input.rightViscosity_Pa_s, rightViscosity_Pa_s: input.leftViscosity_Pa_s })
  expect(f.resistance_Pa_s_m).toBeCloseTo(6 * Math.PI * .0015 / .06, 14)
  expect(reverse.head_Pa).toBe(-f.head_Pa)
  expect(reverse.emergingVelocity_m_s).toBe(-f.emergingVelocity_m_s)
  expect(f.head_Pa * f.superficialVelocity_m_s).toBeGreaterThan(0)
  const zero = thinScreenFromMass({ ...input, mass_kg_s: 0 })
  expect(zero.head_Pa).toBe(0)
  expect(zero.emergingVelocity_m_s).toBe(0)
  const halfPatch = thinScreenFromMass({ ...input, mass_kg_s: input.mass_kg_s / 2, patchArea_m2: input.patchArea_m2 / 2 })
  expect(halfPatch.head_Pa).toBe(f.head_Pa)
  expect(halfPatch.emergingVelocity_m_s).toBe(f.emergingVelocity_m_s)
  for (const invalid of [{ wholeHoleDiameter_m: 0 }, { leftViscosity_Pa_s: 0 }, { rightViscosity_Pa_s: NaN },
    { patchArea_m2: 0 }, { donorDensity_kg_m3: -1 }, { Cd: 1.1 }, { Cv: 1.1 }])
    expect(() => thinScreenFromMass({ ...input, ...invalid })).toThrow()
})

test('screen linear limit and inertial jet do not turn viscous loss into extra kinetic energy', () => {
  const input = { mass_kg_s: 1e-8, donorDensity_kg_m3: 1000, leftViscosity_Pa_s: .001,
    rightViscosity_Pa_s: .001, patchArea_m2: .01, wholeHoleDiameter_m: .06, Cd: .62, Cv: .98 }
  const low = thinScreenFromMass(input), high = thinScreenFromMass({ ...input, mass_kg_s: 100 })
  expect(low.inertialHead_Pa / low.viscousHead_Pa).toBeLessThan(1e-5)
  expect(high.viscousHead_Pa / high.inertialHead_Pa).toBeLessThan(1e-4)
  for (const f of [low, high]) {
    expect(f.emergingVelocity_m_s).toBeCloseTo(input.Cv * Math.sqrt(2 * f.inertialHead_Pa / input.donorDensity_kg_m3), 14)
    expect(f.emergingVelocity_m_s).toBeLessThan(input.Cv * Math.sqrt(2 * f.head_Pa / input.donorDensity_kg_m3))
  }
})

test('selected route preserves BAL allocation and adds common neck once', () => {
  const r = checkBalancePath(g, b)
  expect(r.route.mainLength_m).toBeCloseTo(.95 / (Math.PI * .1 ** 2), 12)
  expect(r.route.mainVolume_m3 + r.route.roofVolume_m3 + r.route.feedVolume_m3 + r.route.bodySegments.reduce((s, x) => s + x.volume_m3, 0)).toBeCloseTo(1, 14)
  expect(r.dviNeck.additionalWater_m3).toBeCloseTo(Math.PI * .1 ** 2, 14)
  expect(r.balanceSizing.fictionalRemainder_Pa).toBeGreaterThan(0)
  expect(r.balanceSizing.holesViscous_Pa).toBeGreaterThan(0)
  expect(r.balanceSizing.holes_Pa).toBe(r.balanceSizing.holesViscous_Pa + r.balanceSizing.holesInertial_Pa)
  expect(r.dviNeck.fictionalRemainder_Pa).toBeGreaterThan(0)
  expect(r.nonlinearReceivingQualified).toBe(false)
})

test('opposed ring donors conserve total energy and boron without net-flow collapse', () => {
  const r = checkBalancePath(g, b)
  expect(r.simultaneousExchange.netMass_kg_s).toBe(0)
  expect(r.simultaneousExchange.tankEnergy_W).toBe(2_220_000)
  expect(r.simultaneousExchange.tankBoron_kg_s).toBe(-.002)
  expect(r.signedFaces[0]!.emergingRadialVelocity_m_s).toBeGreaterThan(0)
  expect(r.signedFaces[2]!.emergingRadialVelocity_m_s).toBeLessThan(0)
  expect(r.movingDowncomerParcel.unchangedDonorVelocityAfterWithdrawal_m_s).toBe(3)
  expect(r.movingDowncomerParcel.axialMomentumBeforeAndAfterEntry_kg_m_s).toBe(300)
  expect(r.sharedDVI.commonDrop_Pa).toBeGreaterThan(r.sharedDVI.loneCMTDrop_Pa)
})

test('invalid route, negative loss remainder, unbracketed friction and hidden fields reject', () => {
  expect(() => checkBalancePath(g, { ...b, headerElevation_m: -30 })).toThrow()
  expect(() => checkBalancePath(g, { ...b, balanceReferenceLoss_Pa: 100 })).toThrow()
  expect(() => checkBalancePath(g, { ...b, dviReferenceLoss_Pa: 100 })).toThrow()
  expect(() => parseBalancePathBasis(record({ ...b, extraWater: 1 }))).toThrow()
  expect(() => parseBalancePathBasis(record({ ...b, Cd: 1.5 }))).toThrow()
  expect(() => parseBalancePathBasis(owner + record(b))).toThrow()
  expect(() => darcyGradient(25, 745, .0001, .2, .19)).toThrow()
  expect(() => darcyGradient(NaN, 745, .0001, .2, .000045)).toThrow()
  expect(darcyGradient(0, 745, .0001, .2, .000045)).toBe(0)
  expect(darcyGradient(-25, 745, .0001, .2, .000045)).toBe(-darcyGradient(25, 745, .0001, .2, .000045))
})

test('friction keeps the selected 2300–4000 transition and signed laminar limit', () => {
  const rho = 1000, mu = .001, diameter = .2, A = Math.PI * diameter ** 2 / 4
  const gradient = (Re: number) => darcyGradient(Re * A * mu / diameter, rho, mu, diameter, .000045)
  for (const Re of [100, 2000, 2200, 2300]) {
    const velocity = Re * mu / (rho * diameter)
    expect(gradient(Re)).toBeCloseTo(32 * mu * velocity / diameter ** 2, 12)
  }
  for (const Re of [2300, 4000]) expect(Math.abs(gradient(Re + .001) - gradient(Re - .001))).toBeLessThan(1e-6)
})

test('local meters replace budgeted loss; density and reversal never use remote head', () => {
  const delivery = { totalLoss_Pa: 20000, referenceFlow_kg_s: 25, bore_m: .2,
    roughness_m: .000045, length_m: 8, checkCrack_Pa: 1000 }
  const observations: Parameters<typeof checkConnectedMeters>[3] = {
    rawDPZeroBound_Pa: 5, rawDPQuantum_Pa: .5,
    meters: [{ name: 'CMT', referenceFlow_kg_s: 25, meterDrop_Pa: 2000, totalReferenceDrop_Pa: 20000 },
      { name: 'DVI', referenceFlow_kg_s: 100, meterDrop_Pa: 1000, totalReferenceDrop_Pa: 10000 }],
  }
  const r = checkConnectedMeters(g, b, delivery, observations)
  for (const allocation of Object.values(r.allocations)) {
    expect(allocation.wall_Pa + allocation.exit_Pa + allocation.meter_Pa + allocation.remainder_Pa).toBeCloseTo(allocation.total_Pa, 10)
    expect(allocation.remainder_Pa).toBeGreaterThan(0)
  }
  expect(r.allocations.CMT.remainder_Pa).toBeCloseTo(17469.387, 2)
  expect(r.allocations.DVI.remainder_Pa).toBeCloseTo(3547.879, 2)
  expect(r.checkCrackingSeparate_Pa).toBe(1000)
  for (const reading of r.readings) {
    expect(reading.irreversiblePower_W).toBeGreaterThanOrEqual(0)
    expect(Math.sign(reading.rawDP_Pa)).toBe(Math.sign(reading.actualFlow_kg_s))
    if (reading.actualFlow_kg_s === 0) expect(reading.direction).toBe('unresolved')
  }
  expect(() => allocateMeterLoss(1000, 200, 500, 300)).toThrow()
  expect(() => allocateMeterLoss(1000, -1, 0, 100)).toThrow()
  expect(() => allocateMeterLoss(NaN, 0, 0, 100)).toThrow()
  expect(() => checkConnectedMeters(g, b, { ...delivery, totalLoss_Pa: 19000 }, observations)).toThrow()
  expect(() => checkConnectedMeters(g, b, delivery, { ...observations, meters: [] })).toThrow()
})
