import { expect, test } from 'bun:test'
import { compileOperatingFeed, feedOwners, heaterSizing, type FeedPages } from './reference-design-operating-feed'

// Test-only owner texts in the shapes the compiler reads; not plant evidence.
const fence = (name: string, body: unknown) => '```' + name + '\n' + JSON.stringify(body) + '\n```\n'
const blocks = {
  cascade: { levelSetpoint: .6, outerProportional: 1, outerIntegral_per_s: .025, requestRange: [0, 1.2], valveBias: .7, valveRange: [0, 1],
    innerProportional: .3, innerIntegral_per_s: .2, sample_s: .1, feedFlowLag_s: .25, feedFlowSpan: [0, 1.5], steamFlowLag_s: .25,
    steamFlowSpan: [0, 1.5], controlChannel: 'LT.NR1', initialMode: 'MANUAL', initialDemandRule: 'sgSteamFlowAtPreparedSgPressure' },
  train: { pumpEye_m: 0, shutoffHeadRatio: 1.25, brakeFactor: 2, motorEfficiency: .96, coastdownScale_s: 5, torqueTracking_s: 3, torqueLimit: 1.5,
    dragFraction: .01, churnFloorFraction: .01, suctionExponent: 2, gasFactorFull: .02, gasFactorZero: .15, caseResidence_s: .05,
    caseConductance_W_K: 2000, branchIsoOutletPressure_MPa: 7, fcvReferenceOpening: .7, fcvStrokePerSecond: .1, isoStroke_s: 2,
    actuatorOpeningPower_W: 100, actuatorHolding_W: 20 },
  pump: { id: 'FW', flow_kg_s: 819.818983, inletPressure_MPa: .101325, inletTemperature_C: 40, outletPressure_MPa: 7.4, receiverPressure_MPa: 6,
    hydraulicEfficiency: .8, npshSpeed_m: 2, npshFlow_m: 3, existingTrainHoldup_m3: 0 },
  signed: { crossCoefficient: .1, crossSensitivity: [0, .1, .2], rpm: 3000, leakAreaFraction: .01 },
  pool: { pressure_Pa: 101325, gravity_m_s2: 9.80665, tankArea_m2: 50, tankFloor_m: -2.4, tankHeight_m: 4, collectionArea_m2: 100, collectionFloor_m: 0,
    weirCoefficient: 1.7, initialTemperature_C: 40, initialLiquidVolume_m3: 120, condensatePort_m: -2.4, ventPort_m: 0, ambientTemperature_C: 25 },
  heaters: { tubeVolume_m3: 10, shellVolume_m3: [20, 25, 30, 40], initialLiquidFraction: .25, wallCapacity_MJ_K: [30, 40, 50, 70],
    extractionPressure_MPa: [.05, .2, .8, 4], tubeOutlet_C: [70, 110, 155, 220], wallMidpointFraction: .5, shellPressureFraction: .995,
    extractionIsoStroke_s: 2, drainTarget: .25, drainNominalOpening: .5, drainGain: 2, drainSample_s: .1, drainStrokePerSecond: .2,
    drainSizingOpening: .5, drainPickupFraction: .05, highLevelAnnunciation: .8, tubeValveStroke_s: 2, inletIsoLoss_kPa: 5, channelLoss_kPa: 40,
    outletIsoLoss_kPa: 5, bypassLoss_kPa: 50, junctionPressure_MPa: [7.4, 7.35, 7.3, 7.25, 7.2], tubePressure_MPa: [7.395, 7.345, 7.295, 7.245],
    actuatorPower_W: 100, electronics_W: 20 },
  condensate: { flow_kg_s: 1639.6379652662608, referenceTemperature_C: 40, referencePressure_Pa: 101325, rpm: 1500, hydraulicEfficiency: .8,
    motorEfficiency: .95, dragFraction: 0, speedDecayScale_s: 2, torqueTracking_s: 3, torqueLimit: 1.5, shutoffHeadRatio: 1.25, flowHeadCoefficient: .25,
    npshSpeed_m: 1, npshFlow_m: 2, eye_m: -5, churnFraction: .01, suctionExponent: 2, gasFactorFull: .02, gasFactorZero: .15, caseResidence_s: .05,
    referenceVelocity_m_s: 2 },
  cycle: { steamPressure_MPaAbs: 6, feedInlet_C: 220, feedPumpDischarge_MPaAbs: 7.4, feedHeaderPressure_MPaAbs: 7.2, feedSourcePressure_MPaAbs: .101325,
    feedPumpHydraulicEfficiency: .8, feedPumpMotorEfficiency: .96, feedPumpDragFraction: .01, condensate_C: 40, condensatePumpHydraulicEfficiency: .8,
    condensatePumpMotorEfficiency: .95, highBleedPressure_MPaAbs: 4, separatorPressure_MPaAbs: .8, lowBleedPressure_MPaAbs: .2,
    lowestBleedPressure_MPaAbs: .05, heaterOutlet_C: [70, 110, 155] },
  level: { nrLag_s: .5, nrSpan_m: [4, 9], indicatedLevelArea_m2: 12 },
  hot: { primaryPressure_Pa: 15200000, sgSecondaryPressure_Pa: 6363140, sgMetalSegments: 4 },
  sg: { steamDemand_kg_s: { A: 819.9495, B: 819.9455 }, steamDonor: 'pickupGas', feedRule: 'inventoryHolding' },
} as const
type Key = keyof typeof feedOwners
function pages(over: Partial<Record<Key, unknown>> = {}): FeedPages {
  const page = (k: Key) => `## ${feedOwners[k].heading}\n\n` + fence(feedOwners[k].fence, over[k] ?? blocks[k])
  // Owners sharing one page carry each block under its own heading.
  const shared = (keys: Key[]) => keys.map(page).join('\n')
  const equipment = shared(['train', 'pump', 'signed'])
  return { cascade: page('cascade'), train: equipment, pump: equipment, signed: equipment, pool: page('pool'), heaters: page('heaters'),
    condensate: page('condensate'), cycle: page('cycle'), level: page('level'), hot: page('hot'), sg: page('sg') }
}
const drop = <T extends object>(o: T, k: keyof T) => Object.fromEntries(Object.entries(o).filter(([key]) => key !== k))

