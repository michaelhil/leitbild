/** The S3 `ic` section: acquired protection, the C16 slice of S3 (lead
 * decisions S3-D1.1–21). Channel families, the turbine-trip report, the
 * protective functions and the holding chain's identities. Every number comes
 * from a strict wiki block; a needed value without one is listed under
 * `missing` with its page and section, and its function is not emitted. Rust
 * owns acquisition, voting, qualification, latching and the holding path. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parsePressureChannel, parsePressureProtection } from './reference-design-pressure-observation'
import { parsePzrTaps } from './reference-design-operating-pzr'
import { parseS2Holding } from './reference-design-operating-rods'

/** Pages consumed, relative to the LD-01 design root. */
export const OPERATING_IC_PAGES = [
  'safety/source-and-primary-protection.md',
  'systems/instrumentation/operational-observations.md',
  'systems/instrumentation/phase-dependent-measurements.md',
  'safety/reactor-trip-and-hold.md',
] as const
type Pages = Readonly<Record<(typeof OPERATING_IC_PAGES)[number], string>>

/** Needed values that have no strict block on the compiled wiki (page,
 * section, the prose values). Their functions stay out of the section until
 * the owners add blocks; no value here is consumed. */
export const MISSING_BLOCKS = [
  {
    functions: ['LD01.PROT.SG.A.LOW', 'LD01.PROT.SG.B.LOW', 'LD01.PROT.SG.A.UNAVAILABLE', 'LD01.PROT.SG.B.UNAVAILABLE'],
    needed: [
      { value: 'low actuation 5.00 m; qualification 1.00 s; unavailable 1.00 s; recovered channel 1.00 s; reset band 5.25–8.25 m for 5.00 s',
        page: 'safety/steam-generator-protection.md', section: 'Candidate settings (prose table)' },
      { value: 'NR1/2/3 lag 0.5 s, span 4–9 m', page: 'systems/steam-generation/instrumentation.md', section: 'channel table (prose)' },
      { value: 'protective NR sampling, transport and maximum age (the page defers them to the instrumentation definition)',
        page: 'safety/steam-generator-protection.md', section: 'What constitutes usable evidence' },
      { value: 'collapsed-level area 12 m² (`Vl/12 m²`, decision S3-D1.20)', page: 'systems/steam-generation/thermodynamics.md',
        section: 'Apparent level is not liquid inventory; SG feed/SGTR distribution (prose)' },
    ],
  },
  {
    functions: ['LD01.PROT.RCS.A.LOW_FLOW', 'LD01.PROT.RCS.B.LOW_FLOW', 'loop A/B flow-evidence unavailable'],
    needed: [
      { value: 'FT ≤ 0.70 installed nominal for 0.5 s while the protective proxy vote > 0.20; unavailable FT 0.5 s; reset FT > 0.80 for 5 s',
        page: 'safety/source-and-primary-protection.md', section: 'At-power flow and temperature challenges (prose)' },
      { value: 'RCS.A/B.FT lag 0.25 s, span ±1.5 nominal, 5 kg/s quantization, ±10 kg/s indeterminate band',
        page: 'systems/instrumentation/operational-observations.md', section: 'channel table and main-loop resolution (prose)' },
      { value: 'arming evidence: LD01.CORE.POWER.P1/P2/P3 original reference Iref is uncomputed ("blocks regional proxy installation")',
        page: 'systems/instrumentation/nuclear-observation-apparatus.md', section: 'One original world reference, not ongoing gain adjustment' },
    ],
  },
] as const

