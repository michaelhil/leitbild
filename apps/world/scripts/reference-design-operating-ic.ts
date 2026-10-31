/** The S3 `ic` section: acquired protection, the C16 slice of S3 (lead
 * decisions S3-D1.1–21, S3-D6, S3-D7). Channel families, the turbine-state
 * report, the protective functions and the holding chain's identities. Every
 * number comes from a strict wiki block; identities that locate a quantity in
 * the model (a loop's cold-return face, an SG, the source regions' axial
 * bounds) come from the joined packet the section is compiled against. Rust
 * owns acquisition, voting, qualification, latching and the holding path. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { parsePressureChannel, parsePressureProtection } from './reference-design-pressure-observation'
import { parsePzrTaps } from './reference-design-operating-pzr'
import { parseS2Holding } from './reference-design-operating-rods'
import { configurationBlock } from './reference-design-source-laws'

/** Pages consumed, relative to the LD-01 design root. */
export const OPERATING_IC_PAGES = [
  'safety/source-and-primary-protection.md',
  'systems/instrumentation/operational-observations.md',
  'systems/instrumentation/phase-dependent-measurements.md',
  'safety/reactor-trip-and-hold.md',
  'safety/steam-generator-protection.md',
  'systems/steam-generation/instrumentation.md',
  'systems/instrumentation/nuclear-observation-apparatus.md',
  'safety/engineered-safety-actuation.md',
  'safety/protection-and-command-precedence.md',
] as const
type Page = (typeof OPERATING_IC_PAGES)[number]
type Pages = Readonly<Record<Page, string>>

const positive = z.number().finite().positive()
const finite = z.number().finite()
const nonnegative = z.number().finite().nonnegative()
const band = z.tuple([finite, finite]).refine(([a, b]) => a < b, 'band must be increasing')
export const parseSgLevelProtection = (text: string) => z.object({
  lowWarning_m: positive, lowActuation_m: positive, highWarning_m: positive, highActuation_m: positive,
  warningClearing_m: positive, demandQualification_s: positive, unavailableQualification_s: positive,
  recoveredChannelQualification_s: positive, resetBand_m: band, resetDuration_s: positive,
}).strict().parse(configurationBlock(text, 'ld01-sg-level-protection'))
export const parseSgLevelAcquisition = (text: string) => z.object({
  sample_s: positive, transport_s: positive, maximumAge_s: positive,
}).strict().parse(configurationBlock(text, 'ld01-sg-level-protective-acquisition'))
export const parseSgLevelChannels = (text: string) => z.object({
  nrLag_s: positive, nrSpan_m: band, indicatedLevelArea_m2: positive,
}).strict().parse(configurationBlock(text, 'ld01-sg-level-channels'))
export const parseLoopLowFlow = (text: string) => z.object({
  lowFlowFractionOfNominal: positive, lowFlowQualification_s: positive, armingProxyFraction: positive,
  unavailableQualification_s: positive, resetFlowFractionOfNominal: positive, resetProxyFraction: positive,
  resetDuration_s: positive,
}).strict().parse(configurationBlock(text, 'ld01-loop-low-flow-protection'))
export const parseLoopFlowChannel = (text: string) => z.object({
  lag_s: positive, spanFractionOfNominal: band, quantum_kg_s: positive, indeterminateBand_kg_s: nonnegative,
  supply: z.object({ A: z.string(), B: z.string() }).strict(),
}).strict().parse(configurationBlock(text, 'ld01-loop-flow-channel'))
// Plan r4 tag map: the bank channels and the steam-valve position convention
// (operational-observations.md).
export const parseBankChannels = (text: string) => z.object({
  position: z.object({ lag_s: positive, span: band, quantum: z.null(), supply: z.string() }).strict(),
  inserted: z.object({ supply: z.string() }).strict(),
  sample_s: positive, transport_s: positive,
}).strict().parse(configurationBlock(text, 'ld01-bank-channels'))
export const parseSteamValvePositionChannels = (text: string) => z.object({
  lag_s: positive, span_percent: band, quantum_percent: positive, sample_s: positive, transport_s: positive,
  supply: z.string(), compiled: z.array(z.literal('LD01.TG.STOP.POS')),
}).strict().parse(configurationBlock(text, 'ld01-steam-valve-position-channels'))
// Plan r4 tag map: LD01.CORE.NI.SHUTDOWN's SOURCE-pulse path
// (nuclear-observation-apparatus.md).
export const parseObservationWindow = (text: string) => z.object({
  window_s: positive, alpha: positive, theta: positive, minimumExcessCount: positive, backgroundRange_s: z.tuple([nonnegative, nonnegative]),
  deadtime_s: positive, maximumOccupancy: positive, sample_s: positive, noiseBound_A: positive, commissionOffsetBound_A: positive, saturation_A: positive,
}).strict().parse(configurationBlock(text, 'reference-nuclear-observation-window'))
export const parseSourceRangePulse = (text: string) => z.object({
  rrefEventsPerS: positive.nullable(), darkPerS: nonnegative, supply: z.string(), seed: z.number().int().nonnegative(), maximumAge_s: positive,
}).strict().parse(configurationBlock(text, 'ld01-source-range-pulse'))
export const parseTurbineStateReport = (text: string) => z.object({
  sample_s: positive, transport_s: positive, maximumAge_s: positive, recovery_s: positive,
}).strict().parse(configurationBlock(text, 'ld01-turbine-state-report'))
export const parseRegionalCurrentReference = (text: string) => z.object({
  eventReferencePower_W: positive, eventEnergy_MeV: positive, Fref_events_per_s: positive,
  convertedSpan_m: band, form: z.literal('proxy = (E_c/E_c_ref) * (E_tot_ref/Fref)'),
}).strict().parse(configurationBlock(text, 'ld01-regional-current-reference'))
export const parsePowerProxyPaths = (text: string) => z.object({
  filter_s: positive, supplies: z.tuple([z.string(), z.string(), z.string()]), sample_s: positive,
  transport_s: positive, maximumAge_s: positive, recovery_s: positive,
}).strict().parse(configurationBlock(text, 'ld01-power-proxy-protective-paths'))

