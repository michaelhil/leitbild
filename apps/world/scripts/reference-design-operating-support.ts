/** C12 support packet (Gate 1 design lane, 15 Oct 2026): CCW/SW trains for the
 * S5 compact reduction and the S7 extension's strict values, from the owners'
 * strict wiki blocks, unchanged or derived by stated arithmetic. Rust owns
 * every law; this compiler reads, checks and composes. Nothing is defaulted.
 *
 * - `ld01-support-trains`, `ld01-support-stores`, `ld01-support-rooms`,
 *   `ld01-ccw-regulator`, `ld01-support-preparation`, `ld01-site-intake` (thermal-water-and-air.md,
 *   "Compact operating allocation (15 October 2026)");
 * - `ld01-rhr-train` (shutdown-cooling.md, same heading);
 * - existing strict blocks reused only here: `reference-station` (pump heads,
 *   efficiencies, drag, rated flows, site/ambient, motor conductances, rooms),
 *   `reference-support-network` (sizing drops, jacket and exchanger
 *   conductances), `reference-lubrication` (oil pair, jacket volume),
 *   `reference-ccw-expansion` (vessel volumes), `reference-feed-pool` (g),
 *   `reference-letdown-cooling-branch` (CW combined reference, letdown branch).
 *
 * The prepared state comes from the named calculator `runPrimaryStation` (the
 * owner's "same frozen station preparation"); the printed preparation block
 * must agree with it to its printed digits, else compilation refuses.
 * Usage: bun reference-design-operating-support.ts <wiki root> <research-python> <packet.json> */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { parseExpansion } from './reference-design-ccw-expansion'
import { parseLetdownCoolingBranch } from './reference-design-letdown-cooling-branch'
import { lubricationParameters, parseLubrication } from './reference-design-lubrication'
import { ownedBlock } from './reference-design-operating-pzr'
import { runPrimaryStation } from './reference-design-primary-station'
import { parseStationBasis } from './reference-design-station'
import { parseSupportBasis } from './reference-design-support-network'

const LD01 = 'world/packs/process-plant/reference-designs/ld-01/'
const allocation = 'Compact operating allocation (15 October 2026)'
export const supportOwners = {
  trains: { page: 'systems/support-services/thermal-water-and-air.md', heading: 'Train hardware', fence: 'ld01-support-trains' },
  stores: { page: 'systems/support-services/thermal-water-and-air.md', heading: 'Motor, jacket and room stores', fence: 'ld01-support-stores' },
  rooms: { page: 'systems/support-services/thermal-water-and-air.md', heading: 'Motor, jacket and room stores', fence: 'ld01-support-rooms' },
  regulator: { page: 'systems/support-services/thermal-water-and-air.md', heading: 'CCW temperature-regulator block', fence: 'ld01-ccw-regulator' },
  preparation: { page: 'systems/support-services/thermal-water-and-air.md', heading: 'Prepared support state', fence: 'ld01-support-preparation' },
  intake: { page: 'systems/support-services/thermal-water-and-air.md', heading: 'Intake bay and circulating water', fence: 'ld01-site-intake' },
  continuation: { page: 'systems/support-services/thermal-water-and-air.md', heading: 'Low-pressure continuation block (S7)', fence: 'ld01-low-pressure-continuation' },
  rhr: { page: 'systems/primary-coolant/shutdown-cooling.md', heading: allocation, fence: 'ld01-rhr-train' },
} as const
export const supportPages = {
  thermal: 'systems/support-services/thermal-water-and-air.md',
  shutdown: 'systems/primary-coolant/shutdown-cooling.md',
  station: 'model/station-balance.md',
  lubrication: 'systems/steam-power/lubrication-and-turning.md',
  feed: 'systems/feedwater/index.md',
  condenser: 'systems/steam-power/condenser-and-cooling.md',
} as const
export type SupportPages = Record<keyof typeof supportPages, string>