test('compiles the cascade, pumps, heaters and branches from their blocks', () => {
  const s = compileOperatingFeed(pages())
  expect(s.cascade).toMatchObject({ outerProportional: 1, outerIntegral_per_s: .025, innerProportional: .3, innerIntegral_per_s: .2,
    narrowSpan_m: [4, 9], requestRange: [0, 1.2], initialMode: 'MANUAL',
    initialDemand: { rule: 'sgSteamFlowAtPreparedSgPressure', sgPressure_Pa: 6363140, flow_kg_s: { A: 819.9495, B: 819.9455 } } })
  expect(s.feedPump.omega0_rad_s).toBeCloseTo(314.159265358979, 12)
  expect(s.condensatePump.omega0_rad_s).toBeCloseTo(157.079632679490, 12)
  expect(s.heaters.junctionPressure_Pa).toEqual([7.4e6, 7.35e6, 7.3e6, 7.25e6, 7.2e6])
  expect(s.heaters.tubePressure_Pa[0]).toBeCloseTo(7.395e6, 6)
  expect(s.heaters.lossAllocation_Pa).toEqual({ inletIso: 5000, channel: 40000, outletIso: 5000, bypass: 50000 })
  expect(s.branches).toMatchObject({ headerPressure_Pa: 7.2e6, isoOutletPressure_Pa: 7e6, sgReferencePressure_Pa: 6e6, sgPreparedPressure_Pa: 6363140, fcvReferenceOpening: .7 })
  expect(s.tank).toMatchObject({ rim_m: 1.6, pumpEye_m: 0, returnNozzle_m: -2.4 })
  expect(s.branches.feedTemperature_K).toBeCloseTo(493.15, 12)
})