/** PRHR actuation (`ld01-prhr-actuation`, owner R12-A1): AP1000's signal set
 * only, never the accepted reactor trip itself. `causes` names the compiled
 * functions that request PRHR besides CMT actuation. */
export const parsePrhrActuation = (text: string) => z.object({
  onAcceptedReactorTrip: z.literal(false), onCmtActuation: z.literal(true), causes: z.array(z.string()).min(1),
  high3Timer_s: positive,
}).strict().parse(configurationBlock(text, 'ld01-prhr-actuation'))

/** CMT on AP1000's basis (`ld01-cmt-actuation`, owner R12-B3): the "S" signal on
 * low PZR pressure and the low-2 PZR level request CMT injection; the 13 MPa
 * low-pressure trip no longer does. */
export const parseCmtActuation = (text: string) => z.object({
  sPressure_Pa: positive, sQualification_s: positive, low2Level_m: finite, low2Qualification_s: positive,
}).strict().parse(configurationBlock(text, 'ld01-cmt-actuation'))

/** RCP underspeed (`ld01-rcp-underspeed-protection`, owner R12-D2): per RCP a
 * single shaft-speed channel in fractions of the drive's reference speed,
 * armed by the protective proxy (AP1000's P-10); the chain lag + sampling +
 * transport + qualification is AP1000's 0.767 s. */
export const parseRcpUnderspeed = (text: string) => z.object({
  underspeedFractionOfNominal: positive, qualification_s: positive, speedLag_s: positive, spanFractionOfNominal: band,
  armingProxyFraction: positive, supply: z.object({ A: z.string(), B: z.string() }).strict(),
  resetFractionOfNominal: positive, resetDuration_s: positive, totalDelay_s: positive,
}).strict().parse(configurationBlock(text, 'ld01-rcp-underspeed-protection'))

/** The reactor-trip → turbine-trip interlock (`ld01-reactor-trip-turbine-trip`,
 * owner R12-A2): the holding loss requests the existing turbine trip after
 * the delay, under the named cause. */
export const parseReactorTripTurbineTrip = (text: string) => z.object({
  cause: z.string().min(1), delay_s: positive, initiation: z.literal('LD01.TRIP.HOLD loss'),
}).strict().parse(configurationBlock(text, 'ld01-reactor-trip-turbine-trip'))

/** The PZR LT devices (`ld01-pzr-level-channels`, S3-D37/S3-D38): the fixed
 * saturated-water calibration pressure, the device lag, the interface span,
 * the indicated span and resolution, and the I-group supplies. */
export const parsePzrLevelChannels = (text: string) => z.object({
  calibrationPressure_Pa: positive, lag_s: positive, interfaceSpan_Pa: band, indicatedSpan_m: band,
  quantum_m: positive, supplies: z.tuple([z.string(), z.string(), z.string()]),
}).strict().parse(configurationBlock(text, 'ld01-pzr-level-channels'))
/** The PZR level protection settings (`ld01-pzr-level-protection`). */
export const parsePzrLevelProtection = (text: string) => z.object({
  lowLevel_m: finite, lowQualification_s: positive, highLevel_m: finite, highQualification_s: positive,
  unavailableQualification_s: positive, resetBand_m: band, resetDuration_s: positive,
}).strict().parse(configurationBlock(text, 'ld01-pzr-level-protection'))

/** The PZR LT family and C2.N3's recorded vote, from the two blocks and the
 * page-wide protective timing (the PT/LT families share it: "For these
 * protection channels select 0.1 s ..." on the PZR protection page). The vote
 * is recorded only: LD01.PROT.PZR.LOW_LEVEL is not implemented in S3 (S3-D21). */