const positive = z.number().finite().positive()
const temperature = z.number().finite()
const trainsSchema = z.object({
  ccw: z.object({ supplyVolume_m3: positive, returnVolume_m3: positive, coolerVolume_m3: positive, exchangerWall_MJ_K: positive,
    pumpSpeed_rpm: positive, pumpCoastdown_s: positive, supplyDatumPressure_MPa: positive,
    jackets: z.object({ A: z.array(z.string().min(1)).min(1), B: z.array(z.string().min(1)).min(1) }).strict() }).strict(),
  sw: z.object({ pumpSpeed_rpm: positive, pumpCoastdown_s: positive, exchangerSideVolume_m3: positive, generatorSideVolume_m3: positive,
    generatorBranchB_kg_s: positive, branchDrop_MPa: positive, outletCellGauge_kPa: positive, outletElevation_m: z.number().finite(),
    dischargeElevation_m: z.number().finite() }).strict(),
  generatorCooler: z.object({ store_MJ_K: positive, conductance_MW_K: positive }).strict(),
  drive: z.object({ trackingTime_s: positive, torqueCapFactor: positive }).strict(),
  lowPressurePump: z.object({ churnFraction: positive.lt(1) }).strict(),
}).strict()
const storesSchema = z.object({ rcpMotor_MJ_K: positive, rcpJacket_m3: positive, feedMotor_MJ_K: positive, feedJacket_m3: positive,
  condensateMotor_MJ_K: positive, chargingMotor_MJ_K: positive, condensateJacket_m3: positive, chargingJacket_m3: positive,
  rhrMotor_MJ_K: positive, rhrMotorAmbient_MW_K: positive, rhrMotorInitial_C: temperature, cwMotor_MJ_K: positive,
  serviceMotor_MJ_K: positive, transformer_MJ_K: positive }).strict()
const roomsSchema = z.object({ roomStore_MJ_K: positive, initialA_C: temperature, initialB_C: temperature, assessment_C: temperature,
  environmentInvestigation_C: temperature }).strict()
  .refine(r => r.assessment_C < r.environmentInvestigation_C, 'Room assessment precedes the investigation boundary')
const regulatorSchema = z.object({ sample_s: positive, target_C: temperature, proportional_per_K: positive, integral_per_K_s: positive,
  stroke_per_s: positive, movingDuty_kW: positive }).strict()
const trainPreparation = z.object({ supply_C: temperature, return_C: temperature, cooler_C: temperature, wall_C: temperature,
  serviceWater_C: temperature, bypass: z.number().finite().min(0).max(1), pumpHead_MPa: positive, branchLoss_MPa: positive,
  commonDrop_MPa: positive }).strict()
const preparationSchema = z.object({ A: trainPreparation, B: trainPreparation, plusFiveKelvinGasSpace_m3: positive }).strict()
const rhrSchema = z.object({ externalFlow_kg_s: positive, minimumFlow_kg_s: positive, minimumFlowCalibration_MPa: positive, dragFraction: positive.lt(1),
  commonSuction: z.object({ drop_MPa: positive, flow_kg_s: positive }).strict(),
  train: z.object({ drop_MPa: positive, fixed_MPa: positive, hx_MPa: positive, fcv_MPa: positive, fcvOpening: positive.max(1) }).strict(),
  return_MPa: positive, meter_kPa: positive, isoIn_kPa: positive, isoOut_kPa: positive, fixedInTrain_kPa: positive,
  pumpElevation_m: z.number().finite(), caseResidence_s: positive,
  vent: z.object({ areaFraction: positive, referenceVelocity_m_s: positive, stroke_s: positive, outlet_m: z.number().finite() }).strict(),
  regulator: z.object({ sample_s: positive, targetMin_C: temperature, targetMax_C: temperature, proportional_per_K: positive, integral_per_K_s: positive,
    bypassFlow_kg_s: positive, bypassDrop_MPa: positive, stroke_per_s: positive, movingDuty_kW: positive }).strict()
    .refine(r => r.targetMin_C < r.targetMax_C, 'RHR target band must be ordered'),
}).strict()
const intakeSchema = z.object({ bayArea_m2: positive, floor_m: z.number().finite(), normalDepth_m: positive, refillLevel_m: positive, floatSpan_m: positive,
  initialVolume_m3: positive, initialTemperature_C: temperature, sourceTemperature_C: temperature, sourceCapacity_m3_s: positive, refillMouth_m: z.number().finite(),
  condenserPathDrop_kPa: positive, cwPumpSpeed_rpm: positive, cwCoastdown_s: positive, cwTrackingTime_s: positive, cwTorqueCapFactor: positive }).strict()
  .refine(b => b.normalDepth_m < b.refillLevel_m && b.refillLevel_m - b.floatSpan_m <= b.normalDepth_m, 'The float must open fully at or above the normal level')
