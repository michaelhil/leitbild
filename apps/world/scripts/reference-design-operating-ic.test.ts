import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { compileOperatingIc, compileOperatingIcFrom, compilePzrLevelFrom, OPEN_ITEMS, OPERATING_IC_PAGES } from './reference-design-operating-ic'

const fence = (name: string, body: string) => '```' + name + '\n' + body + '\n```\n'
const channel = '{"lag_s":0.2,"min_pa":0,"max_pa":20000000,"quantum_pa":1000,"sample_s":0.1,"transport_s":0.1}'
const protection = '{"maximum_age_s":0.3,"recovery_s":1,"high_pa":15500000,"high_qualification_s":0.2,"low_pa":13000000,"low_qualification_s":0.5,"unavailable_qualification_s":1,"reset_low_pa":13500000,"reset_high_pa":15200000,"reset_qualification_s":5}'
const lowFlow = '{"lowFlowFractionOfNominal":0.7,"lowFlowQualification_s":0.5,"armingProxyFraction":0.2,"unavailableQualification_s":0.5,"resetFlowFractionOfNominal":0.8,"resetProxyFraction":0.05,"resetDuration_s":5}'
const flowChannel = '{"lag_s":0.25,"spanFractionOfNominal":[-1.5,1.5],"quantum_kg_s":5,"indeterminateBand_kg_s":10,"supply":{"A":"I1","B":"I2"}}'
const proxyPaths = '{"filter_s":0.2,"supplies":["I1","I2","I3"],"sample_s":0.1,"transport_s":0.1,"maximumAge_s":0.3,"recovery_s":1}'
const sgProtection = '{"lowWarning_m":5.75,"lowActuation_m":5.0,"highWarning_m":8.0,"highActuation_m":8.5,"warningClearing_m":0.25,"demandQualification_s":1.0,"unavailableQualification_s":1.0,"recoveredChannelQualification_s":1.0,"resetBand_m":[5.25,8.25],"resetDuration_s":5.0}'
const reference = '{"eventReferencePower_W":3e9,"eventEnergy_MeV":200,"Fref_events_per_s":9.36226e19,"convertedSpan_m":[0.95,1.05],"form":"proxy = (E_c/E_c_ref) * (E_tot_ref/Fref)"}'
const levelChannelsBlock = '{"calibrationPressure_Pa":15000000,"lag_s":0.5,"interfaceSpan_Pa":[0,25000000],"indicatedSpan_m":[-1,13],"quantum_m":0.01,"supplies":["I1","I2","I3"]}'
const levelProtectionBlock = '{"lowLevel_m":3.0,"lowQualification_s":0.5,"highLevel_m":10.0,"highQualification_s":0.5,"unavailableQualification_s":1,"resetBand_m":[3.5,9.5],"resetDuration_s":5}'
const prhrActuation = '{"onAcceptedReactorTrip":false,"onCmtActuation":true,"causes":["LD01.PROT.PZR.HIGH_3_PRHR"],"high3Timer_s":15}'
const underspeed = '{"underspeedFractionOfNominal":0.9,"qualification_s":0.5,"speedLag_s":0.067,"spanFractionOfNominal":[0,1.5],"armingProxyFraction":0.1,"supply":{"A":"I1","B":"I2"},"resetFractionOfNominal":0.97,"resetDuration_s":5,"totalDelay_s":0.767}'
const cmtBlock = '{"sPressure_Pa":12477415,"sQualification_s":0.5,"low2Level_m":0.0,"low2Qualification_s":0.5}'
const interlock = '{"cause":"LD01.TG.REACTOR_TRIP","delay_s":5,"initiation":"LD01.TRIP.HOLD loss"}'
const bankChannels = '{"position":{"lag_s":0.1,"span":[0,1],"quantum":null,"supply":"I1"},"inserted":{"supply":"I1"},"sample_s":0.1,"transport_s":0.1}'
const valveChannels = '{"lag_s":0.1,"span_percent":[0,100],"quantum_percent":1,"sample_s":0.1,"transport_s":0.1,"supply":"I1","compiled":["LD01.TG.STOP.POS"]}'
const observationWindow = '{"window_s":60,"alpha":0.01,"theta":0.1,"minimumExcessCount":400,"backgroundRange_s":[0,2],"deadtime_s":0.000001,"maximumOccupancy":0.1,"sample_s":0.1,"noiseBound_A":0.000000000001,"commissionOffsetBound_A":0.000000000001,"saturation_A":0.01}'
const sourcePulse = '{"rrefEventsPerS":null,"darkPerS":1,"supply":"I2","seed":1,"maximumAge_s":60.2}'
const taps = '### PZR electronic differential level\n\n' + fence('ld01-pzr-taps', '{"pt1Elevation_m":18.5,"ltLowElevation_m":6.5,"ltHighElevation_m":18.5}')
const pages = (over: Partial<Record<(typeof OPERATING_IC_PAGES)[number], string>> = {}) => ({
  'safety/source-and-primary-protection.md': fence('reference-pzr-pressure-protection', protection) + fence('ld01-loop-low-flow-protection', lowFlow)
    + fence('ld01-pzr-level-protection', levelProtectionBlock) + fence('ld01-rcp-underspeed-protection', underspeed) + fence('ld01-cmt-actuation', cmtBlock),
  'systems/instrumentation/operational-observations.md': fence('reference-pzr-pressure-channel', channel)
    + fence('ld01-loop-flow-channel', flowChannel) + fence('ld01-power-proxy-protective-paths', proxyPaths)
    + fence('ld01-bank-channels', bankChannels) + fence('ld01-steam-valve-position-channels', valveChannels),
  'systems/instrumentation/phase-dependent-measurements.md': taps + fence('ld01-pzr-level-channels', levelChannelsBlock),
  'safety/reactor-trip-and-hold.md': fence('ld01-s2-holding-circuit', '{"turbineTripToOpening_s":0.2}')
    + fence('ld01-turbine-state-report', '{"sample_s":0.1,"transport_s":0.1,"maximumAge_s":0.3,"recovery_s":1}'),
  'safety/steam-generator-protection.md': fence('ld01-sg-level-protection', sgProtection)
    + fence('ld01-sg-level-protective-acquisition', '{"sample_s":0.1,"transport_s":0.1,"maximumAge_s":0.3}'),
  'systems/steam-generation/instrumentation.md': fence('ld01-sg-level-channels', '{"nrLag_s":0.5,"nrSpan_m":[4,9],"indicatedLevelArea_m2":12}'),
  'systems/instrumentation/nuclear-observation-apparatus.md': fence('ld01-regional-current-reference', reference)
    + fence('reference-nuclear-observation-window', observationWindow) + fence('ld01-source-range-pulse', sourcePulse),
  'safety/engineered-safety-actuation.md': fence('ld01-prhr-actuation', prhrActuation),
  'safety/protection-and-command-precedence.md': fence('ld01-reactor-trip-turbine-trip', interlock),
  ...over,
})
// Four sectors of six axial bands over -2..2 m, as the packet's source regions.
const bands = [-2, -4 / 3, -2 / 3, 0, 2 / 3, 4 / 3, 2]
const packet = {
  mechanics: { faces: [{ id: 'SG.A.PRIMARY->PUMP.A1' }, { id: 'RETURN.A->DOWN' }, { id: 'RETURN.B->DOWN' }] },
  hydraulics: { sections: ['DOWN', 'PUMP.A1', 'PUMP.A2', 'COLD.A', 'PUMP.B1', 'PUMP.B2'].map(id => ({ id, parameters: { pump: id.startsWith('PUMP') ? {} : null } })) },
  secondary: { steamGenerators: [{ id: 'A' }, { id: 'B' }] },
  feedback_metadata: { regions: Array.from({ length: 24 }, (_, i) => ({ z0_m: bands[i % 6]!, z1_m: bands[i % 6 + 1]! })) },
}

