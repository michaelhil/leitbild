/** The feed train's operating input section (`feed`) for C09's compact
 * operating allocation (Gate 1, S4 readiness package r2 §4.2): FW.TANK,
 * FW.P1/P2 and COND.P with their casings, H1–H4, FW.HEADER, the A/B branches
 * and the three-element cascade, from their owners' strict wiki blocks,
 * unchanged or derived by stated arithmetic. No law is evaluated here: every
 * native-water calibration (reference densities, pump stage areas, valve
 * areas, inertias) is made once by the Rust block from these inputs with the
 * runtime laws, as the SG relief area is.
 *
 * - `ld01-feed-cascade` (feedwater/control-and-faults.md): gains, sampling,
 *   spans, initial mode;
 * - `ld01-feed-train` (feedwater/equipment.md): pump machine, casing, branch
 *   and actuator values;
 * - `reference-service-pump` and `reference-service-pump-signed` (same page):
 *   the FW pump duty, suction/discharge reference and signed coefficients;
 * - `reference-feed-pool` (feedwater/index.md): tank geometry and state;
 * - `ld01-feed-heaters` (steam-power/turbine-and-regeneration-dynamics.md);
 * - `ld01-condensate-pump` (steam-power/condenser-and-cooling.md);
 * - `reference-cycle` (steam-power/cycle-basis.md): header pressure, SG feed
 *   temperature, bleed pressures and heater outlets, cross-checked;
 * - `ld01-sg-level-channels` (steam-generation/instrumentation.md): the NR span.
 *
 * Usage: bun reference-design-operating-feed.ts <wiki root> */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { ownedBlock } from './reference-design-operating-pzr'

export const feedOwners = {
  cascade: { page: 'systems/feedwater/control-and-faults.md', heading: 'Selected cascade law', fence: 'ld01-feed-cascade' },
  train: { page: 'systems/feedwater/equipment.md', heading: 'Compact operating input (15 October 2026)', fence: 'ld01-feed-train' },
  pump: { page: 'systems/feedwater/equipment.md', heading: 'Finite service-pump continuation', fence: 'reference-service-pump' },
  signed: { page: 'systems/feedwater/equipment.md', heading: 'Signed high-pressure service machine', fence: 'reference-service-pump-signed' },
  pool: { page: 'systems/feedwater/index.md', heading: 'Hot receipt, boiling and overflow', fence: 'reference-feed-pool' },
  heaters: { page: 'systems/steam-power/turbine-and-regeneration-dynamics.md', heading: 'Compact operating input of H1–H4 (15 October 2026)', fence: 'ld01-feed-heaters' },
  condensate: { page: 'systems/steam-power/condenser-and-cooling.md', heading: 'Compact operating input of COND.P (15 October 2026)', fence: 'ld01-condensate-pump' },
  cycle: { page: 'systems/steam-power/cycle-basis.md', heading: 'Authoritative selected input', fence: 'reference-cycle' },
  level: { page: 'systems/steam-generation/instrumentation.md', heading: 'Selected channels', fence: 'ld01-sg-level-channels' },
} as const
export type FeedPages = Record<keyof typeof feedOwners, string>

const pos = z.number().finite().positive(), nonneg = z.number().finite().nonnegative(), fraction = z.number().finite().min(0).max(1)
const range = z.tuple([nonneg, pos]).refine(([a, b]) => a < b, 'empty range')
const four = (s: z.ZodTypeAny) => z.array(s).length(4)
const cascadeSchema = z.object({
  levelSetpoint: fraction, outerProportional: pos, outerIntegral_per_s: pos, requestRange: range, valveBias: fraction, valveRange: range,
  innerProportional: pos, innerIntegral_per_s: pos, sample_s: pos, feedFlowLag_s: pos, feedFlowSpan: range, steamFlowLag_s: pos, steamFlowSpan: range,
  controlChannel: z.literal('LT.NR1'), initialMode: z.enum(['MANUAL', 'AUTO']), initialDemand: fraction }).strict()
