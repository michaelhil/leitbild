import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { parseCcwRegulator, parseLowPressureContinuation, parseRhrTrain, parseSiteIntake, parseSupportPreparation, parseSupportRooms, parseSupportStores, parseSupportTrains,
  prepareOperatingSupport, supportOwners } from './reference-design-operating-support'

// Test-only owner texts in the shapes the compiler reads; not plant evidence.
const fence = (name: string, value: unknown) => '```' + name + '\n' + JSON.stringify(value) + '\n```'
const trains = { ccw: { supplyVolume_m3: 250, returnVolume_m3: 200, coolerVolume_m3: 50, exchangerWall_MJ_K: 100, pumpSpeed_rpm: 1500, pumpCoastdown_s: 2,
  supplyDatumPressure_MPa: .5, jackets: { A: ['RCP.A1'], B: ['TG.OIL'] } },
  sw: { pumpSpeed_rpm: 1500, pumpCoastdown_s: 2, exchangerSideVolume_m3: 100, generatorSideVolume_m3: 50, generatorBranchB_kg_s: 1000, branchDrop_MPa: .3,
    outletCellGauge_kPa: 150, outletElevation_m: 5, dischargeElevation_m: 5 },
  generatorCooler: { store_MJ_K: 100, conductance_MW_K: 10 }, drive: { trackingTime_s: 3, torqueCapFactor: 1.5 }, lowPressurePump: { churnFraction: .01 } }
const stores = { rcpMotor_MJ_K: 20, rcpJacket_m3: 5, feedMotor_MJ_K: 10, feedJacket_m3: 1, condensateMotor_MJ_K: 2, chargingMotor_MJ_K: 2, condensateJacket_m3: 1,
  chargingJacket_m3: 1, rhrMotor_MJ_K: 2, rhrMotorAmbient_MW_K: .002, rhrMotorInitial_C: 40, cwMotor_MJ_K: 100, serviceMotor_MJ_K: 2, transformer_MJ_K: 100 }
const rooms = { roomStore_MJ_K: 200, initialA_C: 25.716, initialB_C: 25.634, assessment_C: 40, environmentInvestigation_C: 60 }
const regulator = { sample_s: .2, target_C: 30, proportional_per_K: .05, integral_per_K_s: .005, stroke_per_s: .1, movingDuty_kW: 1 }
const train = { supply_C: 30, return_C: 38.374256975, cooler_C: 21.574936536, wall_C: 21.195460086, serviceWater_C: 20.815983636, bypass: .414143865,
  pumpHead_MPa: .368732083, branchLoss_MPa: .367296361, commonDrop_MPa: .001435722 }
const preparation = { A: train, B: train, plusFiveKelvinGasSpace_m3: 4.156036 }
const rhr = { externalFlow_kg_s: 150, minimumFlow_kg_s: 15, minimumFlowCalibration_MPa: .5, dragFraction: .01, commonSuction: { drop_MPa: .05, flow_kg_s: 300 },
  train: { drop_MPa: .35, fixed_MPa: .05, hx_MPa: .15, fcv_MPa: .15, fcvOpening: .8 }, return_MPa: .1, meter_kPa: 20, isoIn_kPa: 10, isoOut_kPa: 10,
  fixedInTrain_kPa: 10, pumpElevation_m: -2, caseResidence_s: .05, vent: { areaFraction: .0001, referenceVelocity_m_s: 2, stroke_s: 2, outlet_m: -2 },
  regulator: { sample_s: .2, targetMin_C: 40, targetMax_C: 140, proportional_per_K: .02, integral_per_K_s: .005, bypassFlow_kg_s: 150, bypassDrop_MPa: .15,
    stroke_per_s: .1, movingDuty_kW: 1 } }
const intake = { bayArea_m2: 200, floor_m: 0, normalDepth_m: 5, refillLevel_m: 6, floatSpan_m: 1, initialVolume_m3: 1000, initialTemperature_C: 20,
  sourceTemperature_C: 20, sourceCapacity_m3_s: 52.878938608, refillMouth_m: 6, condenserPathDrop_kPa: 300, cwPumpSpeed_rpm: 1500, cwCoastdown_s: 2,
  cwTrackingTime_s: 3, cwTorqueCapFactor: 1.5 }