test('with the packet\'s apparent level (C08, S5) the NR channels read it; one indicated-level area', () => {
  const apparent = { ...packet, secondary: { ...packet.secondary, apparentLevel: { indication: { indicatedLevelArea_m2: 12 } } } }
  const s = compileOperatingIcFrom(pages(), apparent)
  expect(s.families[2]!.quantity).toEqual({ sg_apparent_level: { sg: 'A', area_m2: 12 } })
  expect(s.families[3]!.quantity).toEqual({ sg_apparent_level: { sg: 'B', area_m2: 12 } })
  const other = { ...packet, secondary: { ...packet.secondary, apparentLevel: { indication: { indicatedLevelArea_m2: 10 } } } }
  expect(() => compileOperatingIcFrom(pages(), other)).toThrow('one indicated-level area')
})

test('the section carries only strict-block values and the packet identities', () => {
  const s = compileOperatingIcFrom(pages(), packet)
  expect(s.frame_s).toBe(0.1)
  expect(s.families.map(f => f.id)).toEqual(['LD01.PZR.PT', 'LD01.PZR.LT', 'LD01.SG.A.LT.NR', 'LD01.SG.B.LT.NR', 'LD01.RCS.A.FT', 'LD01.RCS.B.FT', 'LD01.CORE.POWER.P',
    'LD01.RCP.A1.SPEED', 'LD01.RCP.A2.SPEED', 'LD01.RCP.B1.SPEED', 'LD01.RCP.B2.SPEED'])
  // R12-D2: one speed channel per RCP, in rotor order, on its loop's supply.
  expect(s.families[9]!.quantity).toEqual({ pump_speed: { rotor: 2, rotor_id: 'PUMP.B1' } })
  expect(s.families[9]!.channels).toEqual([{ id: 'LD01.RCP.B1.SPEED', supply: 'I2' }])
  expect(s.families[9]!.channel).toMatchObject({ lag_s: 0.067, min: 0, max: 1.5, sample_s: 0.1, transport_s: 0.1 })
  expect(s.families[2]!.quantity).toEqual({ sg_collapsed_level: { sg: 'A', area_m2: 12 } })
  expect(s.families[2]!.channel).toMatchObject({ lag_s: 0.5, min: 4, max: 9, quantum: null })
  expect(s.families[4]!.quantity).toEqual({ loop_flow: { loop_id: 'A', face: 1, face_id: 'RETURN.A->DOWN', nominal_kg_s: null, quantum_kg_s: 5, indeterminate_band_kg_s: 10 } })
  expect(s.families[4]!.channels).toEqual([{ id: 'LD01.RCS.A.FT', supply: 'I1' }])
  expect(s.families[5]!.channels).toEqual([{ id: 'LD01.RCS.B.FT', supply: 'I2' }])
  const proxy = s.families[6]!.quantity as { current_proxy: { weights: number[], fref_events_per_s: number } }
  // The span 0.95–1.05 m lies in the band 2/3–4/3 m of each sector.
  expect(proxy.current_proxy.weights.map((w, i) => w > 0 ? i : -1).filter(i => i >= 0)).toEqual([4, 10, 16, 22])
  expect(proxy.current_proxy.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 14)
  expect(s.families[6]!.channel).toMatchObject({ lag_s: 0.2, min: null, max: null, quantum: null })
  const ids = s.functions.map(f => f.id)
  expect(ids).toEqual(['LD01.PROT.PZR.HIGH_PRESSURE', 'LD01.PROT.PZR.LOW_PRESSURE', 'LD01.PROT.PZR.S_PRESSURE', 'LD01.PROT.PZR.PRESSURE.UNAVAILABLE',
    'LD01.PROT.TG.TRIP', 'LD01.PROT.SG.A.LOW', 'LD01.PROT.SG.A.UNAVAILABLE', 'LD01.PROT.SG.B.LOW', 'LD01.PROT.SG.B.UNAVAILABLE',
    'LD01.PROT.RCS.A.LOW_FLOW', 'LD01.PROT.RCS.A.FLOW.UNAVAILABLE', 'LD01.PROT.RCS.B.LOW_FLOW', 'LD01.PROT.RCS.B.FLOW.UNAVAILABLE',
    'LD01.PROT.PZR.HIGH_LEVEL', 'LD01.PROT.PZR.HIGH_3_PRHR', 'LD01.PROT.PZR.LOW_2_LEVEL', 'LD01.PROT.RCS.A1.UNDERSPEED', 'LD01.PROT.RCS.A2.UNDERSPEED', 'LD01.PROT.RCS.B1.UNDERSPEED',
    'LD01.PROT.RCS.B2.UNDERSPEED'])
  expect(s.functions[16]!.rule).toEqual({ armed: { family: 'LD01.RCP.A1.SPEED', side: { at_or_below: 0.9 }, qualification_s: 0.5,
    arming_family: 'LD01.CORE.POWER.P', arming: { above: 0.1 } } })
  // R12-A1: PRHR on CMT actuation (the low-pressure cause) and the high level only, never on the reactor trip.
  expect(s.functions.filter(f => f.effects.prhr).map(f => f.id)).toEqual(['LD01.PROT.PZR.S_PRESSURE', 'LD01.PROT.PZR.HIGH_3_PRHR', 'LD01.PROT.PZR.LOW_2_LEVEL'])
  // CRED-FIX-A2: the high-3 PRHR signal holds the high level 0.5 + 15 s and trips nothing.
  const high3 = s.functions.find(f => f.id === 'LD01.PROT.PZR.HIGH_3_PRHR')!
  expect(high3.rule).toEqual({ voted: { family: 'LD01.PZR.LT', side: { at_or_above: 10 }, qualification_s: 15.5 } })
  expect(high3.effects).toEqual({ reactor_trip: false, cmt_injection: false, heater_isolation: false, prhr: true })
  // R12-B3: CMT only on the "S" pressure and the low-2 level.
  expect(s.functions.filter(f => f.effects.cmt_injection).map(f => f.id)).toEqual(['LD01.PROT.PZR.S_PRESSURE', 'LD01.PROT.PZR.LOW_2_LEVEL'])
  expect(s.functions[2]!.rule).toEqual({ voted: { family: 'LD01.PZR.PT', side: { at_or_below: 12477415 }, qualification_s: 0.5 } })
  expect(s.functions.filter(f => !f.effects.reactor_trip).map(f => f.id)).toEqual(['LD01.PROT.PZR.HIGH_3_PRHR'])
  expect(s.functions[13]!.rule).toEqual({ voted: { family: 'LD01.PZR.LT', side: { at_or_above: 10 }, qualification_s: 0.5 } })
  expect(s.functions[5]!.rule).toEqual({ voted: { family: 'LD01.SG.A.LT.NR', side: { at_or_below: 5 }, qualification_s: 1 } })
  expect(s.functions[9]!.rule).toEqual({ armed: { family: 'LD01.RCS.A.FT', side: { at_or_below: 0.7 }, qualification_s: 0.5,
    arming_family: 'LD01.CORE.POWER.P', arming: { above: 0.2 } } })
  expect(s.functions[10]!.rule).toEqual({ armed_unavailable: { family: 'LD01.RCS.A.FT', qualification_s: 0.5,
    arming_family: 'LD01.CORE.POWER.P', arming: { above: 0.2 } } })
  // The open SOURCE Rref follows the static items.
  expect(s.missing.slice(0, OPEN_ITEMS.length)).toEqual([...OPEN_ITEMS])
  // R12-A2: the interlock's cause and delay come from its block.
  expect(s.turbine_trip_on_reactor_trip).toMatchObject({ cause: 'LD01.TG.REACTOR_TRIP', delay_s: 5 })
})

