/** Compose the compact feed train (plan r4 X4.1, `ld01-feed-compact`) into a
 * joined packet that already composes the C08 apparent level: the section
 * becomes `secondary.feedTrain`, where the SG secondary owner appends the
 * header pressure and the A/B branch flows and replaces F3 (a)'s
 * inventory-holding feed with the real balance. Nothing else in the packet
 * changes except its scope and provenance, so packets without it (S1-S3)
 * stay bitwise.
 *
 * Every value comes from its owner's strict block, unchanged or converted
 * to SI by stated arithmetic; no law is evaluated here (the Rust owner
 * derives the pump rise, the entry-loss coefficient, the branch drops and
 * the prepared openings once):
 * - `ld01-feed-compact` (feedwater/control-and-faults.md): the selected
 *   reduced realization, checked literally, and the continuous stem's time
 *   constant (the cascade is realized continuously: owner, 31 October 2026);
 * - `reference-service-pump` (feedwater/equipment.md): `m0`, suction,
 *   discharge and the FCV sizing receiver pressure;
 * - `ld01-feed-train` (same page): the shutoff head ratio, the ISO-path
 *   outlet, the FCV reference opening and its stroke rate;
 * - `reference-cycle` (steam-power/cycle-basis.md): the header pressure,
 *   cross-checked against the pump's discharge and suction;
 * - `ld01-feed-cascade` (feedwater/control-and-faults.md): the cascade;
 * - `ld01-sg-level-channels` (steam-generation/instrumentation.md): the NR
 *   span and lag the cascade's level input uses;
 * - `ld01-startup-feed` (same page as the cascade): the startup-feed
 *   stand-in's decay heat, tank temperature and start/isolation levels
 *   (judgement; MW and °C converted to W and K).
 *
 * Usage: bun reference-design-operating-feed-compact.ts <joined packet with apparentLevel> <wiki root> */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { feedOwners } from './reference-design-operating-feed'
import { ownedBlock } from './reference-design-operating-pzr'

type Json = Record<string, any>
const pos = z.number().finite().positive(), nonneg = z.number().finite().nonnegative(), fraction = z.number().finite().min(0).max(1)
const range = z.tuple([nonneg, pos]).refine(([a, b]) => a < b, 'empty range')

export const compactOwner = { page: 'systems/feedwater/control-and-faults.md', heading: 'Compact feed train (plan r4, 31 October 2026)', fence: 'ld01-feed-compact' } as const
export const startupOwner = { page: 'systems/feedwater/control-and-faults.md', heading: 'Startup feed stand-in (judgement, 31 October 2026)', fence: 'ld01-startup-feed' } as const
const startupSchema = z.object({
  capacityBasis: z.literal('decayHeatAt100sSharedBySgs'), decayHeat_MW: pos, decayHeatTime_s: pos, sourceTemperature_C: z.number().finite(),
  enthalpyEndpoint: z.literal('saturatedVaporAtNoLoadPressure'), levelChannel: z.literal('LT.NR1'), isolationLevelFraction: fraction,
  kind: z.literal('judgement'), startLevelFraction: fraction, control: z.literal('continuousPiOnNr1BackCalculation'),
  power: z.literal('onsiteStandIn'), stemTimeConstant_s: pos }).strict()
const compactSchema = z.object({
  pumpLaw: z.literal('forwardQuadraticAtRatedSpeed'), fluid: z.literal('liquidAtReferenceDensity'),
  branchLaw: z.literal('seriesIsoPathAndFcvLiquid'), feedEnthalpy: z.literal('recordedSgFeedState'),
  supportLoss: z.literal('deliveredFeedZero'), stem: z.literal('firstOrderWithinStrokeRate'), levelInput: z.literal('apparentLevel'),
  cascade: z.literal('continuous'), stemTimeConstant_s: z.number().finite().positive(),
  operatorTolerances: z.object({ budgetFraction: fraction, uncertaintyFractionOfSpan: fraction, nrLevelBudget_m: pos, flowSpanOfNominal: pos }).strict() }).strict()
const cascadeSchema = z.object({
  levelSetpoint: fraction, outerProportional: pos, outerIntegral_per_s: pos, requestRange: range, valveBias: fraction, valveRange: range,
  innerProportional: pos, innerIntegral_per_s: pos, sample_s: pos, feedFlowLag_s: pos, feedFlowSpan: range, steamFlowLag_s: pos, steamFlowSpan: range,
  controlChannel: z.literal('LT.NR1'), initialMode: z.literal('MANUAL'), initialDemandRule: z.literal('sgSteamFlowAtPreparedSgPressure') }).strict()
const pumpSchema = z.object({ id: z.literal('FW'), flow_kg_s: pos, inletPressure_MPa: pos, outletPressure_MPa: pos, receiverPressure_MPa: pos }).passthrough()
const trainSchema = z.object({ shutoffHeadRatio: pos, branchIsoOutletPressure_MPa: pos, fcvReferenceOpening: fraction, fcvStrokePerSecond: pos }).passthrough()
const cycleSchema = z.object({ feedPumpDischarge_MPaAbs: pos, feedHeaderPressure_MPaAbs: pos, feedSourcePressure_MPaAbs: pos }).passthrough()
const levelSchema = z.object({ nrSpan_m: z.tuple([z.number().finite(), z.number().finite()]), nrLag_s: pos }).passthrough()

const MPa = 1e6
function same(what: string, a: number, b: number) {
  if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))) throw Error(`${what}: ${a} disagrees with ${b}`)
}