const trainSchema = z.object({
  pumpEye_m: z.number().finite(), shutoffHeadRatio: pos, brakeFactor: pos, motorEfficiency: fraction, coastdownScale_s: pos, torqueTracking_s: pos,
  torqueLimit: pos, dragFraction: nonneg, churnFloorFraction: nonneg, suctionExponent: pos, gasFactorFull: fraction, gasFactorZero: fraction,
  caseResidence_s: pos, caseConductance_W_K: pos, branchIsoOutletPressure_MPa: pos, fcvReferenceOpening: fraction, fcvStrokePerSecond: pos,
  isoStroke_s: pos, actuatorOpeningPower_W: pos, actuatorHolding_W: pos }).strict()
const pumpSchema = z.object({ id: z.literal('FW'), flow_kg_s: pos, inletPressure_MPa: pos, inletTemperature_C: z.number().finite(), outletPressure_MPa: pos,
  receiverPressure_MPa: pos, hydraulicEfficiency: fraction, npshSpeed_m: nonneg, npshFlow_m: nonneg, existingTrainHoldup_m3: z.literal(0) }).strict()
const signedSchema = z.object({ crossCoefficient: nonneg, crossSensitivity: z.array(nonneg), rpm: pos, leakAreaFraction: fraction }).strict()
const poolSchema = z.object({ pressure_Pa: pos, gravity_m_s2: pos, tankArea_m2: pos, tankFloor_m: z.number().finite(), tankHeight_m: pos,
  collectionArea_m2: pos, collectionFloor_m: z.number().finite(), weirCoefficient: pos, initialTemperature_C: z.number().finite(),
  initialLiquidVolume_m3: pos, condensatePort_m: z.number().finite(), ventPort_m: z.number().finite(), ambientTemperature_C: z.number().finite() }).strict()
const heatersSchema = z.object({
  tubeVolume_m3: pos, shellVolume_m3: four(pos), initialLiquidFraction: fraction, wallCapacity_MJ_K: four(pos), extractionPressure_MPa: four(pos),
  tubeOutlet_C: four(z.number().finite()), wallMidpointFraction: fraction, shellPressureFraction: fraction, extractionIsoStroke_s: pos,
  drainTarget: fraction, drainNominalOpening: fraction, drainGain: pos, drainSample_s: pos, drainStrokePerSecond: pos, drainSizingOpening: fraction,
  drainPickupFraction: fraction, highLevelAnnunciation: fraction, tubeValveStroke_s: pos, inletIsoLoss_kPa: pos, channelLoss_kPa: pos,
  outletIsoLoss_kPa: pos, bypassLoss_kPa: pos, junctionPressure_MPa: z.array(pos).length(5), tubePressure_MPa: four(pos), actuatorPower_W: pos,
  electronics_W: pos }).strict()
const condensateSchema = z.object({
  flow_kg_s: pos, referenceTemperature_C: z.number().finite(), referencePressure_Pa: pos, rpm: pos, hydraulicEfficiency: fraction,
  motorEfficiency: fraction, dragFraction: nonneg, speedDecayScale_s: pos, torqueTracking_s: pos, torqueLimit: pos, shutoffHeadRatio: pos,
  flowHeadCoefficient: pos, npshSpeed_m: nonneg, npshFlow_m: nonneg, eye_m: z.number().finite(), churnFraction: nonneg, suctionExponent: pos,
  gasFactorFull: fraction, gasFactorZero: fraction, caseResidence_s: pos, referenceVelocity_m_s: pos }).strict()
const cycleSchema = z.object({ steamPressure_MPaAbs: pos, feedInlet_C: z.number().finite(), feedPumpDischarge_MPaAbs: pos, feedHeaderPressure_MPaAbs: pos,
  feedSourcePressure_MPaAbs: pos, feedPumpHydraulicEfficiency: fraction, feedPumpMotorEfficiency: fraction, feedPumpDragFraction: nonneg,
  condensate_C: z.number().finite(), condensatePumpHydraulicEfficiency: fraction, condensatePumpMotorEfficiency: fraction,
  highBleedPressure_MPaAbs: pos, separatorPressure_MPaAbs: pos, lowBleedPressure_MPaAbs: pos, lowestBleedPressure_MPaAbs: pos,
  heaterOutlet_C: z.array(z.number().finite()).length(3) }).passthrough()