export function compilePzrLevelFrom(texts: { measurements: string, observations: string, protection: string }) {
  const levelChannels = parsePzrLevelChannels(texts.measurements)
  const levelProtection = parsePzrLevelProtection(texts.protection)
  const channel = parsePressureChannel(texts.observations)
  const timing = parsePressureProtection(texts.protection)
  const taps = parsePzrTaps(texts.measurements)
  const low = taps.find(t => t.id === 'LT.LOW'), high = taps.find(t => t.id === 'LT.HIGH')
  if (!low || !high || !(high.elevation_m > low.elevation_m)) throw Error('The LT taps must be a rising pair')
  wholeFrames('LT low-level qualification', levelProtection.lowQualification_s, channel.sample_s)
  const family = {
    id: 'LD01.PZR.LT',
    quantity: { pzr_level: { calibration_pressure_pa: levelChannels.calibrationPressure_Pa, interface_span_pa: levelChannels.interfaceSpan_Pa } },
    channels: levelChannels.supplies.map((supply, i) => ({ id: `LD01.PZR.LT${i + 1}`, supply })),
    channel: { lag_s: levelChannels.lag_s, min: levelChannels.indicatedSpan_m[0], max: levelChannels.indicatedSpan_m[1],
      quantum: levelChannels.quantum_m, indeterminate_band: null, sample_s: channel.sample_s, transport_s: channel.transport_s },
    maximum_age_s: timing.maximum_age_s, recovery_s: timing.recovery_s,
  }
  // LD01.PROT.PZR.HIGH_LEVEL (the owner table's high-level function, the
  // AP1000 high-3 level's place in PRHR's signal set, R12-A1): reactor trip;
  // its ordinary-charging stop has no actuator in S3 (S3-D2).
  wholeFrames('LT high-level qualification', levelProtection.highQualification_s, channel.sample_s)
  const highLevel = {
    id: 'LD01.PROT.PZR.HIGH_LEVEL',
    rule: { voted: { family: 'LD01.PZR.LT', side: { at_or_above: levelProtection.highLevel_m }, qualification_s: levelProtection.highQualification_s } },
    reset: { band: levelProtection.resetBand_m, duration_s: levelProtection.resetDuration_s },
  }
  const monitors = [{
    id: 'C2.N3 PZR LT vote',
    rule: { voted: { family: 'LD01.PZR.LT', side: { at_or_below: levelProtection.lowLevel_m }, qualification_s: levelProtection.lowQualification_s } },
    basis: 'ld01-pzr-level-protection lowLevel_m/lowQualification_s; recorded only: LD01.PROT.PZR.LOW_LEVEL is not implemented in S3 (S3-D21)',
  }]
  return { family, monitors, highLevel }
}

