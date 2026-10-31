/** Compose the CVCS owner's compact allocation (plan r4 X4.2, `ld01-cvcs`)
 * into a joined packet as its `cvcs` section: charging and letdown at COLD.A,
 * the four pools and the continuous normal inventory controller. Nothing else
 * in the packet changes except its scope and provenance, so packets without
 * it stay bitwise.
 *
 * Every value comes from its owner's strict block, unchanged or converted to
 * SI by stated arithmetic (MPa to Pa, °C to K); no law is evaluated here (the
 * Rust owner derives the pump's rise and shutoff ratio, the branch laws, the
 * pools' IF97 density and the LT calibration once):
 * - `ld01-cvcs` and `ld01-cvcs-controller` (primary-coolant/inventory-and-
 *   chemistry.md, compact normal inventory control): the selected reduced
 *   realization, checked literally, the controller's gains, ranges, lags,
 *   branch losses and stops, and the judgement values;
 * - `reference-service-pump` (same page): CHARGE's flow, suction, discharge,
 *   sizing receiver pressure and hydraulic efficiency;
 * - `reference-letdown-trim` (same page): the letdown's upstream and trim
 *   inlet pressures, receiver pressure, nominal flow, opening and the cooler
 *   outlet temperature;
 * - `reference-chemistry-lifecycle` (same page): the four pools;
 * - `reference-inventory-open-pools` (same page): the receipt port's +3 m;
 * - `ld01-pzr-level-program` (same page): the programmed level;
 * - `ld01-pzr-level-channels` (instrumentation/phase-dependent-measurements.md):
 *   the LT indication law's calibration, spans and lag.
 * The port and leg cells are the packet's own regions: COLD.A, and per loop
 * the cells whose id is `HOT.<loop>` or `COLD.<loop>` or begins with it and a
 * dot.
 *
 * Usage: bun reference-design-operating-cvcs.ts <joined packet> <wiki root> */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { ownedBlock } from './reference-design-operating-pzr'
import { configurationBlock } from './reference-design-source-laws'

type Json = Record<string, any>
const pos = z.number().finite().positive(), nonneg = z.number().finite().nonnegative(), finite = z.number().finite()
const range = z.tuple([finite, finite]).refine(([a, b]) => a < b, 'empty range')
const fraction = z.number().finite().min(0).max(1)

export const cvcsOwner = { page: 'systems/primary-coolant/inventory-and-chemistry.md', heading: 'Compact normal inventory control (plan r4, 1 November 2026)' } as const
const pages = { inventory: cvcsOwner.page, measurements: 'systems/instrumentation/phase-dependent-measurements.md' } as const

const compactSchema = z.object({
  tanks: z.literal('isothermalMixedPools'), chargingPump: z.literal('forwardQuadraticAtRatedSpeed'),
  pumpEnthalpy: z.literal('efficiencyHeatedAtReferenceDensity'), chargingPath: z.literal('seriesFixedPathAndFcvLiquid'),
  letdownPath: z.literal('seriesUpstreamLossAndTrimLiquid'), letdownCooler: z.literal('idealToSourceTemperature'),
  transfers: z.literal('requestedFlow'), port: z.literal('COLD.A'), levelInput: z.literal('pzrLevelIndication'),
  loopAverageInput: z.literal('massWeightedLegCells'), loopAverageLag_s: pos, stem: z.literal('firstOrderWithinStrokeRate'),
  stemTimeConstant_s: pos, deadband: z.literal('smooth'), deadbandWidth_m: pos, supportLoss: z.literal('chargingZero'),
  controller: z.literal('continuous'), blendInitialConcentration: z.literal('primaryAtInitialState'),
  judgement: z.tuple([z.literal('loopAverageInput'), z.literal('loopAverageLag_s'), z.literal('stemTimeConstant_s'), z.literal('deadbandWidth_m')]),
}).strict()
const controllerSchema = z.object({
  requestGain_kg_s_m: pos, requestRange_kg_s: range, band_m: pos, flowNormalization_kg_s: pos, valveBias: fraction,
  innerProportional: pos, innerIntegral_per_s: pos, valveRange: range, flowLag_s: pos, flowSpan_kg_s: range,
  chargingFixedLoss_MPa: pos, chargingFcvLoss_MPa: pos, fcvReferenceOpening: fraction, regulatingStrokePerSecond: pos,
  letdownUpstreamLoss_MPa: pos, shutoffPressure_MPa: pos, lowBlendStop_m3: pos, lowBlendRestart_m3: pos,
  receiverStopHeight_m: pos, receiverResetHeight_m: pos, levelIntegralTime_s: pos,
}).strict()
const pumpSchema = z.object({ id: z.literal('CHARGE'), flow_kg_s: pos, inletPressure_MPa: pos, inletTemperature_C: finite,
  outletPressure_MPa: pos, receiverPressure_MPa: pos, hydraulicEfficiency: fraction }).passthrough()