const continuation = { caseResidence_s: .05, referenceVelocity_m_s: 2, npshSpeed_m: 1, npshFlow_m: 2, gasOnset: .02, gasZeroHead: .15,
  gasZeroHeadSensitivity: [.1, .15, .3], suctionExponent: 2, suctionExponentSensitivity: [1, 2], ventAreaFraction: .0001, ventStroke_s: 2,
  screeningPressure_MPa: 2, screeningTemperature_C: 220, fugacityScaleMax: .02, ventReturn_m: { outfall: 5, condenserReturn: 5, ccwVesselTop: .5 } }
const o = supportOwners
type Over = Partial<Record<'trains' | 'stores' | 'rooms' | 'regulator' | 'preparation' | 'intake' | 'continuation', unknown>>
const thermal = (over: Over = {}) => ['# Owner', '## Compact operating allocation (15 October 2026)', 'Text.',
  `### ${o.trains.heading}`, fence(o.trains.fence, over.trains ?? trains),
  `### ${o.intake.heading}`, fence(o.intake.fence, over.intake ?? intake),
  `### ${o.continuation.heading}`, fence(o.continuation.fence, over.continuation ?? continuation),
  `### ${o.stores.heading}`, fence(o.stores.fence, over.stores ?? stores), fence(o.rooms.fence, over.rooms ?? rooms),
  `### ${o.regulator.heading}`, fence(o.regulator.fence, over.regulator ?? regulator),
  `### ${o.preparation.heading}`, fence(o.preparation.fence, over.preparation ?? preparation), '## Next', ''].join('\n\n')
const shutdown = (value: unknown = rhr) => `# RHR\n\n## ${o.rhr.heading}\n\nText.\n\n${fence(o.rhr.fence, value)}\n`
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key))

test('the C12 blocks parse strictly from their owning sections', () => {
  expect(parseSupportTrains(thermal())).toEqual(trains)
  expect(parseSupportStores(thermal())).toEqual(stores)
  expect(parseSupportRooms(thermal())).toEqual(rooms)
  expect(parseCcwRegulator(thermal())).toEqual(regulator)
  expect(parseSupportPreparation(thermal())).toEqual(preparation)
  expect(parseRhrTrain(shutdown())).toEqual(rhr)
  expect(parseSiteIntake(thermal())).toEqual(intake)
  expect(parseLowPressureContinuation(thermal())).toEqual(continuation)
})

test('the compiler refuses a missing value in every C12 block', () => {
  expect(() => parseSupportTrains(thermal({ trains: { ...trains, ccw: without(trains.ccw, 'exchangerWall_MJ_K') } }))).toThrow()
  expect(() => parseSupportTrains(thermal({ trains: without(trains, 'drive') }))).toThrow()
  expect(() => parseSupportStores(thermal({ stores: without(stores, 'rcpMotor_MJ_K') }))).toThrow()
  expect(() => parseSupportRooms(thermal({ rooms: without(rooms, 'roomStore_MJ_K') }))).toThrow()
  expect(() => parseCcwRegulator(thermal({ regulator: without(regulator, 'integral_per_K_s') }))).toThrow()
  expect(() => parseSupportPreparation(thermal({ preparation: { ...preparation, B: without(train, 'wall_C') } }))).toThrow()
  expect(() => parseRhrTrain(shutdown(without(rhr, 'minimumFlow_kg_s')))).toThrow()
  expect(() => parseSiteIntake(thermal({ intake: without(intake, 'sourceCapacity_m3_s') }))).toThrow()
  expect(() => parseLowPressureContinuation(thermal({ continuation: without(continuation, 'npshFlow_m') }))).toThrow()
  expect(() => parseRhrTrain(shutdown({ ...rhr, vent: without(rhr.vent, 'outlet_m') }))).toThrow()
  expect(() => parseRhrTrain(shutdown({ ...rhr, regulator: without(rhr.regulator, 'bypassDrop_MPa') }))).toThrow()
})