/** What the section reads from the joined packet it is compiled against. */
export const packetSchema = z.object({
  mechanics: z.object({ faces: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough(),
  hydraulics: z.object({ sections: z.array(z.object({ id: z.string(), parameters: z.object({ pump: z.unknown() }).passthrough() }).passthrough()) }).passthrough(),
  secondary: z.object({ steamGenerators: z.array(z.object({ id: z.string() }).passthrough()),
    apparentLevel: z.object({ indication: z.object({ indicatedLevelArea_m2: finite }).passthrough() }).passthrough().optional(),
    steamAdmission: z.object({ stopTravel_s: positive }).passthrough().optional() }).passthrough(),
  feedback_metadata: z.object({ regions: z.array(z.object({ z0_m: finite, z1_m: finite }).passthrough()) }).passthrough(),
  // Plan r4 X4.2: a packet composing the CVCS (reference-design-operating-cvcs.ts).
  cvcs: z.object({ controller: z.object({ flowLag_s: finite, flowSpan_kg_s: z.tuple([finite, finite]) }).passthrough() }).passthrough().optional(),
  // Plan r4 tag map: the bank's normal stroke and the STOP's travel, when the
  // packet composes the rods and the steam admission.
  rods: z.object({ normal_travel_m: positive }).passthrough().optional(),
}).passthrough()
type Packet = z.infer<typeof packetSchema>

/** Still without a strict block, or a value the owners have not selected. */
export const OPEN_ITEMS = [
  { item: 'LD01.SG.*.LT.NR1–3 instrument supply groups', note: 'no group is selected; S3 injects no NR supply loss, so the channels carry the label "unselected"' },
  { item: 'loop A/B flow-evidence-unavailable cause ID', note: 'the wiki names the cause but gives no ID; compiled as LD01.PROT.RCS.<loop>.FLOW.UNAVAILABLE' },
  { item: 'ld01-power-proxy-protective-paths', note: 'proposed by IC-PROT on claude/ld01-s3-ic-prot2-wiki (prose values only); needs the lead\'s decision row' },
  { item: 'loop FT protective timing', note: 'compiled as the page-wide protective timing of source-and-primary-protection.md (reference-pzr-pressure-channel sample/transport, reference-pzr-pressure-protection age/recovery), as ld01-turbine-state-report states for its report; the lead to confirm' },
  { item: 'installed nominal loop flow', note: 'resolved natively as the loop cold-return mass flow at the packet\'s prepared hot reference (S3-D7\'s reference state); no strict block holds a kg/s value' },
  { item: 'RCP speed evidence-unavailable cause (R12-D2)', note: 'no unavailable cause or qualification is selected for the single LD01.RCP.*.SPEED channels; an unusable channel votes nothing' },
  { item: 'RCP underspeed on bus frequency (R12-D2)', note: 'the S3/G1 RCP drive does not follow bus frequency (Supported(Nominal) or Unsupported), so underspeed sees coastdowns only; the drive-frequency wiring is phase 2 (J-CTRL, GRID)' },
  { item: 'PRHR on low SG wide-range level (R12-A1)', note: 'selected by ld01-prhr-actuation\'s page; LD01.SG.*.LT.WR has no protective acquisition and no setting is selected (AP1000: 55,000 lbm, T15.0-4a): Phase 2 (SG-LEVEL, J-CTRL)' },
  { item: 'PRHR on low SG narrow-range level with low feed flow (R12-A1)', note: 'selected by ld01-prhr-actuation\'s page; no low-feed-flow setting is selected and feed is a recorded boundary until J-FEED: Phase 2 (J-FEED, J-CTRL)' },
] as const

function wholeFrames(name: string, v: number, frame: number) {
  const n = v / frame
  if (Math.abs(n - Math.round(n)) > 1e-9 * Math.max(1, n)) throw Error(`${name} ${v} s is not whole ${frame} s frames`)
}

/** Compile the `ic` section from page texts keyed as `OPERATING_IC_PAGES`
 * and the joined packet. */
export function compileOperatingIcFrom(texts: Pages, packetValue: unknown) {
  const packet: Packet = packetSchema.parse(packetValue)
  const channel = parsePressureChannel(texts['systems/instrumentation/operational-observations.md'])
  const protection = parsePressureProtection(texts['safety/source-and-primary-protection.md'])
  const taps = parsePzrTaps(texts['systems/instrumentation/phase-dependent-measurements.md'])
  const s2 = parseS2Holding(texts['safety/reactor-trip-and-hold.md'])
  const report = parseTurbineStateReport(texts['safety/reactor-trip-and-hold.md'])
  const sgProtection = parseSgLevelProtection(texts['safety/steam-generator-protection.md'])
  const sgAcquisition = parseSgLevelAcquisition(texts['safety/steam-generator-protection.md'])
  const sgChannels = parseSgLevelChannels(texts['systems/steam-generation/instrumentation.md'])
  const lowFlow = parseLoopLowFlow(texts['safety/source-and-primary-protection.md'])
  const flowChannel = parseLoopFlowChannel(texts['systems/instrumentation/operational-observations.md'])
  const proxyPaths = parsePowerProxyPaths(texts['systems/instrumentation/operational-observations.md'])
  const reference = parseRegionalCurrentReference(texts['systems/instrumentation/nuclear-observation-apparatus.md'])
  const pzrLevel = compilePzrLevelFrom({ measurements: texts['systems/instrumentation/phase-dependent-measurements.md'],
    observations: texts['systems/instrumentation/operational-observations.md'], protection: texts['safety/source-and-primary-protection.md'] })
  const prhrActuation = parsePrhrActuation(texts['safety/engineered-safety-actuation.md'])
  const interlock = parseReactorTripTurbineTrip(texts['safety/protection-and-command-precedence.md'])
  const underspeed = parseRcpUnderspeed(texts['safety/source-and-primary-protection.md'])
  const cmt = parseCmtActuation(texts['safety/source-and-primary-protection.md'])
  const bank = parseBankChannels(texts['systems/instrumentation/operational-observations.md'])
  const window = parseObservationWindow(texts['systems/instrumentation/nuclear-observation-apparatus.md'])
  const pulse = parseSourceRangePulse(texts['systems/instrumentation/nuclear-observation-apparatus.md'])
  // The window's sample and the path's transport are the canonical 0.1 s frontend.
  const sourceRange = pulse.rrefEventsPerS === null ? null : {
    id: 'LD01.CORE.NI.SHUTDOWN', supply: pulse.supply, rref_events_per_s: pulse.rrefEventsPerS, dark_per_s: pulse.darkPerS,
    deadtime_s: window.deadtime_s, window_s: window.window_s, alpha: window.alpha, theta: window.theta,
    minimum_excess_count: window.minimumExcessCount, background_per_s: window.backgroundRange_s, maximum_occupancy: window.maximumOccupancy,
    sample_s: window.sample_s, transport_s: channel.transport_s, maximum_age_s: pulse.maximumAge_s, seed: pulse.seed,
  }
  const valves = parseSteamValvePositionChannels(texts['systems/instrumentation/operational-observations.md'])
  if (!(cmt.sPressure_Pa < protection.low_pa)) throw Error('The "S" pressure must lie below the low-pressure trip (R12-B3)')
  const pt1 = taps.find(t => t.id === 'PT1')
  if (!pt1) throw Error('No PT1 tap')
  const frame_s = channel.sample_s
  for (const [name, v] of [['maximum age', protection.maximum_age_s], ['recovery', protection.recovery_s],
    ['high qualification', protection.high_qualification_s], ['low qualification', protection.low_qualification_s],
    ['unavailable qualification', protection.unavailable_qualification_s], ['reset', protection.reset_qualification_s],
    ['report sampling', report.sample_s], ['report transport', report.transport_s], ['report age', report.maximumAge_s],
    ['report recovery', report.recovery_s], ['SG sampling', sgAcquisition.sample_s], ['SG transport', sgAcquisition.transport_s],
    ['SG age', sgAcquisition.maximumAge_s], ['SG demand', sgProtection.demandQualification_s],
    ['SG unavailable', sgProtection.unavailableQualification_s], ['SG recovery', sgProtection.recoveredChannelQualification_s],
    ['SG reset', sgProtection.resetDuration_s], ['low flow', lowFlow.lowFlowQualification_s],
    ['flow unavailable', lowFlow.unavailableQualification_s], ['flow reset', lowFlow.resetDuration_s],
    ['proxy sampling', proxyPaths.sample_s], ['proxy transport', proxyPaths.transport_s], ['proxy age', proxyPaths.maximumAge_s],
    ['proxy recovery', proxyPaths.recovery_s], ['turbine trip on reactor trip', interlock.delay_s], ['underspeed', underspeed.qualification_s],
    ['underspeed reset', underspeed.resetDuration_s], ['S pressure', cmt.sQualification_s],
    ['low-2 level', cmt.low2Qualification_s], ['high-3 PRHR timer', prhrActuation.high3Timer_s],
    ['bank sampling', bank.sample_s], ['bank transport', bank.transport_s],
    ['valve sampling', valves.sample_s], ['valve transport', valves.transport_s]] as const) wholeFrames(name, v, frame_s)
  // R12-D2: the chain reproduces AP1000's total delay exactly.
  if (Math.abs(underspeed.speedLag_s + channel.sample_s + channel.transport_s + underspeed.qualification_s - underspeed.totalDelay_s) > 1e-12)
    throw Error('RCP underspeed chain (lag + sample + transport + qualification) disagrees with its total delay')
  if (Math.abs(report.sample_s + report.transport_s - s2.turbineTripToOpening_s) > 1e-12)
    throw Error('S2 holding boundary disagrees with the turbine-state report')
  // Fref is the ORIGINAL event reference: check the block's arithmetic.
  const fref = reference.eventReferencePower_W / (reference.eventEnergy_MeV * 1e6 * 1.602176634e-19)
  if (Math.abs(fref / reference.Fref_events_per_s - 1) > 1e-6) throw Error('Fref disagrees with 3 GW / 200 MeV')
  // The converter's coated span sits in the vessel-fixed thimble at the
  // central assembly, on all four sector boundaries (the source compiler's
  // capsule convention): each sector's region holds a quarter of it, weighted
  // by the axial overlap of the span with the region.
  const regions = packet.feedback_metadata.regions
  const [s0, s1] = reference.convertedSpan_m
  const atHeight = (z: number) => regions.filter(r => z >= r.z0_m && z < r.z1_m).length
  if (atHeight((s0 + s1) / 2) !== 4) throw Error('Expected four sector regions at the converter height')
  const weights = regions.map(r => .25 * Math.max(0, Math.min(s1, r.z1_m) - Math.max(s0, r.z0_m)) / (s1 - s0))
  if (Math.abs(weights.reduce((a, b) => a + b, 0) - 1) > 1e-12) throw Error('Converter span not fully represented')
  const faceIndex = (id: string) => {
    const i = packet.mechanics.faces.findIndex(f => f.id === id)
    if (i < 0) throw Error(`No face ${id}`)
    return i
  }
  const sgs = packet.secondary.steamGenerators.map(g => g.id)
  if (sgs.join() !== 'A,B') throw Error(`Expected SGs A and B, found ${sgs}`)
  const supplies = ['I1', 'I2', 'I3'] as const
  const pressureReset = { band: [protection.reset_low_pa, protection.reset_high_pa], duration_s: protection.reset_qualification_s }
  const sgReset = { band: sgProtection.resetBand_m, duration_s: sgProtection.resetDuration_s }
  const flowReset = { band: [lowFlow.resetFlowFractionOfNominal, flowChannel.spanFractionOfNominal[1]], duration_s: lowFlow.resetDuration_s }
  // R12-A1: PRHR follows CMT actuation and the block's named causes only.
  const effects = (id: string, e: { reactor_trip: boolean, cmt_injection: boolean, heater_isolation: boolean }) =>
    ({ ...e, prhr: (prhrActuation.onCmtActuation && e.cmt_injection) || prhrActuation.causes.includes(id) })
  const trip = { reactor_trip: true, cmt_injection: false, heater_isolation: false }
  // S5 (C08, S4-D10 (a)): with the packet's apparent-level allocation the
  // NR channels read the apparent level (V_l + V_sub)/A; without it, S3's
  // declared collapsed-level limit (S3-D1.20).
  const apparent = packet.secondary.apparentLevel
  if (apparent && apparent.indication.indicatedLevelArea_m2 !== sgChannels.indicatedLevelArea_m2)
    throw Error('The packet\'s apparent level and the NR channels must use one indicated-level area')
  const level = (sg: string) => apparent
    ? { sg_apparent_level: { sg, area_m2: sgChannels.indicatedLevelArea_m2 } }
    : { sg_collapsed_level: { sg, area_m2: sgChannels.indicatedLevelArea_m2 } }
  const sgFamilies = sgs.map(sg => ({
    id: `LD01.SG.${sg}.LT.NR`, quantity: level(sg),
    channels: [1, 2, 3].map(i => ({ id: `LD01.SG.${sg}.LT.NR${i}`, supply: 'unselected' })),
    channel: { lag_s: sgChannels.nrLag_s, min: sgChannels.nrSpan_m[0], max: sgChannels.nrSpan_m[1], quantum: null,
      indeterminate_band: null, sample_s: sgAcquisition.sample_s, transport_s: sgAcquisition.transport_s },
    maximum_age_s: sgAcquisition.maximumAge_s, recovery_s: sgProtection.recoveredChannelQualification_s,
  }))
  const loops = ['A', 'B'] as const
  const flowFamilies = loops.map(loop => ({
    id: `LD01.RCS.${loop}.FT`,
    quantity: { loop_flow: { loop_id: loop, face: faceIndex(`RETURN.${loop}->DOWN`), face_id: `RETURN.${loop}->DOWN`,
      nominal_kg_s: null, quantum_kg_s: flowChannel.quantum_kg_s, indeterminate_band_kg_s: flowChannel.indeterminateBand_kg_s } },
    channels: [{ id: `LD01.RCS.${loop}.FT`, supply: flowChannel.supply[loop] }],
    channel: { lag_s: flowChannel.lag_s, min: flowChannel.spanFractionOfNominal[0], max: flowChannel.spanFractionOfNominal[1],
      quantum: null, indeterminate_band: null, sample_s: channel.sample_s, transport_s: channel.transport_s },
    maximum_age_s: protection.maximum_age_s, recovery_s: protection.recovery_s,
  }))
  // R12-D2: the network's rotors are the hydraulic sections with a pump, in
  // packet order; one speed channel each, on its loop's FT supply group.
  const rotors = packet.hydraulics.sections.filter(h => h.parameters.pump != null).map(h => h.id)
  if (rotors.join() !== 'PUMP.A1,PUMP.A2,PUMP.B1,PUMP.B2') throw Error(`Expected four RCPs, found ${rotors}`)
  const speedFamilies = rotors.map((id, rotor) => {
    const pump = id.slice('PUMP.'.length), loop = pump[0] as 'A' | 'B'
    return {
      id: `LD01.RCP.${pump}.SPEED`, quantity: { pump_speed: { rotor, rotor_id: id } },
      channels: [{ id: `LD01.RCP.${pump}.SPEED`, supply: underspeed.supply[loop] }],
      channel: { lag_s: underspeed.speedLag_s, min: underspeed.spanFractionOfNominal[0], max: underspeed.spanFractionOfNominal[1],
        quantum: null, indeterminate_band: null, sample_s: channel.sample_s, transport_s: channel.transport_s },
      maximum_age_s: protection.maximum_age_s, recovery_s: protection.recovery_s,
    }
  })
  // Plan r4 tag map: acquired, observed only (no function reads them); the
  // page-wide protective age and recovery, as the loop FTs take them.
  const bankFamilies = packet.rods ? [{
    id: 'LD01.CORE.BANK.POS', quantity: { bank_position: { normal_travel_m: packet.rods.normal_travel_m } },
    channels: [{ id: 'LD01.CORE.BANK.POS', supply: bank.position.supply }],
    channel: { lag_s: bank.position.lag_s, min: bank.position.span[0], max: bank.position.span[1], quantum: null,
      indeterminate_band: null, sample_s: bank.sample_s, transport_s: bank.transport_s },
    maximum_age_s: protection.maximum_age_s, recovery_s: protection.recovery_s,
  }] : []
  const stop = packet.secondary.steamAdmission
  const valveFamilies = stop ? [{
    id: 'LD01.TG.STOP.POS', quantity: { stop_valve_position: { stop_travel_s: stop.stopTravel_s } },
    channels: [{ id: 'LD01.TG.STOP.POS', supply: valves.supply }],
    channel: { lag_s: valves.lag_s, min: valves.span_percent[0], max: valves.span_percent[1], quantum: valves.quantum_percent,
      indeterminate_band: null, sample_s: valves.sample_s, transport_s: valves.transport_s },
    maximum_age_s: protection.maximum_age_s, recovery_s: protection.recovery_s,
  }] : []
  const proxyFamily = {
    id: 'LD01.CORE.POWER.P',
    quantity: { current_proxy: { weights, fref_events_per_s: reference.Fref_events_per_s } },
    channels: proxyPaths.supplies.map((supply, i) => ({ id: `LD01.CORE.POWER.P${i + 1}`, supply })),
    channel: { lag_s: proxyPaths.filter_s, min: null, max: null, quantum: null, indeterminate_band: null,
      sample_s: proxyPaths.sample_s, transport_s: proxyPaths.transport_s },
    maximum_age_s: proxyPaths.maximumAge_s, recovery_s: proxyPaths.recovery_s,
  }
  const rawFunctions = [
    { id: 'LD01.PROT.PZR.HIGH_PRESSURE',
      rule: { voted: { family: 'LD01.PZR.PT', side: { at_or_above: protection.high_pa }, qualification_s: protection.high_qualification_s } },
      effects: { reactor_trip: true, cmt_injection: false, heater_isolation: true }, reset: pressureReset },
    { id: 'LD01.PROT.PZR.LOW_PRESSURE',
      rule: { voted: { family: 'LD01.PZR.PT', side: { at_or_below: protection.low_pa }, qualification_s: protection.low_qualification_s } },
      effects: { reactor_trip: true, cmt_injection: false, heater_isolation: false }, reset: pressureReset },
    // R12-B3: CMT on the "S" signal (low PZR pressure), not the 13 MPa trip.
    { id: 'LD01.PROT.PZR.S_PRESSURE',
      rule: { voted: { family: 'LD01.PZR.PT', side: { at_or_below: cmt.sPressure_Pa }, qualification_s: cmt.sQualification_s } },
      effects: { reactor_trip: true, cmt_injection: true, heater_isolation: false }, reset: pressureReset },
    { id: 'LD01.PROT.PZR.PRESSURE.UNAVAILABLE',
      rule: { unavailable: { family: 'LD01.PZR.PT', qualification_s: protection.unavailable_qualification_s } },
      effects: { reactor_trip: true, cmt_injection: false, heater_isolation: true }, reset: pressureReset },
    { id: 'LD01.PROT.TG.TRIP', rule: { report: { report: 'LD01.TG.TRIP.REPORT' } }, effects: trip, reset: null },
    ...sgs.flatMap(sg => [
      { id: `LD01.PROT.SG.${sg}.LOW`,
        rule: { voted: { family: `LD01.SG.${sg}.LT.NR`, side: { at_or_below: sgProtection.lowActuation_m }, qualification_s: sgProtection.demandQualification_s } },
        effects: trip, reset: sgReset },
      { id: `LD01.PROT.SG.${sg}.UNAVAILABLE`,
        rule: { unavailable: { family: `LD01.SG.${sg}.LT.NR`, qualification_s: sgProtection.unavailableQualification_s } },
        effects: trip, reset: sgReset },
    ]),
    ...loops.flatMap(loop => [
      { id: `LD01.PROT.RCS.${loop}.LOW_FLOW`,
        rule: { armed: { family: `LD01.RCS.${loop}.FT`, side: { at_or_below: lowFlow.lowFlowFractionOfNominal },
          qualification_s: lowFlow.lowFlowQualification_s, arming_family: 'LD01.CORE.POWER.P', arming: { above: lowFlow.armingProxyFraction } } },
        effects: trip, reset: flowReset },
      { id: `LD01.PROT.RCS.${loop}.FLOW.UNAVAILABLE`,
        rule: { armed_unavailable: { family: `LD01.RCS.${loop}.FT`, qualification_s: lowFlow.unavailableQualification_s,
          arming_family: 'LD01.CORE.POWER.P', arming: { above: lowFlow.armingProxyFraction } } },
        effects: trip, reset: flowReset },
    ]),
    { ...pzrLevel.highLevel, effects: trip },
    // CRED-FIX-A2: PRHR on the high-3 level after AP1000's 15 s timer, the
    // high-level setting held for its qualification plus the timer; PRHR only.
    { id: 'LD01.PROT.PZR.HIGH_3_PRHR',
      rule: { voted: { family: 'LD01.PZR.LT', side: pzrLevel.highLevel.rule.voted.side,
        qualification_s: pzrLevel.highLevel.rule.voted.qualification_s + prhrActuation.high3Timer_s } },
      effects: { reactor_trip: false, cmt_injection: false, heater_isolation: false }, reset: pzrLevel.highLevel.reset },
    // R12-B3: CMT on the low-2 PZR level (0 % of the tap span).
    { id: 'LD01.PROT.PZR.LOW_2_LEVEL',
      rule: { voted: { family: 'LD01.PZR.LT', side: { at_or_below: cmt.low2Level_m }, qualification_s: cmt.low2Qualification_s } },
      effects: { reactor_trip: true, cmt_injection: true, heater_isolation: false }, reset: pzrLevel.highLevel.reset },
    ...speedFamilies.map(f => ({
      id: `LD01.PROT.RCS.${f.id.split('.')[2]}.UNDERSPEED`,
      rule: { armed: { family: f.id, side: { at_or_below: underspeed.underspeedFractionOfNominal }, qualification_s: underspeed.qualification_s,
        arming_family: 'LD01.CORE.POWER.P', arming: { above: underspeed.armingProxyFraction } } },
      effects: trip, reset: { band: [underspeed.resetFractionOfNominal, underspeed.spanFractionOfNominal[1]], duration_s: underspeed.resetDuration_s },
    })),
  ]
  const functions = rawFunctions.map(f => ({ ...f, effects: effects(f.id, f.effects) }))
  // Plan r4 X4.2: with the packet's CVCS, the two normal-inventory FTs, one
  // I2 channel each ("Each branch has a signed effective total-stream
  // measured-flow channel, −7.5 to +7.5 kg/s range and 0.25 s lag, on I2",
  // inventory-and-chemistry.md, as the packet's ld01-cvcs-controller carries
  // it); observed only, no function reads them.
  const cvcsFamilies = packet.cvcs ? (['Charging', 'Letdown'] as const).map(branch => {
    const id = branch === 'Charging' ? 'LD01.INV.CHARGE.FT' : 'LD01.INV.LETDOWN.FT'
    const c = packet.cvcs!.controller
    return { id, quantity: { cvcs_flow: { branch } }, channels: [{ id, supply: 'I2' }],
      channel: { lag_s: c.flowLag_s, min: c.flowSpan_kg_s[0], max: c.flowSpan_kg_s[1], quantum: null, indeterminate_band: null,
        sample_s: channel.sample_s, transport_s: channel.transport_s },
      maximum_age_s: protection.maximum_age_s, recovery_s: protection.recovery_s }
  }) : []
  for (const c of prhrActuation.causes) if (!functions.some(f => f.id === c)) throw Error(`ld01-prhr-actuation names ${c}, which is not compiled`)
  return {
    identity: 'ld01-s3-ic',
    frame_s,
    families: [{
      id: 'LD01.PZR.PT', quantity: 'pzr_roof_pressure',
      channels: supplies.map((supply, i) => ({ id: `LD01.PZR.PT${i + 1}`, supply })),
      channel: { lag_s: channel.lag_s, min: channel.min_pa, max: channel.max_pa, quantum: channel.quantum_pa,
        indeterminate_band: null, sample_s: channel.sample_s, transport_s: channel.transport_s },
      maximum_age_s: protection.maximum_age_s, recovery_s: protection.recovery_s,
    }, pzrLevel.family, ...sgFamilies, ...flowFamilies, proxyFamily, ...speedFamilies, ...bankFamilies, ...valveFamilies, ...cvcsFamilies],
    reports: [{
      id: 'LD01.TG.TRIP.REPORT', source: 'turbine_retained_trip', supply: 'ACT.B',
      sample_s: report.sample_s, transport_s: report.transport_s, maximum_age_s: report.maximumAge_s, recovery_s: report.recovery_s,
      basis: 'ld01-turbine-state-report (reactor-trip-and-hold.md); no qualification duration is selected for LD01.PROT.TG.TRIP',
    }, ...(packet.rods ? [{
      id: 'LD01.CORE.BANK.INSERTED', source: 'bank_inserted', supply: bank.inserted.supply,
      sample_s: bank.sample_s, transport_s: bank.transport_s, maximum_age_s: protection.maximum_age_s, recovery_s: protection.recovery_s,
      basis: 'ld01-bank-channels (operational-observations.md); the page-wide protective age and recovery; observed only',
    }] : [])],
    functions,
    monitors: pzrLevel.monitors,
    holding: {
      interface: 'LD01.TRIP.HOLD', supply: 'LD01.DC.ACT.A', manual_interrupt: 'LD01.TRIP.MANUAL',
      divisions: [...supplies], contacts: supplies.map(s => `LD01.TRIP.PERM.${s}`),
    },
    turbine_trip_on_reactor_trip: { cause: interlock.cause, delay_s: interlock.delay_s,
      basis: 'ld01-reactor-trip-turbine-trip (protection-and-command-precedence.md, R12-A2): LD01.TRIP.HOLD loss requests LD01.TG TRIP after delay_s; AP1000 DCD Rev. 19 Tier 2 15.0.14' },
    ...(sourceRange ? { source_range: sourceRange } : {}),
    missing: sourceRange ? OPEN_ITEMS : [...OPEN_ITEMS, { item: 'LD01.CORE.NI.SHUTDOWN regional Rref',
      note: 'ld01-source-range-pulse rrefEventsPerS is open: the regional collected-event intensity at the original reference field (NUC); no SOURCE path is compiled until it is filled' }],
    provenance: [{ pt1_tap_elevation_m: pt1.elevation_m, pt1_reads: 'the stratified cell roof pressure (operational-observations.md)',
      s2_holding_boundary_replaced_s: s2.turbineTripToOpening_s, converter_region_weights: weights,
      fref_check_events_per_s: fref, flow_reset_band_upper: 'the FT span top (the reset needs only FT above 0.80 nominal)',
      prhr_actuation: 'ld01-prhr-actuation (R12-A1): CMT actuation and ' + prhrActuation.causes.join(', ') + '; not the reactor trip' }],
  }
}

/** Read the owners' pages from the wiki root and the joined packet, and
 * return the section with page and packet provenance appended. */
export async function compileOperatingIc(wikiRoot: string, packetPath: string) {
  const root = join(wikiRoot, 'world/packs/process-plant/reference-designs/ld-01')
  const texts = Object.fromEntries(await Promise.all(OPERATING_IC_PAGES.map(async page =>
    [page, await Bun.file(join(root, page)).text()] as const))) as Record<Page, string>
  const packetText = await Bun.file(packetPath).text()
  const section = compileOperatingIcFrom(texts, JSON.parse(packetText))
  return { ...section, provenance: [...section.provenance,
    ...OPERATING_IC_PAGES.map(name => ({ name, sha256: createHash('sha256').update(texts[name]).digest('hex') })),
    { packet: packetPath, sha256: createHash('sha256').update(packetText).digest('hex') }] }
}

if (import.meta.main) {
  const [wiki, packet, ...rest] = Bun.argv.slice(2)
  if (!wiki || !packet || rest.length) throw Error('Usage: reference-design-operating-ic <wiki root> <joined packet>')
  console.log(JSON.stringify(await compileOperatingIc(wiki, packet), null, 1))
}