const trimSchema = z.object({ inletPressure_MPa: pos, outletPressure_MPa: pos, nominalTemperature_C: finite, nominalFlow_kg_s: pos,
  nominalOpening: fraction, upstreamPressure_MPa: pos }).passthrough()
const tankSchema = z.object({ area_m2: pos, initialVolume_m3: pos, initial_ppm: nonneg, stopHeight_m: pos, resetHeight_m: pos }).strict()
const lifecycleSchema = z.object({ pressure_Pa: pos, temperature_K: pos, floor_m: finite, height_m: pos, transferFlow_kg_s: pos,
  WATER: tankSchema, CONCENTRATE: tankSchema, BLEND: tankSchema, RECEIVER: tankSchema }).passthrough()
const poolsSchema = z.object({ receiptPort_m: finite, initialTemperature_C: finite }).passthrough()
const programSchema = z.object({ input: z.literal('loopAverage'), fullPower: z.object({ loopAverage_K: pos, level_m: finite }).strict(),
  noLoad: z.object({ loopAverage_K: pos, level_m: finite }).strict(), band_m: pos }).strict()
const levelSchema = z.object({ calibrationPressure_Pa: pos, lag_s: pos, interfaceSpan_Pa: range, indicatedSpan_m: range }).passthrough()

const MPa = 1e6, K = 273.15
function same(what: string, a: number, b: number) {
  if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))) throw Error(`${what}: ${a} disagrees with ${b}`)
}
const tank = (t: z.infer<typeof tankSchema>) => ({ area_m2: t.area_m2, initialVolume_m3: t.initialVolume_m3, initial_ppm: t.initial_ppm,
  stopHeight_m: t.stopHeight_m, resetHeight_m: t.resetHeight_m })

export type CvcsPages = { inventory: string, measurements: string }
type Region = { id: string, elevation_m: number }