const continuationSchema = z.object({ caseResidence_s: positive, referenceVelocity_m_s: positive, npshSpeed_m: positive, npshFlow_m: positive,
  gasOnset: positive.lt(1), gasZeroHead: positive.lt(1), gasZeroHeadSensitivity: z.array(positive.lt(1)).min(1), suctionExponent: positive,
  suctionExponentSensitivity: z.array(positive).min(1), ventAreaFraction: positive.lt(1), ventStroke_s: positive, screeningPressure_MPa: positive,
  screeningTemperature_C: temperature, fugacityScaleMax: positive,
  ventReturn_m: z.object({ outfall: z.number().finite(), condenserReturn: z.number().finite(), ccwVesselTop: z.number().finite() }).strict() }).strict()
  .refine(c => c.gasOnset < c.gasZeroHead && c.gasZeroHeadSensitivity.includes(c.gasZeroHead) && c.suctionExponentSensitivity.includes(c.suctionExponent),
    'Gas onset precedes zero head, and the selected values lie in their sensitivity sets')
const feedPoolSchema = z.object({ gravity_m_s2: positive }).passthrough()

const parse = <T extends z.ZodTypeAny>(schema: T, page: string, o: { heading: string, fence: string }): z.infer<T> =>
  schema.parse(ownedBlock(page, o.heading, o.fence))