test('refusals: a duration off the frame, a missing face, a wrong Fref, a missing block', () => {
  expect(() => compileOperatingIcFrom(pages({ 'safety/source-and-primary-protection.md':
    fence('reference-pzr-pressure-protection', protection) + fence('ld01-loop-low-flow-protection', lowFlow.replace('"lowFlowQualification_s":0.5', '"lowFlowQualification_s":0.55'))
      + fence('ld01-pzr-level-protection', levelProtectionBlock) + fence('ld01-rcp-underspeed-protection', underspeed) + fence('ld01-cmt-actuation', cmtBlock) }), packet))
    .toThrow('not whole')
  expect(() => compileOperatingIcFrom(pages(), { ...packet, mechanics: { faces: [{ id: 'RETURN.A->DOWN' }] } })).toThrow('No face RETURN.B->DOWN')
  expect(() => compileOperatingIcFrom(pages({ 'systems/instrumentation/nuclear-observation-apparatus.md':
    fence('ld01-regional-current-reference', reference.replace('9.36226e19', '9.4e19'))
    + fence('reference-nuclear-observation-window', observationWindow) + fence('ld01-source-range-pulse', sourcePulse) }), packet)).toThrow('Fref')
  expect(() => compileOperatingIcFrom(pages({ 'systems/steam-generation/instrumentation.md': 'no block' }), packet))
    .toThrow('Expected one ld01-sg-level-channels block')
  expect(() => compileOperatingIcFrom(pages({ 'safety/engineered-safety-actuation.md':
    fence('ld01-prhr-actuation', prhrActuation.replace('"onAcceptedReactorTrip":false', '"onAcceptedReactorTrip":true')) }), packet)).toThrow()
  expect(() => compileOperatingIcFrom(pages({ 'safety/engineered-safety-actuation.md':
    fence('ld01-prhr-actuation', prhrActuation.replace('PZR.HIGH_3_PRHR', 'SG.A.WR_LOW')) }), packet)).toThrow('not compiled')
  expect(() => compileOperatingIcFrom(pages({ 'safety/protection-and-command-precedence.md':
    fence('ld01-reactor-trip-turbine-trip', interlock.replace('"delay_s":5', '"delay_s":5.05')) }), packet)).toThrow('not whole')
  expect(() => compileOperatingIcFrom(pages({ 'safety/source-and-primary-protection.md': fence('reference-pzr-pressure-protection', protection)
    + fence('ld01-loop-low-flow-protection', lowFlow) + fence('ld01-pzr-level-protection', levelProtectionBlock)
    + fence('ld01-rcp-underspeed-protection', underspeed.replace('"totalDelay_s":0.767', '"totalDelay_s":0.8')) + fence('ld01-cmt-actuation', cmtBlock) }), packet)).toThrow('total delay')
})