test('the compiler refuses extra keys, wrong signs, misplaced or duplicated blocks', () => {
  expect(() => parseSupportTrains(thermal({ trains: { ...trains, extra: 1 } }))).toThrow()
  expect(() => parseSupportStores(thermal({ stores: { ...stores, feedJacket_m3: -1 } }))).toThrow()
  expect(() => parseSupportRooms(thermal({ rooms: { ...rooms, assessment_C: 70 } }))).toThrow('investigation')
  expect(() => parseSupportPreparation(thermal({ preparation: { ...preparation, A: { ...train, bypass: 1.2 } } }))).toThrow()
  expect(() => parseCcwRegulator(thermal().replace(`### ${o.regulator.heading}`, '### Elsewhere'))).toThrow()
  expect(() => parseCcwRegulator(thermal() + '\n' + fence(o.regulator.fence, regulator))).toThrow()
  expect(() => parseRhrTrain(shutdown({ ...rhr, regulator: { ...rhr.regulator, targetMin_C: 150 } }))).toThrow('ordered')
  expect(() => parseSiteIntake(thermal({ intake: { ...intake, floatSpan_m: .5 } }))).toThrow('float')
  expect(() => parseLowPressureContinuation(thermal({ continuation: { ...continuation, gasZeroHead: .2 } }))).toThrow('sensitivity')
})

const wiki = process.env.LD01_C12_WIKI_ROOT, python = process.env.LD01_RESEARCH_PYTHON, archive = process.env.LD01_WIKI_ROOT
test.skipIf(!wiki || !python)('the actual owners compile; the printed preparation is the calculator\'s and the S5 trains reproduce it', async () => {
  const p = await prepareOperatingSupport(wiki!, python!)
  const [A, B] = p.s5.trains
  expect(A!.ccw.jackets.map(j => j.id)).toEqual(['RCP.A1', 'RCP.B1', 'FW.P1', 'COND.P', 'CHARGE.P'])
  expect(B!.ccw.jackets.map(j => j.id)).toEqual(['RCP.A2', 'RCP.B2', 'FW.P2', 'TG.OIL'])
  expect(p.s5.constants.displacedVolumeBound_m3).toBeCloseTo(.843964, 12)
  // CCW pump: Pfluid0 = 0.6 m3/s * 0.30 MPa / 0.8; J = Pfluid0 * 2 s / omega0^2
  expect(A!.ccw.pump.fluidPower0_W).toBeCloseTo(225000, 6)
  expect(A!.ccw.pump.inertia_kg_m2).toBeCloseTo(225000 * 2 / (50 * Math.PI) ** 2, 9)
  expect(B!.sw.pump.dragPower0_W).toBeCloseTo(11250, 6)
  // the owner's outdoor motor preparation: CCW.A/B 25.546/27.552, SW.A/B 52.926/66.888 C
  expect(A!.ccw.motor.initial_K - 273.15).toBeCloseTo(25.546, 3)
  expect(B!.ccw.motor.initial_K - 273.15).toBeCloseTo(27.552, 3)
  expect(A!.sw.motor.initial_K - 273.15).toBeCloseTo(52.926, 3)
  expect(B!.sw.motor.initial_K - 273.15).toBeCloseTo(66.888, 3)
  expect(B!.sw.paths.map(q => [q.id, q.reference_kg_s])).toEqual([['HX', 2000], ['GEN', 1000]])
  expect(p.s5.oil.coolerCapacity_J_K).toBe(170000)
  // CW: each pump carries half the combined reference; the owner's CW motor preparation is about 42.603 C
  expect(p.s5.circulating.pump.referenceFlow_kg_s).toBeCloseTo(47878.938608 / 2, 6)
  expect(p.s5.circulating.motor.initial_K - 273.15).toBeCloseTo(42.603, 3)
  expect(p.s5.intake.initialVolume_m3 / p.s5.intake.area_m2).toBe(p.s5.intake.normalDepth_m)
  expect(p.provenance.consumed).toHaveLength(6)
}, 120000)
test.skipIf(!archive || !python)('the unpatched archive refuses: it has no C12 allocation blocks', async () => {
  await expect(prepareOperatingSupport(archive!, python!)).rejects.toThrow()
}, 120000)
test.skipIf(!wiki)('every C12 block value is verbatim in its owner page', async () => {
  const page = await Bun.file(join(wiki!, 'world/packs/process-plant/reference-designs/ld-01/systems/support-services/thermal-water-and-air.md')).text()
  expect(parseSupportTrains(page).ccw.jackets.B).toEqual(['RCP.A2', 'RCP.B2', 'FW.P2', 'TG.OIL'])
  expect(parseCcwRegulator(page)).toEqual(regulator)
})