/** The section from the owners' page texts and the packet's regions. */
export function compileCvcs(p: CvcsPages, regions: Region[]) {
  const compact = compactSchema.parse(ownedBlock(p.inventory, cvcsOwner.heading, 'ld01-cvcs'))
  const ctl = controllerSchema.parse(ownedBlock(p.inventory, cvcsOwner.heading, 'ld01-cvcs-controller'))
  const pump = pumpSchema.parse(configurationBlock(p.inventory, 'reference-service-pump'))
  const trim = trimSchema.parse(configurationBlock(p.inventory, 'reference-letdown-trim'))
  const life = lifecycleSchema.parse(configurationBlock(p.inventory, 'reference-chemistry-lifecycle'))
  const pools = poolsSchema.parse(configurationBlock(p.inventory, 'reference-inventory-open-pools'))
  const program = programSchema.parse(configurationBlock(p.inventory, 'ld01-pzr-level-program'))
  const level = levelSchema.parse(configurationBlock(p.measurements, 'ld01-pzr-level-channels'))
  // The controller block repeats values its owners select: they must agree.
  same('band', ctl.band_m, program.band_m)
  same('charging losses', ctl.chargingFixedLoss_MPa + ctl.chargingFcvLoss_MPa, pump.outletPressure_MPa - pump.receiverPressure_MPa)
  same('letdown upstream loss', ctl.letdownUpstreamLoss_MPa, trim.upstreamPressure_MPa - trim.inletPressure_MPa)
  same('receiver stop', ctl.receiverStopHeight_m, life.RECEIVER.stopHeight_m)
  same('receiver reset', ctl.receiverResetHeight_m, life.RECEIVER.resetHeight_m)
  same('pump suction', pump.inletPressure_MPa * MPa, life.pressure_Pa)
  same('trim outlet', trim.outletPressure_MPa * MPa, life.pressure_Pa)
  same('suction temperature', pump.inletTemperature_C + K, life.temperature_K)
  same('pool temperature', pools.initialTemperature_C + K, life.temperature_K)
  if (ctl.requestRange_kg_s[0] !== 0) throw Error('The requests start at zero')
  const port = regions.findIndex(r => r.id === compact.port)
  if (port < 0 || regions.filter(r => r.id === compact.port).length !== 1) throw Error(`The packet has no single ${compact.port} region`)
  same('receipt port elevation', regions[port]!.elevation_m, pools.receiptPort_m)
  const cells = (prefix: string) => regions.flatMap((r, i) => (r.id === prefix || r.id.startsWith(prefix + '.')) ? [i] : [])
  const loops = [...new Set(regions.flatMap(r => /^HOT\.([A-Z])(\.|$)/.exec(r.id)?.[1] ?? []))].sort()
  if (loops.length === 0) throw Error('The packet has no HOT leg regions')
  const legs = loops.map(l => {
    const hot = cells(`HOT.${l}`), cold = cells(`COLD.${l}`)
    if (!hot.length || !cold.length) throw Error(`Loop ${l} lacks a hot or cold leg cell`)
    return { loop: l, hot, cold }
  })
  return {
    port: { region: port, id: compact.port, elevation_m: pools.receiptPort_m },
    legs,
    pzrLevel: { calibrationPressure_Pa: level.calibrationPressure_Pa, interfaceSpan_Pa: level.interfaceSpan_Pa,
      indicatedSpan_m: level.indicatedSpan_m, lag_s: level.lag_s },
    program: { fullPower: program.fullPower, noLoad: program.noLoad },
    controller: { requestGain_kg_s_m: ctl.requestGain_kg_s_m, requestRange_kg_s: ctl.requestRange_kg_s, band_m: ctl.band_m,
      flowNormalization_kg_s: ctl.flowNormalization_kg_s, valveBias: ctl.valveBias, innerProportional: ctl.innerProportional,
      innerIntegral_per_s: ctl.innerIntegral_per_s, valveRange: ctl.valveRange, flowLag_s: ctl.flowLag_s, flowSpan_kg_s: ctl.flowSpan_kg_s,
      deadbandWidth_m: compact.deadbandWidth_m, levelIntegralTime_s: ctl.levelIntegralTime_s, loopAverageLag_s: compact.loopAverageLag_s, stemTimeConstant_s: compact.stemTimeConstant_s,
      strokePerSecond: ctl.regulatingStrokePerSecond },
    charging: { nominalFlow_kg_s: pump.flow_kg_s, suctionPressure_Pa: pump.inletPressure_MPa * MPa,
      dischargePressure_Pa: pump.outletPressure_MPa * MPa, shutoffPressure_Pa: ctl.shutoffPressure_MPa * MPa,
      receiverPressure_Pa: pump.receiverPressure_MPa * MPa, hydraulicEfficiency: pump.hydraulicEfficiency,
      fixedLoss_Pa: ctl.chargingFixedLoss_MPa * MPa, fcvLoss_Pa: ctl.chargingFcvLoss_MPa * MPa, referenceOpening: ctl.fcvReferenceOpening },
    letdown: { nominalFlow_kg_s: trim.nominalFlow_kg_s, upstreamPressure_Pa: trim.upstreamPressure_MPa * MPa,
      trimInletPressure_Pa: trim.inletPressure_MPa * MPa, receiverPressure_Pa: trim.outletPressure_MPa * MPa,
      referenceOpening: trim.nominalOpening, coolerOutletTemperature_K: trim.nominalTemperature_C + K },
    tanks: { pressure_Pa: life.pressure_Pa, temperature_K: life.temperature_K, height_m: life.height_m,
      // BLEND's absorber follows the initial-condition rule (ld01-cvcs
      // blendInitialConcentration), not the original preparation's ppm.
      blend: { ...tank(life.BLEND), initial_ppm: null }, water: tank(life.WATER), concentrate: tank(life.CONCENTRATE), receiver: tank(life.RECEIVER) },
    transferFlow_kg_s: life.transferFlow_kg_s,
    lowBlend: { stop_m3: ctl.lowBlendStop_m3, restart_m3: ctl.lowBlendRestart_m3 },
    blendInitialConcentration: compact.blendInitialConcentration,
  }
}

/** The packet with `cvcs` added. */
export function composeCvcs(packet: Json, section: ReturnType<typeof compileCvcs>) {
  if ('cvcs' in packet) throw Error('The packet already composes a CVCS')
  const out: Json = structuredClone(packet)
  out.cvcs = section
  out.scope = String(packet.scope) + ' With the compact CVCS (charging and letdown at COLD.A, the four pools, the continuous normal inventory controller) composed.'
  return out
}

const root = 'world/packs/process-plant/reference-designs/ld-01/'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')

if (import.meta.main) {
  const [packetPath, wiki] = Bun.argv.slice(2)
  if (!packetPath || !wiki || Bun.argv.length !== 4) throw Error('Usage: operating-cvcs <joined packet> <wiki root>')
  const keys = Object.keys(pages) as (keyof typeof pages)[]
  const texts = await Promise.all(keys.map(k => Bun.file(join(wiki, root, pages[k])).text()))
  const p = Object.fromEntries(keys.map((k, i) => [k, texts[i]!])) as CvcsPages
  const text = await Bun.file(packetPath).text()
  const packet = JSON.parse(text)
  const composed = composeCvcs(packet, compileCvcs(p, packet.mechanics.regions))
  composed.provenance = { ...composed.provenance, cvcs: { inputPacketSha256: hash(text), sourceSha256: hash(await Bun.file(import.meta.path).text()),
    consumed: keys.map((k, i) => ({ name: root + pages[k], sha256: hash(texts[i]!) })) } }
  console.log(JSON.stringify(composed))
}