const levelSchema = z.object({ nrSpan_m: z.tuple([z.number().finite(), z.number().finite()]) }).passthrough()

const MPa = 1e6, kPa = 1e3, kelvin = (c: number) => c + 273.15, rpm = (n: number) => n * 2 * Math.PI / 60
/** Exact decimal agreement of two block values that state one quantity. */
function same(what: string, a: number, b: number) {
  if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))) throw Error(`${what}: ${a} disagrees with ${b}`)
}

/** The `feed` section from the owners' page texts. */
export function compileOperatingFeed(pages: FeedPages) {
  const o = feedOwners, read = <T extends z.ZodTypeAny>(k: keyof typeof feedOwners, s: T): z.infer<T> =>
    s.parse(ownedBlock(pages[k], o[k].heading, o[k].fence))
  const cascade = read('cascade', cascadeSchema), train = read('train', trainSchema), pump = read('pump', pumpSchema),
    signed = read('signed', signedSchema), pool = read('pool', poolSchema), heaters = read('heaters', heatersSchema),
    cond = read('condensate', condensateSchema), cycle = read('cycle', cycleSchema), level = read('level', levelSchema)
  // One quantity, one value: the feed blocks must agree with the cycle sizing they were taken from.
  same('FW discharge', pump.outletPressure_MPa, cycle.feedPumpDischarge_MPaAbs)
  same('FW suction', pump.inletPressure_MPa, cycle.feedSourcePressure_MPaAbs)
  same('FW suction temperature', pump.inletTemperature_C, cycle.condensate_C)
  same('SG reference pressure', pump.receiverPressure_MPa, cycle.steamPressure_MPaAbs)
  same('FW hydraulic efficiency', pump.hydraulicEfficiency, cycle.feedPumpHydraulicEfficiency)
  same('FW motor efficiency', train.motorEfficiency, cycle.feedPumpMotorEfficiency)
  same('FW drag', train.dragFraction, cycle.feedPumpDragFraction)
  same('COND.P hydraulic efficiency', cond.hydraulicEfficiency, cycle.condensatePumpHydraulicEfficiency)
  same('COND.P motor efficiency', cond.motorEfficiency, cycle.condensatePumpMotorEfficiency)
  same('COND.P reference temperature', cond.referenceTemperature_C, cycle.condensate_C)
  same('COND.P duty is both SG feeds', cond.flow_kg_s, 2 * pump.flow_kg_s)
  same('tank suction pressure', pool.pressure_Pa, pump.inletPressure_MPa * MPa)
  same('tank temperature', pool.initialTemperature_C, pump.inletTemperature_C)
  same('pump eye at the initial surface', train.pumpEye_m, pool.tankFloor_m + pool.initialLiquidVolume_m3 / pool.tankArea_m2)
  heaters.extractionPressure_MPa.forEach((p, i) => same(`H${i + 1} extraction`, p,
    [cycle.lowestBleedPressure_MPaAbs, cycle.lowBleedPressure_MPaAbs, cycle.separatorPressure_MPaAbs, cycle.highBleedPressure_MPaAbs][i]!))
  heaters.tubeOutlet_C.forEach((t, i) => same(`H${i + 1} outlet`, t, [...cycle.heaterOutlet_C, cycle.feedInlet_C][i]!))
  const j = heaters.junctionPressure_MPa
  same('pump discharge junction', j[0]!, cycle.feedPumpDischarge_MPaAbs)
  same('header junction', j[4]!, cycle.feedHeaderPressure_MPaAbs)
  heaters.tubePressure_MPa.forEach((p, i) => {
    same(`H${i + 1} tube pressure`, p, j[i]! - heaters.inletIsoLoss_kPa * kPa / MPa)
    same(`H${i + 1} tube path`, j[i]! - j[i + 1]!, (heaters.inletIsoLoss_kPa + heaters.channelLoss_kPa + heaters.outletIsoLoss_kPa) * kPa / MPa)
    same(`H${i + 1} bypass`, j[i]! - j[i + 1]!, heaters.bypassLoss_kPa * kPa / MPa)
  })
  if (!(train.gasFactorFull < train.gasFactorZero && cond.gasFactorFull < cond.gasFactorZero)) throw Error('Gas factor breakpoints must rise')
  if (!(train.branchIsoOutletPressure_MPa < cycle.feedHeaderPressure_MPaAbs && train.branchIsoOutletPressure_MPa > pump.receiverPressure_MPa))
    throw Error('The FCV inlet reference must lie between the header and the SG')
  if (!(cascade.requestRange[0] === 0 && cascade.valveRange[0] === 0 && cascade.valveRange[1] === 1)) throw Error('Cascade saturation must start at zero')
  const [nrLow, nrHigh] = level.nrSpan_m
  if (!(nrHigh > nrLow)) throw Error('Empty narrow span')
  const omega0 = rpm(signed.rpm), condOmega0 = rpm(cond.rpm)
  return {
    nominalFlow_kg_s: pump.flow_kg_s,
    tank: { surfacePressure_Pa: pool.pressure_Pa, gravity_m_s2: pool.gravity_m_s2, area_m2: pool.tankArea_m2, floor_m: pool.tankFloor_m,
      rim_m: pool.tankFloor_m + pool.tankHeight_m, initialTemperature_K: kelvin(pool.initialTemperature_C), initialLiquid_m3: pool.initialLiquidVolume_m3,
      pickup_m: pool.tankFloor_m, returnNozzle_m: pool.condensatePort_m, pumpEye_m: train.pumpEye_m },
    feedPump: {
      ids: ['LD01.FW.P1', 'LD01.FW.P2'], support: ['AC.A', 'AC.B'], flow_kg_s: pump.flow_kg_s,
      reference: { inletPressure_Pa: pump.inletPressure_MPa * MPa, inletTemperature_K: kelvin(pump.inletTemperature_C),
        outletPressure_Pa: pump.outletPressure_MPa * MPa },
      hydraulicEfficiency: pump.hydraulicEfficiency, npshSpeed_m: pump.npshSpeed_m, npshFlow_m: pump.npshFlow_m,
      crossCoefficient: signed.crossCoefficient, omega0_rad_s: omega0, shutoffHeadRatio: train.shutoffHeadRatio, brakeFactor: train.brakeFactor,
      motorEfficiency: train.motorEfficiency, coastdownScale_s: train.coastdownScale_s, torqueTracking_s: train.torqueTracking_s,
      torqueLimit: train.torqueLimit, dragFraction: train.dragFraction, churnFloorFraction: train.churnFloorFraction,
      suctionExponent: train.suctionExponent, gasFactor: [train.gasFactorFull, train.gasFactorZero],
      caseResidence_s: train.caseResidence_s, caseConductance_W_K: train.caseConductance_W_K },
    condensatePump: {
      id: 'LD01.COND.P', flow_kg_s: cond.flow_kg_s, referenceTemperature_K: kelvin(cond.referenceTemperature_C), referencePressure_Pa: cond.referencePressure_Pa,
      omega0_rad_s: condOmega0, hydraulicEfficiency: cond.hydraulicEfficiency, motorEfficiency: cond.motorEfficiency, dragFraction: cond.dragFraction,
      speedDecayScale_s: cond.speedDecayScale_s, torqueTracking_s: cond.torqueTracking_s, torqueLimit: cond.torqueLimit,
      shutoffHeadRatio: cond.shutoffHeadRatio, flowHeadCoefficient: cond.flowHeadCoefficient, npshSpeed_m: cond.npshSpeed_m, npshFlow_m: cond.npshFlow_m,
      eye_m: cond.eye_m, returnNozzle_m: pool.condensatePort_m, churnFraction: cond.churnFraction, suctionExponent: cond.suctionExponent,
      gasFactor: [cond.gasFactorFull, cond.gasFactorZero], caseResidence_s: cond.caseResidence_s, referenceVelocity_m_s: cond.referenceVelocity_m_s },
    heaters: {
      ids: ['LD01.FW.H1', 'LD01.FW.H2', 'LD01.FW.H3', 'LD01.FW.H4'], tubeVolume_m3: heaters.tubeVolume_m3, shellVolume_m3: heaters.shellVolume_m3,
      initialLiquidFraction: heaters.initialLiquidFraction, wallCapacity_J_K: heaters.wallCapacity_MJ_K.map(c => c * MPa),
      extractionPressure_Pa: heaters.extractionPressure_MPa.map(p => p * MPa), tubeOutlet_K: heaters.tubeOutlet_C.map(kelvin),
      wallMidpointFraction: heaters.wallMidpointFraction, shellPressureFraction: heaters.shellPressureFraction,
      extractionIsoStroke_s: heaters.extractionIsoStroke_s,
      drain: { target: heaters.drainTarget, nominalOpening: heaters.drainNominalOpening, gain: heaters.drainGain, sample_s: heaters.drainSample_s,
        strokePerSecond: heaters.drainStrokePerSecond, sizingOpening: heaters.drainSizingOpening, pickupFraction: heaters.drainPickupFraction },
      highLevelAnnunciation: heaters.highLevelAnnunciation, tubeValveStroke_s: heaters.tubeValveStroke_s,
      lossAllocation_Pa: { inletIso: heaters.inletIsoLoss_kPa * kPa, channel: heaters.channelLoss_kPa * kPa, outletIso: heaters.outletIsoLoss_kPa * kPa,
        bypass: heaters.bypassLoss_kPa * kPa },
      junctionPressure_Pa: j.map(p => p * MPa), tubePressure_Pa: heaters.tubePressure_MPa.map(p => p * MPa),
      actuatorPower_W: heaters.actuatorPower_W, electronics_W: heaters.electronics_W },
    branches: {
      ids: ['A', 'B'], headerPressure_Pa: cycle.feedHeaderPressure_MPaAbs * MPa, isoOutletPressure_Pa: train.branchIsoOutletPressure_MPa * MPa,
      sgReferencePressure_Pa: pump.receiverPressure_MPa * MPa, feedTemperature_K: kelvin(cycle.feedInlet_C),
      fcvReferenceOpening: train.fcvReferenceOpening, fcvStrokePerSecond: train.fcvStrokePerSecond, isoStroke_s: train.isoStroke_s,
      actuatorOpeningPower_W: train.actuatorOpeningPower_W, actuatorHolding_W: train.actuatorHolding_W },
    cascade: { levelSetpoint: cascade.levelSetpoint, narrowSpan_m: level.nrSpan_m, outerProportional: cascade.outerProportional,
      outerIntegral_per_s: cascade.outerIntegral_per_s, requestRange: cascade.requestRange, valveBias: cascade.valveBias, valveRange: cascade.valveRange,
      innerProportional: cascade.innerProportional, innerIntegral_per_s: cascade.innerIntegral_per_s, sample_s: cascade.sample_s,
      feedFlowLag_s: cascade.feedFlowLag_s, feedFlowSpan: cascade.feedFlowSpan, steamFlowLag_s: cascade.steamFlowLag_s, steamFlowSpan: cascade.steamFlowSpan,
      controlChannel: cascade.controlChannel, initialMode: cascade.initialMode, initialDemand: cascade.initialDemand },
  }
}

export async function prepareOperatingFeed(wiki: string) {
  const base = join(wiki, 'world/packs/process-plant/reference-designs/ld-01')
  const names = Object.entries(feedOwners) as [keyof typeof feedOwners, { page: string, fence: string }][]
  const pages = Object.fromEntries(await Promise.all(names.map(async ([k, o]) => [k, await Bun.file(join(base, o.page)).text()]))) as FeedPages
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { ...compileOperatingFeed(pages), provenance: {
    consumed: names.map(([k, o]) => ({ page: o.page, fence: o.fence, sha256: hash(pages[k]) })),
    sourceSha256: hash(await Bun.file(import.meta.path).text()) } }
}

if (import.meta.main) {
  const [wiki] = Bun.argv.slice(2)
  if (!wiki || Bun.argv.length !== 3) throw Error('Usage: operating-feed <wiki root>')
  console.log(JSON.stringify(await prepareOperatingFeed(wiki)))
}