export type CompactPages = { control: string, equipment: string, cycle: string, instrumentation: string }

/** The section from the owners' page texts. */
export function compileFeedCompact(p: CompactPages) {
  const compact = compactSchema.parse(ownedBlock(p.control, compactOwner.heading, compactOwner.fence))
  const startup = startupSchema.parse(ownedBlock(p.control, startupOwner.heading, startupOwner.fence))
  same('startup stem time constant', startup.stemTimeConstant_s, compact.stemTimeConstant_s)
  const cascade = cascadeSchema.parse(ownedBlock(p.control, feedOwners.cascade.heading, feedOwners.cascade.fence))
  const pump = pumpSchema.parse(ownedBlock(p.equipment, feedOwners.pump.heading, feedOwners.pump.fence))
  const train = trainSchema.parse(ownedBlock(p.equipment, feedOwners.train.heading, feedOwners.train.fence))
  const cycle = cycleSchema.parse(ownedBlock(p.cycle, feedOwners.cycle.heading, feedOwners.cycle.fence))
  const level = levelSchema.parse(ownedBlock(p.instrumentation, feedOwners.level.heading, feedOwners.level.fence))
  same('FW discharge', pump.outletPressure_MPa, cycle.feedPumpDischarge_MPaAbs)
  same('FW suction', pump.inletPressure_MPa, cycle.feedSourcePressure_MPaAbs)
  if (!(pump.receiverPressure_MPa < train.branchIsoOutletPressure_MPa && train.branchIsoOutletPressure_MPa < cycle.feedHeaderPressure_MPaAbs
    && cycle.feedHeaderPressure_MPaAbs < pump.outletPressure_MPa))
    throw Error('The allocation must fall from discharge to header to FCV inlet to the sizing SG pressure')
  // The continuous realization (ld01-feed-compact `cascade`) carries the
  // gains, ranges and lags; the sampling interval is the sampled law's.
  const { controlChannel, initialMode, initialDemandRule, sample_s, ...law } = cascade
  return {
    nominalFlow_kg_s: pump.flow_kg_s, suctionPressure_Pa: pump.inletPressure_MPa * MPa, dischargePressure_Pa: pump.outletPressure_MPa * MPa,
    shutoffHeadRatio: train.shutoffHeadRatio, headerPressure_Pa: cycle.feedHeaderPressure_MPaAbs * MPa,
    isoOutletPressure_Pa: train.branchIsoOutletPressure_MPa * MPa, receiverPressure_Pa: pump.receiverPressure_MPa * MPa,
    fcvReferenceOpening: train.fcvReferenceOpening, fcvStrokePerSecond: train.fcvStrokePerSecond, stemTimeConstant_s: compact.stemTimeConstant_s,
    // Operator-grade absolute tolerances of the channel lags (stated
    // arithmetic on the block): the NR budget as given; the flow channels'
    // quarter of the channel rule over their span.
    operatorTolerances: { nrLevel_m: compact.operatorTolerances.nrLevelBudget_m, flow_kg_s: compact.operatorTolerances.budgetFraction
      * compact.operatorTolerances.uncertaintyFractionOfSpan * compact.operatorTolerances.flowSpanOfNominal * pump.flow_kg_s },
    startup: { decayHeat_W: startup.decayHeat_MW * MPa, sourceTemperature_K: startup.sourceTemperature_C + 273.15,
      startLevelFraction: startup.startLevelFraction, isolationLevelFraction: startup.isolationLevelFraction },
    cascade: { ...law, narrowSpan_m: level.nrSpan_m, nrLag_s: level.nrLag_s },
  }
}

/** The packet with `secondary.feedTrain` added. */
export function composeFeedCompact(packet: Json, section: ReturnType<typeof compileFeedCompact>) {
  if (!packet.secondary?.apparentLevel) throw Error('The compact feed train needs the packet\'s apparent level')
  if ('feedTrain' in packet.secondary) throw Error('The packet already composes a feed train')
  if (packet.secondary.feed?.rule !== 'inventoryHolding') throw Error('The packet\'s recorded feed state is missing')
  const out: Json = structuredClone(packet)
  out.secondary.feedTrain = section
  out.scope = String(packet.scope) + ' With the compact feed train (header, A/B branches, the three-element cascade) composed.'
  return out
}

const root = 'world/packs/process-plant/reference-designs/ld-01/'
const pages = { control: feedOwners.cascade.page, equipment: feedOwners.pump.page, cycle: feedOwners.cycle.page, instrumentation: feedOwners.level.page } as const
const hash = (s: string) => createHash('sha256').update(s).digest('hex')

if (import.meta.main) {
  const [packetPath, wiki] = Bun.argv.slice(2)
  if (!packetPath || !wiki || Bun.argv.length !== 4) throw Error('Usage: operating-feed-compact <joined packet> <wiki root>')
  const keys = Object.keys(pages) as (keyof typeof pages)[]
  const texts = await Promise.all(keys.map(k => Bun.file(join(wiki, root, pages[k])).text()))
  const p = Object.fromEntries(keys.map((k, i) => [k, texts[i]!])) as CompactPages
  const text = await Bun.file(packetPath).text()
  const composed = composeFeedCompact(JSON.parse(text), compileFeedCompact(p))
  composed.provenance = { ...composed.provenance, feedTrain: { inputPacketSha256: hash(text), sourceSha256: hash(await Bun.file(import.meta.path).text()),
    consumed: keys.map((k, i) => ({ name: root + pages[k], sha256: hash(texts[i]!) })) } }
  console.log(JSON.stringify(composed))
}