export const parseSupportTrains = (thermal: string) => parse(trainsSchema, thermal, supportOwners.trains)
export const parseSupportStores = (thermal: string) => parse(storesSchema, thermal, supportOwners.stores)
export const parseSupportRooms = (thermal: string) => parse(roomsSchema, thermal, supportOwners.rooms)
export const parseCcwRegulator = (thermal: string) => parse(regulatorSchema, thermal, supportOwners.regulator)
export const parseSupportPreparation = (thermal: string) => parse(preparationSchema, thermal, supportOwners.preparation)
export const parseRhrTrain = (shutdown: string) => parse(rhrSchema, shutdown, supportOwners.rhr)
export const parseSiteIntake = (thermal: string) => parse(intakeSchema, thermal, supportOwners.intake)
export const parseLowPressureContinuation = (thermal: string) => parse(continuationSchema, thermal, supportOwners.continuation)
function parseFeedPool(feed: string) {
  const blocks = [...feed.matchAll(/^```reference-feed-pool\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-feed-pool block')
  return feedPoolSchema.parse(JSON.parse(blocks[0]![1]!))
}

/** The calculator's per-train preparation, as `runPrimaryStation` returns it (the fields read here). */
export type PreparedBranch = { id: string, heat_MW: number, reference_kg_s: number, conductance_MW_K: number, flow_kg_s: number, outlet_C: number, metal_C: number }
export type PreparedTrain = { bypass: number, flow_kg_s: number, head_MPa: number, localDrop_MPa: number, commonDrop_MPa: number, hxFlow_kg_s: number,
  temperatures_C: { supply: number, return: number, coolerOutlet: number, wall: number, swOutlet: number }, branches: PreparedBranch[] }
export type StationPreparation = { A: PreparedTrain, B: PreparedTrain, generatorLoss_MW: number, swFluid_MW: { A: number, B: number },
  motorAndDrag_MW: { CCW_A: number, CCW_B: number, SWA: number, SWB: number, CW: number } }

/** Agreement to the printed digits: |a-b| below half a unit of the printed last place. */
function printedAgreement(name: string, printed: number, computed: number) {
  const text = String(printed), decimals = text.includes('.') ? text.split('.')[1]!.length : 0
  if (!(Math.abs(printed - computed) <= 0.5 * 10 ** -decimals + 1e-15)) throw Error(`${name}: printed ${printed} disagrees with the calculator's ${computed}`)
}

const MW = 1e6, MPa = 1e6, kelvin = (c: number) => c + 273.15

/** The pure compilation over the owners' texts and the calculator's preparation. */
export function compileOperatingSupport(pages: SupportPages, prepared: StationPreparation) {
  const trains = parseSupportTrains(pages.thermal), stores = parseSupportStores(pages.thermal), rooms = parseSupportRooms(pages.thermal)
  const regulator = parseCcwRegulator(pages.thermal), preparation = parseSupportPreparation(pages.thermal), rhr = parseRhrTrain(pages.shutdown)
  const station = parseStationBasis(pages.station), network = parseSupportBasis(pages.thermal), oil = parseLubrication(pages.lubrication)
  const record = parseExpansion(pages.thermal), { gravity_m_s2: g } = parseFeedPool(pages.feed)
  // parseExpansion has checked every field; name the ones read here
  const field = (k: string) => { const v = record[k]; if (v === undefined) throw Error(`reference-ccw-expansion lacks ${k}`); return v }
  const vessel = { ...record, floor_m: field('floor_m'), vesselVolume_m3: field('vesselVolume_m3'), area_m2: field('area_m2'),
    initialLiquid_m3: field('initialLiquid_m3'), referenceOutfallPressure_Pa: field('referenceOutfallPressure_Pa') }
  const intake = parseSiteIntake(pages.thermal), letdown = parseLetdownCoolingBranch(pages.condenser), continuation = parseLowPressureContinuation(pages.thermal)
  if (continuation.ventReturn_m.ccwVesselTop !== vessel.floor_m + vessel.vesselVolume_m3 / vessel.area_m2) throw Error('CCW vents return to the vessel top')
  if (letdown.gravity_m_s2 !== g || letdown.cwReferenceDensity_kg_m3 !== station.waterDensity_kg_m3) throw Error('Gravity or sizing density differs between owners')
  if (intake.cwPumpSpeed_rpm !== trains.ccw.pumpSpeed_rpm) throw Error('CW pumps share the selected 1500 rpm')
  if (letdown.outfall_m !== trains.sw.dischargeElevation_m || intake.floor_m !== letdown.takeoff_m) throw Error('Outfall and datum differ between owners')
  if (trains.ccw.pumpSpeed_rpm !== trains.sw.pumpSpeed_rpm) throw Error('CCW and SW pumps share one selected speed')
  if (network.jacket_MW_K.oil * MW !== oil.coolerConductance_W_K) throw Error('Oil jacket conductance differs between its two owners')
  if (rhr.train.fixed_MPa + rhr.train.hx_MPa + rhr.train.fcv_MPa !== rhr.train.drop_MPa) throw Error('RHR train allocation does not sum to its drop')
  if (Math.abs(rhr.commonSuction.drop_MPa + rhr.train.drop_MPa + rhr.return_MPa - 0.5) > 1e-12 || rhr.isoIn_kPa + rhr.isoOut_kPa + rhr.fixedInTrain_kPa + rhr.meter_kPa !== rhr.train.fixed_MPa * 1000)
    throw Error('RHR friction allocation does not close on its pressure rise')
  const omega0 = trains.ccw.pumpSpeed_rpm * 2 * Math.PI / 60, rho0 = station.waterDensity_kg_m3, atmosphere = vessel.referenceOutfallPressure_Pa
  const displacedBound = vessel.vesselVolume_m3 - vessel.initialLiquid_m3 - preparation.plusFiveKelvinGasSpace_m3
  if (!(displacedBound > 0)) throw Error('The +5 K comparison must leave a positive displaced volume')

  const pump = (head_MPa: number, flow_kg_s: number, etaH: number, etaM: number, drag: number, coastdown_s: number,
    tracking_s = trains.drive.trackingTime_s, capFactor = trains.drive.torqueCapFactor) => {
    const fluid0 = flow_kg_s / rho0 * head_MPa * MPa / etaH, drag0 = drag * fluid0
    return { omega0_rad_s: omega0, referenceFlow_kg_s: flow_kg_s, referenceHead_Pa: head_MPa * MPa, referenceDensity_kg_m3: rho0,
      hydraulicEfficiency: etaH, motorEfficiency: etaM, fluidPower0_W: fluid0, dragPower0_W: drag0,
      inertia_kg_m2: (fluid0 + drag0) * coastdown_s / omega0 ** 2, trackingTime_s: tracking_s,
      torqueCap_N_m: capFactor * (fluid0 + drag0) / omega0, churnFraction: trains.lowPressurePump.churnFraction }
  }
  const jacketStore = (id: string) => id.startsWith('RCP.') ? { volume_m3: stores.rcpJacket_m3, metal_J_K: stores.rcpMotor_MJ_K * MW }
    : id.startsWith('FW.P') ? { volume_m3: stores.feedJacket_m3, metal_J_K: stores.feedMotor_MJ_K * MW }
    : id === 'COND.P' ? { volume_m3: stores.condensateJacket_m3, metal_J_K: stores.condensateMotor_MJ_K * MW }
    : id === 'CHARGE.P' ? { volume_m3: stores.chargingJacket_m3, metal_J_K: stores.chargingMotor_MJ_K * MW }
    : id === 'TG.OIL' ? { volume_m3: oil.waterVolume_m3, metal_J_K: null }
    : (() => { throw Error(`No selected store for jacket ${id}`) })()
  const swRef = { A: station.SW.flowA_kg_s, B: station.SW.flowB_kg_s }
  const compileTrain = (id: 'A' | 'B') => {
    const p = preparation[id], c = prepared[id], members = trains.ccw.jackets[id]
    // the printed preparation is the calculator's, to its printed digits
    printedAgreement(`${id}.supply_C`, p.supply_C, c.temperatures_C.supply); printedAgreement(`${id}.return_C`, p.return_C, c.temperatures_C.return)
    printedAgreement(`${id}.cooler_C`, p.cooler_C, c.temperatures_C.coolerOutlet); printedAgreement(`${id}.wall_C`, p.wall_C, c.temperatures_C.wall)
    printedAgreement(`${id}.serviceWater_C`, p.serviceWater_C, c.temperatures_C.swOutlet); printedAgreement(`${id}.bypass`, p.bypass, c.bypass)
    printedAgreement(`${id}.pumpHead_MPa`, p.pumpHead_MPa, c.head_MPa); printedAgreement(`${id}.branchLoss_MPa`, p.branchLoss_MPa, c.localDrop_MPa)
    printedAgreement(`${id}.commonDrop_MPa`, p.commonDrop_MPa, c.commonDrop_MPa)
    if (c.branches.map(b => b.id).join() !== members.join()) throw Error(`Train ${id} jacket membership differs from the calculator's`)
    const supplyP = trains.ccw.supplyDatumPressure_MPa * MPa, head = c.head_MPa * MPa, common = c.commonDrop_MPa * MPa
    const sumReference = c.branches.reduce((s, b) => s + b.reference_kg_s, 0)
    const swPaths = id === 'A' ? [{ id: 'HX', reference_kg_s: network.serviceExchangerFlow_kg_s, volume_m3: trains.sw.exchangerSideVolume_m3 }]
      : [{ id: 'HX', reference_kg_s: network.serviceExchangerFlow_kg_s, volume_m3: trains.sw.exchangerSideVolume_m3 },
        { id: 'GEN', reference_kg_s: trains.sw.generatorBranchB_kg_s, volume_m3: trains.sw.generatorSideVolume_m3 }]
    if (swPaths.reduce((s, q) => s + q.reference_kg_s, 0) !== swRef[id]) throw Error(`SW.${id} paths do not sum to its pump reference`)
    const swGauge = trains.sw.outletCellGauge_kPa * 1000
    const genWater = id === 'B' ? station.siteWater_C + (prepared.swFluid_MW.B * MW / swRef.B + prepared.generatorLoss_MW * MW / trains.sw.generatorBranchB_kg_s) / station.waterCp_J_kgK : null
    const motor = (loss_MW: number) => ({ capacity_J_K: stores.serviceMotor_MJ_K * MW, ambientConductance_W_K: station.serviceMotorEach_MW_K * MW,
      initial_K: kelvin(station.ambient_C + loss_MW / station.serviceMotorEach_MW_K) })
    return {
      id,
      ccw: {
        pump: pump(station.CCW.head_MPa, station.CCW.ratedFlow_kg_s, station.CCW.hydraulicEfficiency, station.CCW.motorEfficiency, station.CCW.dragFraction, trains.ccw.pumpCoastdown_s),
        motor: motor(id === 'A' ? prepared.motorAndDrag_MW.CCW_A : prepared.motorAndDrag_MW.CCW_B),
        network: { localK_Pa_per_kg2_s2: network.localDesignDrop_MPa * MPa / sumReference ** 2,
          coolerFixed_Pa: network.coolerFixedDrop_MPa * MPa, coolerValve_Pa: network.coolerValveDrop_MPa * MPa,
          bypassFixed_Pa: network.bypassFixedDrop_MPa * MPa, bypassValve_Pa: network.bypassValveDrop_MPa * MPa },
        cells: {
          supply: { volume_m3: trains.ccw.supplyVolume_m3, pressure_Pa: supplyP, initial_K: kelvin(p.supply_C) },
          return: { volume_m3: trains.ccw.returnVolume_m3, pressure_Pa: supplyP + common, initial_K: kelvin(p.return_C) },
          cooler: { volume_m3: trains.ccw.coolerVolume_m3, pressure_Pa: supplyP, initial_K: kelvin(p.cooler_C) },
        },
        wall: { capacity_J_K: trains.ccw.exchangerWall_MJ_K * MW, ccwConductance_W_K: network.exchangerSide_MW_K * MW,
          swConductance_W_K: network.exchangerSide_MW_K * MW, initial_K: kelvin(p.wall_C) },
        bypass: { initial: p.bypass, stroke_per_s: regulator.stroke_per_s, movingDuty_W: regulator.movingDuty_kW * 1000 },
        jackets: c.branches.map(b => {
          const s = jacketStore(b.id)
          return { id: b.id, reference_kg_s: b.reference_kg_s, conductance_W_K: b.conductance_MW_K * MW, volume_m3: s.volume_m3,
            pressure_Pa: supplyP + (head + common) / 2, initial_K: kelvin(b.outlet_C), metalCapacity_J_K: s.metal_J_K,
            metalInitial_K: kelvin(b.metal_C), preparedHeat_W: b.heat_MW * MW }
        }),
        prepared: { flow_kg_s: c.flow_kg_s, coolerFlow_kg_s: c.hxFlow_kg_s, head_Pa: head },
      },
      sw: {
        pump: pump(station.SW.head_MPa, swRef[id], station.SW.hydraulicEfficiency, station.SW.motorEfficiency, station.SW.dragFraction, trains.sw.pumpCoastdown_s),
        motor: motor(id === 'A' ? prepared.motorAndDrag_MW.SWA : prepared.motorAndDrag_MW.SWB),
        // parallel outlet paths each sized to branchDrop at its own reference flow
        paths: swPaths.map(q => ({ ...q, resistance_Pa_per_kg2_s2: trains.sw.branchDrop_MPa * MPa / q.reference_kg_s ** 2,
          pressure_Pa: atmosphere + swGauge, elevation_m: trains.sw.outletElevation_m,
          initial_K: kelvin(q.id === 'HX' ? p.serviceWater_C : genWater!) })),
        dischargeElevation_m: trains.sw.dischargeElevation_m,
      },
    }
  }
  const B = prepared.B.branches.find(b => b.id === 'TG.OIL')
  if (!B) throw Error('CCW.B has no TG.OIL jacket')
  const coolerCapacity = oil.coolerOilVolume_m3 * oil.density_kg_m3 * oil.heatCapacity_J_kg_K
  const generatorWater_C = station.siteWater_C + (prepared.swFluid_MW.B * MW / swRef.B + prepared.generatorLoss_MW * MW / trains.sw.generatorBranchB_kg_s) / station.waterCp_J_kgK
  return {
    scope: 'C12 Gate 1: S5 compact support reduction (both trains) and S7 strict values; NOT joined, NOT a gate',
    s5: {
      constants: { gravity_m_s2: g, atmosphere_Pa: atmosphere, referenceDensity_kg_m3: rho0, displacedVolumeBound_m3: displacedBound },
      trains: [compileTrain('A'), compileTrain('B')],
      oil: { density_kg_m3: oil.density_kg_m3, heatCapacity_J_kg_K: oil.heatCapacity_J_kg_K, bulkCapacity_J_K: oil.combinedCapacity_J_K - coolerCapacity,
        coolerCapacity_J_K: coolerCapacity, coolerConductance_W_K: oil.coolerConductance_W_K,
        // identical split of the prepared aggregate oil temperature (lubrication owner)
        initial_K: kelvin(B.metal_C) },
      generatorCooler: { conductance_W_K: trains.generatorCooler.conductance_MW_K * MW, storeCapacity_J_K: trains.generatorCooler.store_MJ_K * MW },
      /** The lube circuit's hydraulics (C12-D4), from the lubrication owner's
       * calculator over `reference-lubrication`: frozen pump coefficients, the
       * series orifice and laminar return, the drives. */
      lube: (() => {
        const L = lubricationParameters(oil)
        const drive = (k: 'main' | 'standby', gain: number, cap: number, inertia: number, energized: number) => ({
          a: L[k].a, beta: L[k].beta, resistance: L[k].resistance, dragCoefficient_N_m_s: L[k].drag, torque0_N_m: L[k].torqueReference,
          gain_N_m_s: gain, torqueLimit_N_m: cap, inertia_kg_m2: inertia, energizedLoss_W: energized, referenceFlow_m3_s: L[k].flow })
        return { omega0_rad_s: oil.pumpSpeed_rad_s, orificeArea_m2: L.orificeArea, laminarResistance_Pa_s_m3: L.laminarResistance,
          viscosityReference_K: oil.viscosityReference_K, viscositySlope_per_K: oil.viscositySlope_K_inverse, motorEfficiency: oil.motorEfficiency,
          main: drive('main', oil.mainDriveGain_N_m_per_rad_s, oil.mainTorqueLimit_N_m, oil.mainInertia_kg_m2, oil.mainEnergizedLoss_W),
          standby: drive('standby', oil.standbyDriveGain_N_m_per_rad_s, oil.standbyTorqueLimit_N_m, oil.standbyInertia_kg_m2, oil.standbyEnergizedLoss_W) }
      })(),
      intake: { area_m2: intake.bayArea_m2, floor_m: intake.floor_m, refillLevel_m: intake.refillLevel_m, floatSpan_m: intake.floatSpan_m,
        refillMouth_m: intake.refillMouth_m, sourceCapacity_m3_s: intake.sourceCapacity_m3_s, initialVolume_m3: intake.initialVolume_m3,
        initial_K: kelvin(intake.initialTemperature_C), normalDepth_m: intake.normalDepth_m },
      circulating: {
        // two equal parallel pumps on the combined reference; each pump carries half
        pump: pump(station.CW.head_MPa, letdown.cwReference_m3_s * rho0 / 2, station.CW.hydraulicEfficiency, station.CW.motorEfficiency, station.CW.dragFraction,
          intake.cwCoastdown_s, intake.cwTrackingTime_s, intake.cwTorqueCapFactor),
        buses: ['AC.A', 'AC.B'],
        motor: { capacity_J_K: stores.cwMotor_MJ_K * MW, ambientConductance_W_K: station.CWmotorEach_MW_K * MW,
          initial_K: kelvin(station.ambient_C + prepared.motorAndDrag_MW.CW / 2 / station.CWmotorEach_MW_K) },
        // both paths sized on their residual head after the common lift
        condenserK_Pa_per_kg2_s2: intake.condenserPathDrop_kPa * 1000 / (letdown.cwReference_m3_s * rho0) ** 2,
        letdown: { referenceFlow_kg_s: letdown.referenceFlow_kg_s, referenceHead_Pa: letdown.referenceHead_Pa },
        dischargeElevation_m: letdown.outfall_m,
      },
      regulator: { sample_s: regulator.sample_s, target_K: kelvin(regulator.target_C), proportional_per_K: regulator.proportional_per_K, integral_per_K_s: regulator.integral_per_K_s },
      /** Port values at the prepared state; each neighbour supplies the live value (port table P1-P16). */
      ports: {
        motorHeat_W: Object.fromEntries([...prepared.A.branches, ...prepared.B.branches].filter(b => b.id !== 'TG.OIL').map(b => [b.id, b.heat_MW * MW])),
        oilHeat_W: B.heat_MW * MW,
        // the main oil pump's acquired encoder speed is C16's acquisition (its lag,
        // sampling and resolution are prose only today); the prepared value here
        // is the reference speed the drive tracks
        oilSpeedAcquired_rad_s: oil.pumpSpeed_rad_s,
        generatorMetal_K: kelvin(generatorWater_C + prepared.generatorLoss_MW / trains.generatorCooler.conductance_MW_K),
        source_K: kelvin(intake.sourceTemperature_C),
        sourceCapacity_m3_s: intake.sourceCapacity_m3_s,
        ambient_K: kelvin(station.ambient_C),
      },
    },
    s7: {
      rooms: { capacity_J_K: rooms.roomStore_MJ_K * MW, initial_K: { A: kelvin(rooms.initialA_C), B: kelvin(rooms.initialB_C) },
        airFlow_kg_s: station.roomAirEach_kg_s, airCp_J_kg_K: station.airCp_J_kgK, fan_W: station.fanEach_kW * 1000,
        wallConductance_W_K: station.roomWallEach_MW_K * MW, assessment_K: kelvin(rooms.assessment_C), investigation_K: kelvin(rooms.environmentInvestigation_C) },
      outdoorStores: { cwMotor: { capacity_J_K: stores.cwMotor_MJ_K * MW, conductance_W_K: station.CWmotorEach_MW_K * MW },
        transformer: { capacity_J_K: stores.transformer_MJ_K * MW, conductance_W_K: station.transformerEach_MW_K * MW } },
      rhrMotor: { capacity_J_K: stores.rhrMotor_MJ_K * MW, ambientConductance_W_K: stores.rhrMotorAmbient_MW_K * MW, initial_K: kelvin(stores.rhrMotorInitial_C) },
      rhrTrain: rhr,
      expansion: vessel,
      lowPressureContinuation: continuation,
    },
  }
}

/** The fields of `runPrimaryStation`'s result the compiler consumes. */
export function stationPreparation(result: Awaited<ReturnType<typeof runPrimaryStation>>): StationPreparation {
  const point = (t: 'A' | 'B') => result.support[t].point as unknown as PreparedTrain
  const s = result.station as unknown as { powers_MW: { generatorLoss: number }, pumps: Record<'CCW_A' | 'CCW_B' | 'SWA' | 'SWB' | 'CW', { fluid_MW: number, motorAndDrag_MW: number }> }
  return { A: point('A'), B: point('B'), generatorLoss_MW: s.powers_MW.generatorLoss, swFluid_MW: { A: s.pumps.SWA.fluid_MW, B: s.pumps.SWB.fluid_MW },
    motorAndDrag_MW: { CCW_A: s.pumps.CCW_A.motorAndDrag_MW, CCW_B: s.pumps.CCW_B.motorAndDrag_MW, SWA: s.pumps.SWA.motorAndDrag_MW, SWB: s.pumps.SWB.motorAndDrag_MW,
      CW: s.pumps.CW.motorAndDrag_MW } }
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export async function prepareOperatingSupport(wikiRoot: string, python: string) {
  const names = Object.entries(supportPages) as [keyof typeof supportPages, string][]
  const read = () => Promise.all(names.map(([, p]) => Bun.file(join(wikiRoot, LD01, p)).text()))
  const before = await read()
  const pages = Object.fromEntries(names.map(([k], i) => [k, before[i]!])) as SupportPages
  const station = await runPrimaryStation(join(wikiRoot, LD01), python)
  const packet = compileOperatingSupport(pages, stationPreparation(station))
  const after = await read()
  if (after.some((d, i) => d !== before[i])) throw Error('An owner page changed during compilation')
  return { ...packet, provenance: { packetSha256: hash(JSON.stringify(packet)), sourceSha256: hash(await Bun.file(import.meta.path).text()),
    stationSources: station.sources, stationInputHash: station.inputHash,
    consumed: names.map(([, p], i) => ({ page: LD01 + p, sha256: hash(before[i]!) })) } }
}

if (import.meta.main) {
  const [wikiRoot, python, target, ...extra] = Bun.argv.slice(2)
  if (!wikiRoot || !python || !target || extra.length) throw Error('Usage: bun reference-design-operating-support.ts <wiki root> <research-python> <packet.json>')
  const packet = await prepareOperatingSupport(wikiRoot, python)
  await Bun.write(target, JSON.stringify(packet, null, 2) + '\n')
  console.log(JSON.stringify({ target, packetSha256: packet.provenance.packetSha256 }))
}