const wiki = process.env.LD01_WIKI_ROOT, joined = process.env.LD01_OPERATING_HOT_SPINE_PACKET
test.skipIf(!wiki || !joined)('the actual section from the wiki and the packet', async () => {
  const s = await compileOperatingIc(wiki!, joined!)
  expect(s.functions).toHaveLength(20)
  const root = join(wiki!, 'world/packs/process-plant/reference-designs/ld-01')
  for (const [i, name] of OPERATING_IC_PAGES.entries()) {
    const text = await Bun.file(join(root, name)).text()
    expect(s.provenance[i + 1]).toEqual({ name, sha256: createHash('sha256').update(text).digest('hex') })
  }
})

test('the PZR LT family and C2.N3 vote compile from their blocks, and refuse without them', () => {
  const p = pages()
  const texts = {
    measurements: p['systems/instrumentation/phase-dependent-measurements.md'],
    observations: p['systems/instrumentation/operational-observations.md'],
    protection: p['safety/source-and-primary-protection.md'],
  }
  const { family, monitors } = compilePzrLevelFrom(texts)
  expect(family.quantity).toEqual({ pzr_level: { calibration_pressure_pa: 15e6, interface_span_pa: [0, 25e6] } })
  expect(family.channel).toEqual({ lag_s: 0.5, min: -1, max: 13, quantum: 0.01, indeterminate_band: null, sample_s: 0.1, transport_s: 0.1 })
  expect(family.channels.map(c => c.id)).toEqual(['LD01.PZR.LT1', 'LD01.PZR.LT2', 'LD01.PZR.LT3'])
  expect(monitors[0]!.rule).toEqual({ voted: { family: 'LD01.PZR.LT', side: { at_or_below: 3 }, qualification_s: 0.5 } })
  const s = compileOperatingIcFrom(p, packet)
  expect(s.families[1]).toEqual(family)
  expect(s.monitors).toEqual(monitors)
  expect(() => compilePzrLevelFrom({ ...texts, measurements: taps })).toThrow('Expected one ld01-pzr-level-channels block')
  expect(() => compileOperatingIcFrom(pages({ 'systems/instrumentation/phase-dependent-measurements.md': taps }), packet))
    .toThrow('Expected one ld01-pzr-level-channels block')
})