/** Compile the `ic` section from page texts keyed as `OPERATING_IC_PAGES`. */
export function compileOperatingIcFrom(texts: Pages) {
  const channel = parsePressureChannel(texts['systems/instrumentation/operational-observations.md'])
  const protection = parsePressureProtection(texts['safety/source-and-primary-protection.md'])
  const taps = parsePzrTaps(texts['systems/instrumentation/phase-dependent-measurements.md'])
  const s2 = parseS2Holding(texts['safety/reactor-trip-and-hold.md'])
  const pt1 = taps.find(t => t.id === 'PT1')
  if (!pt1) throw Error('No PT1 tap')
  // The frame is the protective channels' sampling; transport travels whole
  // frames (the channel schema already requires transport = sampling).
  const frame_s = channel.sample_s
  for (const [name, v] of [['maximum age', protection.maximum_age_s], ['recovery', protection.recovery_s],
    ['high qualification', protection.high_qualification_s], ['low qualification', protection.low_qualification_s],
    ['unavailable qualification', protection.unavailable_qualification_s], ['reset', protection.reset_qualification_s]] as const) {
    const n = v / frame_s
    if (Math.abs(n - Math.round(n)) > 1e-9 * Math.max(1, n)) throw Error(`${name} ${v} s is not whole ${frame_s} s frames`)
  }
  // The turbine controls' report: the reactor-trip page selects "the same
  // 0.1 s reporting/at-most-0.1 s transport, 0.3 s age and one-second recovery
  // qualification used above", the existing protective acquisition, whose
  // numbers are the PZR protective blocks'. S2's declared 0.2 s opening is
  // their worst-case sum (H6) and must agree.
  if (Math.abs(channel.sample_s + channel.transport_s - s2.turbineTripToOpening_s) > 1e-12)
    throw Error('S2 holding boundary disagrees with the protective sampling plus transport')
  const reset = { band: [protection.reset_low_pa, protection.reset_high_pa], duration_s: protection.reset_qualification_s }
  const supplies = ['I1', 'I2', 'I3'] as const
  return {
    identity: 'ld01-s3-ic',
    frame_s,
    families: [{
      id: 'LD01.PZR.PT', quantity: 'pzr_roof_pressure',
      channels: supplies.map((supply, i) => ({ id: `LD01.PZR.PT${i + 1}`, supply })),
      channel: { lag_s: channel.lag_s, min: channel.min_pa, max: channel.max_pa, quantum: channel.quantum_pa,
        sample_s: channel.sample_s, transport_s: channel.transport_s },
      maximum_age_s: protection.maximum_age_s, recovery_s: protection.recovery_s,
    }],
    reports: [{
      id: 'LD01.TG.TRIP.REPORT', source: 'turbine_retained_trip', supply: 'ACT.B',
      sample_s: channel.sample_s, transport_s: channel.transport_s,
      maximum_age_s: protection.maximum_age_s, recovery_s: protection.recovery_s,
      basis: 'reactor-trip-and-hold.md "the same 0.1 s reporting/at-most-0.1 s transport, 0.3 s age and one-second recovery qualification used above": reference-pzr-pressure-channel sample_s/transport_s and reference-pzr-pressure-protection maximum_age_s/recovery_s; no qualification duration is selected for the turbine-trip cause',
    }],
    functions: [
      { id: 'LD01.PROT.PZR.HIGH_PRESSURE',
        rule: { voted: { family: 'LD01.PZR.PT', side: { at_or_above: protection.high_pa }, qualification_s: protection.high_qualification_s } },
        effects: { reactor_trip: true, cmt_injection: false, heater_isolation: true }, reset },
      { id: 'LD01.PROT.PZR.LOW_PRESSURE',
        rule: { voted: { family: 'LD01.PZR.PT', side: { at_or_below: protection.low_pa }, qualification_s: protection.low_qualification_s } },
        effects: { reactor_trip: true, cmt_injection: true, heater_isolation: false }, reset },
      { id: 'LD01.PROT.PZR.PRESSURE.UNAVAILABLE',
        rule: { unavailable: { family: 'LD01.PZR.PT', qualification_s: protection.unavailable_qualification_s } },
        effects: { reactor_trip: true, cmt_injection: false, heater_isolation: true }, reset },
      { id: 'LD01.PROT.TG.TRIP', rule: { report: { report: 'LD01.TG.TRIP.REPORT' } },
        effects: { reactor_trip: true, cmt_injection: false, heater_isolation: false }, reset: null },
    ],
    holding: {
      interface: 'LD01.TRIP.HOLD', supply: 'LD01.DC.ACT.A', manual_interrupt: 'LD01.TRIP.MANUAL',
      divisions: [...supplies], contacts: supplies.map(s => `LD01.TRIP.PERM.${s}`),
    },
    missing: MISSING_BLOCKS,
    provenance: [{ pt1_tap_elevation_m: pt1.elevation_m, pt1_reads: 'the stratified cell roof pressure (operational-observations.md)',
      s2_holding_boundary_replaced_s: s2.turbineTripToOpening_s }],
  }
}

/** Read the owners' pages from the wiki root and return the section with
 * page provenance appended. */
export async function compileOperatingIc(wikiRoot: string) {
  const root = join(wikiRoot, 'world/packs/process-plant/reference-designs/ld-01')
  const texts = Object.fromEntries(await Promise.all(OPERATING_IC_PAGES.map(async page =>
    [page, await Bun.file(join(root, page)).text()] as const))) as Record<(typeof OPERATING_IC_PAGES)[number], string>
  const section = compileOperatingIcFrom(texts)
  return { ...section, provenance: [...section.provenance,
    ...OPERATING_IC_PAGES.map(name => ({ name, sha256: createHash('sha256').update(texts[name]).digest('hex') }))] }
}

if (import.meta.main) {
  const [wiki, ...rest] = Bun.argv.slice(2)
  if (!wiki || rest.length) throw Error('Usage: reference-design-operating-ic <wiki root>')
  console.log(JSON.stringify(await compileOperatingIc(wiki), null, 1))
}