test('refuses every missing cascade gain and a missing value in each owner block', () => {
  for (const k of ['outerProportional', 'outerIntegral_per_s', 'innerProportional', 'innerIntegral_per_s', 'valveBias', 'sample_s'] as const)
    expect(() => compileOperatingFeed(pages({ cascade: drop(blocks.cascade, k) }))).toThrow()
  expect(() => compileOperatingFeed(pages({ train: drop(blocks.train, 'torqueLimit') }))).toThrow()
  expect(() => compileOperatingFeed(pages({ heaters: drop(blocks.heaters, 'channelLoss_kPa') }))).toThrow()
  expect(() => compileOperatingFeed(pages({ condensate: drop(blocks.condensate, 'eye_m') }))).toThrow()
  expect(() => compileOperatingFeed(pages({ pump: drop(blocks.pump, 'outletPressure_MPa') }))).toThrow()
  expect(() => compileOperatingFeed(pages({ level: drop(blocks.level, 'nrSpan_m') }))).toThrow()
  expect(() => compileOperatingFeed(pages({ hot: drop(blocks.hot, 'sgSecondaryPressure_Pa') }))).toThrow()
  expect(() => compileOperatingFeed(pages({ sg: drop(blocks.sg, 'steamDemand_kg_s') }))).toThrow()
  expect(() => compileOperatingFeed(pages({ cascade: { ...drop(blocks.cascade, 'initialDemandRule'), initialDemand: .7 } }))).toThrow()
})

test('refuses extra keys and disagreements between blocks that state one quantity', () => {
  expect(() => compileOperatingFeed(pages({ cascade: { ...blocks.cascade, derivativeGain: 1 } }))).toThrow()
  expect(() => compileOperatingFeed(pages({ heaters: { ...blocks.heaters, tubePressure_MPa: [7.39, 7.345, 7.295, 7.245] } }))).toThrow(/H1 tube pressure/)
  expect(() => compileOperatingFeed(pages({ heaters: { ...blocks.heaters, bypassLoss_kPa: 40 } }))).toThrow(/bypass/)
  expect(() => compileOperatingFeed(pages({ train: { ...blocks.train, motorEfficiency: .95 } }))).toThrow(/FW motor efficiency/)
  expect(() => compileOperatingFeed(pages({ heaters: { ...blocks.heaters, extractionPressure_MPa: [.05, .2, .8, 4.2] } }))).toThrow(/H4 extraction/)
  expect(() => compileOperatingFeed(pages({ train: { ...blocks.train, pumpEye_m: .1 } }))).toThrow(/pump eye/)
  expect(() => compileOperatingFeed(pages({ condensate: { ...blocks.condensate, flow_kg_s: 1600 } }))).toThrow(/COND.P duty/)
  expect(() => compileOperatingFeed(pages({ train: { ...blocks.train, branchIsoOutletPressure_MPa: 7.3 } }))).toThrow(/FCV inlet/)
})

// Test-only cycle outputs in runCycle's shape (rounded fractions; not plant evidence).
const flows = { SG_total_kg_s: 1000, reheat_fraction: .08, high_heater_fraction: .17, separator_heater_fraction: .05, low_heater_fraction: .04,
  lowest_heater_fraction: .02, separator_drain_fraction: .1, condenser_drains_fraction: .46 }
const point = (p: number, h: number) => ({ p_MPaAbs: p, T_C: 0, h_kJ_kg: h, rho_kg_m3: 1 })
const points = { HP_bleed: point(4, 2718.5), LP_bleed: point(.2, 2722.2), LP_lowest_bleed: point(.05, 2521.6) }

test('sizes the heater extractions and the drain cascade from the cycle fractions', () => {
  const s = heaterSizing(flows, points)
  expect(s.extraction_kg_s).toEqual([20, 40, 50, 170])
  expect(s.drainOut_kg_s.map(x => Math.round(x * 1e9) / 1e9)).toEqual([460, 440, 300, 250])
  expect(s.donor[3]).toEqual({ pressure_Pa: 4e6, enthalpy_J_kg: 2718500 })
  expect(s.donor[2]).toBeNull()
})

test('refuses a missing fraction and a cascade that does not reach the condenser drains', () => {
  const { reheat_fraction: _, ...missing } = flows
  expect(() => heaterSizing(missing, points)).toThrow()
  expect(() => heaterSizing({ ...flows, condenser_drains_fraction: .45 }, points)).toThrow(/combined condenser drains/)
})