test('with the packet\'s CVCS (plan r4 X4.2) the two normal-inventory FTs are observed on I2 at the CVCS controller\'s lag and span', () => {
  const s = compileOperatingIcFrom(pages(), { ...packet, cvcs: { controller: { flowLag_s: 0.25, flowSpan_kg_s: [-7.5, 7.5] } } })
  const ft = s.families.slice(-2)
  expect(ft.map(f => f.id)).toEqual(['LD01.INV.CHARGE.FT', 'LD01.INV.LETDOWN.FT'])
  expect(ft[0]!.quantity).toEqual({ cvcs_flow: { branch: 'Charging' } })
  expect(ft[1]!.channels).toEqual([{ id: 'LD01.INV.LETDOWN.FT', supply: 'I2' }])
  expect(ft[1]!.channel).toMatchObject({ lag_s: 0.25, min: -7.5, max: 7.5, quantum: null, sample_s: 0.1 })
  // Without the CVCS the section is unchanged.
  expect(compileOperatingIcFrom(pages(), packet).families.map(f => f.id)).not.toContain('LD01.INV.CHARGE.FT')
})

test('with the packet\'s rods and steam admission (plan r4 tag map) the bank position, STOP position and bank inserted report are observed on I1', () => {
  const s = compileOperatingIcFrom(pages(), { ...packet, rods: { normal_travel_m: 4 },
    secondary: { ...packet.secondary, steamAdmission: { stopTravel_s: 0.3 } } })
  const ids = s.families.map(f => f.id)
  expect(ids.slice(-2)).toEqual(['LD01.CORE.BANK.POS', 'LD01.TG.STOP.POS'])
  expect(s.families.at(-2)!.quantity).toEqual({ bank_position: { normal_travel_m: 4 } })
  expect(s.families.at(-1)!.quantity).toEqual({ stop_valve_position: { stop_travel_s: 0.3 } })
  expect(s.families.at(-1)!.channel).toMatchObject({ lag_s: 0.1, min: 0, max: 100, quantum: 1, sample_s: 0.1, transport_s: 0.1 })
  expect(s.reports.map(r => [r.id, r.source, r.supply])).toEqual([['LD01.TG.TRIP.REPORT', 'turbine_retained_trip', 'ACT.B'],
    ['LD01.CORE.BANK.INSERTED', 'bank_inserted', 'I1']])
  // Without them the section is unchanged.
  const plain = compileOperatingIcFrom(pages(), packet)
  expect(plain.families.map(f => f.id)).not.toContain('LD01.CORE.BANK.POS')
  expect(plain.reports).toHaveLength(1)
})

test('LD01.CORE.NI.SHUTDOWN: no SOURCE path while the regional Rref is open, and the window selections once it is filled', () => {
  const open = compileOperatingIcFrom(pages(), packet)
  expect('source_range' in open).toBe(false)
  expect(open.missing.at(-1)!.item).toBe('LD01.CORE.NI.SHUTDOWN regional Rref')
  const filled = compileOperatingIcFrom(pages({ 'systems/instrumentation/nuclear-observation-apparatus.md': fence('ld01-regional-current-reference', reference)
    + fence('reference-nuclear-observation-window', observationWindow)
    + fence('ld01-source-range-pulse', sourcePulse.replace('"rrefEventsPerS":null', '"rrefEventsPerS":3e10')) }), packet)
  expect(filled.source_range).toEqual({ id: 'LD01.CORE.NI.SHUTDOWN', supply: 'I2', rref_events_per_s: 3e10, dark_per_s: 1, deadtime_s: 1e-6,
    window_s: 60, alpha: 0.01, theta: 0.1, minimum_excess_count: 400, background_per_s: [0, 2], maximum_occupancy: 0.1,
    sample_s: 0.1, transport_s: 0.1, maximum_age_s: 60.2, seed: 1 })
})
