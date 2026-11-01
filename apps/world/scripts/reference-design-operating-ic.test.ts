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
const valveChannels = '{"lag_s":0.1,"span_percent":[0,100],"quantum_percent":1,"sample_s":0.1,"transport_s":0.1,"supply":"I1","compiled":["LD01.TG.STOP.POS","LD01.TG.ADM.POS"]}'
const ungoverned = { governor: { declared: false, basis: 'test: ungoverned' }, dc: { declared: false, basis: 'test: no DC' } }
const observationWindow = '{"window_s":60,"alpha":0.01,"theta":0.1,"minimumExcessCount":400,"backgroundRange_s":[0,2],"deadtime_s":0.000001,"maximumOccupancy":0.1,"sample_s":0.1,"noiseBound_A":0.000000000001,"commissionOffsetBound_A":0.000000000001,"saturation_A":0.01}'
const sourcePulse = '{"rrefEventsPerS":null,"darkPerS":1,"supply":"I2","seed":1,"maximumAge_s":60.2}'
const sgPressureBlock = '{"lag_s":0.2,"span_Pa":[0,10000000],"quantum_Pa":1000}'
const sgFlowBlock = '{"supply":{"A":"I1","B":"I2"}}'
const inventoryBlock = '{"coreBottom_m":-2,"coreTop_m":2,"headTop_m":4,"coreArea_m2":4.679531,"gravity_m_s2":9.80665,"referencePressure_Pa":2000000,'
  + '"calibrationTemperature_K":313.15,"dpLag_s":0.5,"dpQuantum_Pa":100,"dpUncertainty_Pa":200,"heaterResistance_ohm":28800,"heaterVoltage_V":120,'
  + '"temperatureUncertainty_K":0.2,"temperatureQuantum_K":0.1,"powerUncertainty_W":0.02,"powerQuantum_W":0.01,"minimumTestPower_W":0.47,"maximumTestPower_W":0.53}'
const cetBasisBlock = '{"diameter_m":0.003,"length_m":0.03,"density_kg_m3":8000,"heatCapacity_J_kgK":500,"conductivity_W_mK":15,"leadDiameter_m":0.0002,'
  + '"leadLength_m":0.1,"liquidFilm_W_m2K":1000,"gasFilm_W_m2K":30,"effectiveRadiationFactor":0.03,"minimumBody_C":20,"maximumBody_C":800}'
const cetBlock = '{"supplies":["I1","I2"],"span_C":[0,800],"quantum_C":0.1,"sample_s":0.1}'
const dcBlock = '{"groups":["LD01.DC.I1","LD01.DC.I2","LD01.DC.I3","LD01.DC.ACT.A","LD01.DC.ACT.B"],"sample_s":0.1,"transport_s":0.1}'
const elecBlock = '{"buses":["AC.A","AC.B"],"sources":["UNIT","RESERVE"],"supply":"I1","sample_s":0.1,"transport_s":0.1}'
const dpBlock = '{"coreSpan_Pa":[-50000,250000],"upperSpan_Pa":[-25000,50000],"supplies":["I1","I2"]}'
const taps = '### PZR electronic differential level\n\n' + fence('ld01-pzr-taps', '{"pt1Elevation_m":18.5,"ltLowElevation_m":6.5,"ltHighElevation_m":18.5}')
const pages = (over: Partial<Record<(typeof OPERATING_IC_PAGES)[number], string>> = {}) => ({
  'safety/source-and-primary-protection.md': fence('reference-pzr-pressure-protection', protection) + fence('ld01-loop-low-flow-protection', lowFlow)
    + fence('ld01-pzr-level-protection', levelProtectionBlock) + fence('ld01-rcp-underspeed-protection', underspeed) + fence('ld01-cmt-actuation', cmtBlock),
  'systems/instrumentation/operational-observations.md': fence('reference-pzr-pressure-channel', channel)
    + fence('ld01-loop-flow-channel', flowChannel) + fence('ld01-power-proxy-protective-paths', proxyPaths)
    + fence('ld01-bank-channels', bankChannels) + fence('ld01-steam-valve-position-channels', valveChannels)
    + fence('ld01-sg-flow-channels', sgFlowBlock) + fence('ld01-electrical-reports', elecBlock) + fence('ld01-dc-reports', dcBlock),
  'systems/instrumentation/phase-dependent-measurements.md': taps + fence('ld01-pzr-level-channels', levelChannelsBlock)
    + fence('reference-cet-basis', cetBasisBlock) + fence('ld01-core-exit-channels', cetBlock),
  'safety/reactor-trip-and-hold.md': fence('ld01-s2-holding-circuit', '{"turbineTripToOpening_s":0.2}')
    + fence('ld01-turbine-state-report', '{"sample_s":0.1,"transport_s":0.1,"maximumAge_s":0.3,"recovery_s":1}'),
  'safety/steam-generator-protection.md': fence('ld01-sg-level-protection', sgProtection)
    + fence('ld01-sg-level-protective-acquisition', '{"sample_s":0.1,"transport_s":0.1,"maximumAge_s":0.3}'),
  'systems/steam-generation/instrumentation.md': fence('ld01-sg-level-channels', '{"nrLag_s":0.5,"nrSpan_m":[4,9],"indicatedLevelArea_m2":12}')
    + fence('ld01-sg-normal-pressure-channel', sgPressureBlock),
  'systems/instrumentation/core-inventory-observation.md': fence('reference-core-inventory', inventoryBlock) + fence('ld01-vessel-dp-channels', dpBlock),
  'systems/instrumentation/nuclear-observation-apparatus.md': fence('ld01-regional-current-reference', reference)
    + fence('reference-nuclear-observation-window', observationWindow) + fence('ld01-source-range-pulse', sourcePulse),
  'safety/engineered-safety-actuation.md': fence('ld01-prhr-actuation', prhrActuation),
  'safety/protection-and-command-precedence.md': fence('ld01-reactor-trip-turbine-trip', interlock),
  ...over,
})
// Four sectors of six axial bands over -2..2 m, as the packet's source regions.
const bands = [-2, -4 / 3, -2 / 3, 0, 2 / 3, 4 / 3, 2]
const sectors = ['NE', 'NW']
const packet = {
  mechanics: { faces: [{ id: 'SG.A.PRIMARY->PUMP.A1' }, { id: 'RETURN.A->DOWN' }, { id: 'RETURN.B->DOWN' },
    ...sectors.flatMap(s => [{ id: `LOWER->CORE.${s}.1` }, { id: `CORE.${s}.2->UPPER` }])],
    regions: [...sectors.flatMap(s => [{ id: `CORE.${s}.1`, elevation_m: -1 }, { id: `CORE.${s}.2`, elevation_m: 1 }]),
      { id: 'LOWER', elevation_m: -3 }, { id: 'UPPER', elevation_m: 3 }] },
  hydraulics: { sections: ['DOWN', 'PUMP.A1', 'PUMP.A2', 'COLD.A', 'PUMP.B1', 'PUMP.B2'].map(id => ({ id, parameters: { pump: id.startsWith('PUMP') ? {} : null } })) },
  secondary: { steamGenerators: [{ id: 'A' }, { id: 'B' }] },
  feedback_metadata: { regions: Array.from({ length: 24 }, (_, i) => ({ z0_m: bands[i % 6]!, z1_m: bands[i % 6 + 1]! })) },
}

test('with the packet\'s apparent level (C08, S5) the NR channels read it; one indicated-level area', () => {
  const apparent = { ...packet, secondary: { ...packet.secondary, apparentLevel: { indication: { indicatedLevelArea_m2: 12 } } } }
  const s = compileOperatingIcFrom(pages(), apparent, ungoverned)
  expect(s.families[2]!.quantity).toEqual({ sg_apparent_level: { sg: 'A', area_m2: 12 } })
  expect(s.families[3]!.quantity).toEqual({ sg_apparent_level: { sg: 'B', area_m2: 12 } })
  const other = { ...packet, secondary: { ...packet.secondary, apparentLevel: { indication: { indicatedLevelArea_m2: 10 } } } }
  expect(() => compileOperatingIcFrom(pages(), other, ungoverned)).toThrow('one indicated-level area')
})

test('the section carries only strict-block values and the packet identities', () => {
  const s = compileOperatingIcFrom(pages(), packet, ungoverned)
  expect(s.frame_s).toBe(0.1)
  expect(s.families.map(f => f.id)).toEqual(['LD01.PZR.PT', 'LD01.PZR.LT', 'LD01.SG.A.LT.NR', 'LD01.SG.B.LT.NR', 'LD01.RCS.A.FT', 'LD01.RCS.B.FT', 'LD01.CORE.POWER.P',
    'LD01.RCP.A1.SPEED', 'LD01.RCP.A2.SPEED', 'LD01.RCP.B1.SPEED', 'LD01.RCP.B2.SPEED', 'LD01.SG.A.PT', 'LD01.SG.B.PT', 'LD01.CORE.DP', 'LD01.UPPER.DP', 'LD01.CORE.CET'])
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
      + fence('ld01-pzr-level-protection', levelProtectionBlock) + fence('ld01-rcp-underspeed-protection', underspeed) + fence('ld01-cmt-actuation', cmtBlock) }), packet, ungoverned))
    .toThrow('not whole')
  expect(() => compileOperatingIcFrom(pages(), { ...packet, mechanics: { ...packet.mechanics, faces: [{ id: 'RETURN.A->DOWN' }] } }, ungoverned)).toThrow('No face RETURN.B->DOWN')
  expect(() => compileOperatingIcFrom(pages({ 'systems/instrumentation/nuclear-observation-apparatus.md':
    fence('ld01-regional-current-reference', reference.replace('9.36226e19', '9.4e19'))
    + fence('reference-nuclear-observation-window', observationWindow) + fence('ld01-source-range-pulse', sourcePulse) }), packet, ungoverned)).toThrow('Fref')
  expect(() => compileOperatingIcFrom(pages({ 'systems/steam-generation/instrumentation.md': 'no block' }), packet, ungoverned))
    .toThrow('Expected one ld01-sg-level-channels block')
  expect(() => compileOperatingIcFrom(pages({ 'safety/engineered-safety-actuation.md':
    fence('ld01-prhr-actuation', prhrActuation.replace('"onAcceptedReactorTrip":false', '"onAcceptedReactorTrip":true')) }), packet, ungoverned)).toThrow()
  expect(() => compileOperatingIcFrom(pages({ 'safety/engineered-safety-actuation.md':
    fence('ld01-prhr-actuation', prhrActuation.replace('PZR.HIGH_3_PRHR', 'SG.A.WR_LOW')) }), packet, ungoverned)).toThrow('not compiled')
  expect(() => compileOperatingIcFrom(pages({ 'safety/protection-and-command-precedence.md':
    fence('ld01-reactor-trip-turbine-trip', interlock.replace('"delay_s":5', '"delay_s":5.05')) }), packet, ungoverned)).toThrow('not whole')
  expect(() => compileOperatingIcFrom(pages({ 'safety/source-and-primary-protection.md': fence('reference-pzr-pressure-protection', protection)
    + fence('ld01-loop-low-flow-protection', lowFlow) + fence('ld01-pzr-level-protection', levelProtectionBlock)
    + fence('ld01-rcp-underspeed-protection', underspeed.replace('"totalDelay_s":0.767', '"totalDelay_s":0.8')) + fence('ld01-cmt-actuation', cmtBlock) }), packet, ungoverned)).toThrow('total delay')
})

const wiki = process.env.LD01_WIKI_ROOT, joined = process.env.LD01_OPERATING_HOT_SPINE_PACKET
test.skipIf(!wiki || !joined)('the actual section from the wiki and the packet', async () => {
  const s = await compileOperatingIc(wiki!, joined!, ungoverned)
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
  const s = compileOperatingIcFrom(p, packet, ungoverned)
  expect(s.families[1]).toEqual(family)
  expect(s.monitors).toEqual(monitors)
  expect(() => compilePzrLevelFrom({ ...texts, measurements: taps })).toThrow('Expected one ld01-pzr-level-channels block')
  expect(() => compileOperatingIcFrom(pages({ 'systems/instrumentation/phase-dependent-measurements.md': taps }), packet, ungoverned))
    .toThrow('Expected one ld01-pzr-level-channels block')
})

test('with the packet\'s CVCS (plan r4 X4.2) the two normal-inventory FTs are observed on I2 at the CVCS controller\'s lag and span', () => {
  const s = compileOperatingIcFrom(pages(), { ...packet, cvcs: { controller: { flowLag_s: 0.25, flowSpan_kg_s: [-7.5, 7.5] } } }, ungoverned)
  const ft = s.families.slice(-2)
  expect(ft.map(f => f.id)).toEqual(['LD01.INV.CHARGE.FT', 'LD01.INV.LETDOWN.FT'])
  expect(ft[0]!.quantity).toEqual({ cvcs_flow: { branch: 'Charging' } })
  expect(ft[1]!.channels).toEqual([{ id: 'LD01.INV.LETDOWN.FT', supply: 'I2' }])
  expect(ft[1]!.channel).toMatchObject({ lag_s: 0.25, min: -7.5, max: 7.5, quantum: null, sample_s: 0.1 })
  // Without the CVCS the section is unchanged.
  expect(compileOperatingIcFrom(pages(), packet, ungoverned).families.map(f => f.id)).not.toContain('LD01.INV.CHARGE.FT')
})

test('with the packet\'s rods and steam admission (plan r4 tag map) the bank position, STOP position and bank inserted report are observed on I1', () => {
  const s = compileOperatingIcFrom(pages(), { ...packet, rods: { normal_travel_m: 4 },
    secondary: { ...packet.secondary, steamAdmission: { stopTravel_s: 0.3 } } }, ungoverned)
  const ids = s.families.map(f => f.id)
  expect(ids.slice(-2)).toEqual(['LD01.CORE.BANK.POS', 'LD01.TG.STOP.POS'])
  expect(s.families.at(-2)!.quantity).toEqual({ bank_position: { normal_travel_m: 4 } })
  expect(s.families.at(-1)!.quantity).toEqual({ stop_valve_position: { stop_travel_s: 0.3 } })
  expect(s.families.at(-1)!.channel).toMatchObject({ lag_s: 0.1, min: 0, max: 100, quantum: 1, sample_s: 0.1, transport_s: 0.1 })
  expect(s.reports.slice(0, 2).map(r => [r.id, r.source, r.supply])).toEqual([['LD01.TG.TRIP.REPORT', 'turbine_retained_trip', 'ACT.B'],
    ['LD01.CORE.BANK.INSERTED', 'bank_inserted', 'I1']])
  // Without them the section is unchanged.
  const plain = compileOperatingIcFrom(pages(), packet, ungoverned)
  expect(plain.families.map(f => f.id)).not.toContain('LD01.CORE.BANK.POS')
  expect(plain.reports.filter(r => !r.id.startsWith('LD01.AC.') && !r.id.startsWith('LD01.ELEC.'))).toHaveLength(1)
})

test('LD01.CORE.NI.SHUTDOWN: no SOURCE path while the regional Rref is open, and the window selections once it is filled', () => {
  const open = compileOperatingIcFrom(pages(), packet, ungoverned)
  expect('source_range' in open).toBe(false)
  expect(open.missing.at(-1)!.item).toBe('LD01.CORE.NI.SHUTDOWN regional Rref')
  const filled = compileOperatingIcFrom(pages({ 'systems/instrumentation/nuclear-observation-apparatus.md': fence('ld01-regional-current-reference', reference)
    + fence('reference-nuclear-observation-window', observationWindow)
    + fence('ld01-source-range-pulse', sourcePulse.replace('"rrefEventsPerS":null', '"rrefEventsPerS":3e10')) }), packet, ungoverned)
  expect(filled.source_range).toEqual({ id: 'LD01.CORE.NI.SHUTDOWN', supply: 'I2', rref_events_per_s: 3e10, dark_per_s: 1, deadtime_s: 1e-6,
    window_s: 60, alpha: 0.01, theta: 0.1, minimum_excess_count: 400, background_per_s: [0, 2], maximum_occupancy: 0.1,
    sample_s: 0.1, transport_s: 0.1, maximum_age_s: 60.2, seed: 1 })
})

test('plan r4 X4 channels: the normal SG PTs, the core-span DP over the sector channels, and with the feed train the SG owner\'s FT lags', () => {
  const s = compileOperatingIcFrom(pages(), packet, ungoverned)
  const family = (id: string) => s.families.find(f => f.id === id)!
  expect(family('LD01.SG.B.PT')).toEqual({ id: 'LD01.SG.B.PT', quantity: { sg_pressure: { sg: 'B' } }, channels: [{ id: 'LD01.SG.B.PT', supply: 'unselected' }],
    channel: { lag_s: 0.2, min: 0, max: 1e7, quantum: 1000, indeterminate_band: null, sample_s: 0.1, transport_s: 0.1 }, maximum_age_s: 0.3, recovery_s: 1 })
  const dp = family('LD01.CORE.DP')
  expect(dp.channels).toEqual([{ id: 'LD01.CORE.DP1', supply: 'I1' }, { id: 'LD01.CORE.DP2', supply: 'I2' }])
  expect(dp.channel).toMatchObject({ lag_s: 0.5, min: -50000, max: 250000, quantum: 100 })
  expect(dp.quantity).toEqual({ vessel_dp: { taps: [
    { lower: { region: 0, region_id: 'CORE.NE.1', elevation_m: -2 }, upper: { region: 1, region_id: 'CORE.NE.2', elevation_m: 2 } },
    { lower: { region: 2, region_id: 'CORE.NW.1', elevation_m: -2 }, upper: { region: 3, region_id: 'CORE.NW.2', elevation_m: 2 } }] } })
  expect(family('LD01.UPPER.DP').quantity).toEqual({ plenum_dp: { region: 5, region_id: 'UPPER', lower_m: 2, upper_m: 4 } })
  expect(family('LD01.UPPER.DP').channel).toMatchObject({ lag_s: 0.5, min: -25000, max: 50000, quantum: 100 })
  const cet = family('LD01.CORE.CET')
  expect(cet.quantity).toEqual({ core_exit_temperature: { cells: [{ region: 1, region_id: 'CORE.NE.2' }, { region: 3, region_id: 'CORE.NW.2' }], body_c: [20, 800] } })
  expect(cet.channels).toEqual([{ id: 'LD01.CORE.CET1', supply: 'I1' }, { id: 'LD01.CORE.CET2', supply: 'I2' }])
  // The page's liquid time constant, about 2.94 s.
  expect(cet.channel.lag_s).toBeCloseTo(2.9418, 3)
  expect(cet.channel).toMatchObject({ min: 0, max: 800, quantum: 0.1, sample_s: 0.1 })
  expect(s.families.map(f => f.id)).not.toContain('LD01.SG.A.FT.STEAM')
  const train = { nominalFlow_kg_s: 800, cascade: { steamFlowLag_s: 0.25, steamFlowSpan: [0, 1.5], feedFlowLag_s: 0.25, feedFlowSpan: [0, 1.5] } }
  const fed = compileOperatingIcFrom(pages(), { ...packet, secondary: { ...packet.secondary, feedTrain: train } }, ungoverned)
  const flows = fed.families.filter(f => /FT\.STEAM$|^LD01\.FW\./.test(f.id))
  expect(flows.map(f => [f.id, f.channels[0]!.supply])).toEqual([['LD01.SG.A.FT.STEAM', 'I1'], ['LD01.FW.A.FT', 'I1'], ['LD01.SG.B.FT.STEAM', 'I2'], ['LD01.FW.B.FT', 'I2']])
  expect(flows[3]!.quantity).toEqual({ sg_flow_lag: { sg: 'B', flow: 'feed', nominal_kg_s: 800 } })
  expect(flows[0]!.channel).toMatchObject({ lag_s: 0, min: 0, max: 1.5, quantum: null })
  // A tap in a moving plenum is refused.
  const rods = { normal_travel_m: 4, cells: { upper: { region: 'CORE.NE.2' }, housing_main: { region: 'HOUSING.MAIN' } } }
  expect(() => compileOperatingIcFrom(pages(), { ...packet, rods }, ungoverned)).toThrow('moving cell')
})

test('PROC T1–T3: the AC routing reports, one per bus, per source (available, qualified) and per incoming device (closed, travel complete), on I1', () => {
  const s = compileOperatingIcFrom(pages(), packet, ungoverned)
  const e = s.reports.filter(r => r.id.startsWith('LD01.AC.') || r.id.startsWith('LD01.ELEC.'))
  expect(e.map(r => r.id)).toEqual(['LD01.AC.A.AVAILABLE', 'LD01.AC.B.AVAILABLE', 'LD01.ELEC.UNIT_SOURCE.AVAILABLE', 'LD01.ELEC.UNIT_SOURCE.QUALIFIED',
    'LD01.ELEC.RESERVE_SOURCE.AVAILABLE', 'LD01.ELEC.RESERVE_SOURCE.QUALIFIED', 'LD01.AC.A.INCOMING.UNIT.CLOSED', 'LD01.AC.A.INCOMING.UNIT.TRAVEL_COMPLETE',
    'LD01.AC.A.INCOMING.RESERVE.CLOSED', 'LD01.AC.A.INCOMING.RESERVE.TRAVEL_COMPLETE', 'LD01.AC.B.INCOMING.UNIT.CLOSED', 'LD01.AC.B.INCOMING.UNIT.TRAVEL_COMPLETE',
    'LD01.AC.B.INCOMING.RESERVE.CLOSED', 'LD01.AC.B.INCOMING.RESERVE.TRAVEL_COMPLETE'])
  expect(e[3]).toMatchObject({ source: { source_qualified: { source: 'unit' } }, supply: 'I1', sample_s: 0.1, transport_s: 0.1, maximum_age_s: 0.3, recovery_s: 1 })
  expect(e[13]!.source).toEqual({ incoming_travel_complete: { bus: 'AC.B', source: 'reserve' } })
})

test('LD01.TG.ADM.POS only when the compile declares the governor, recorded in the section; no default', () => {
  const plain = compileOperatingIcFrom(pages(), packet, ungoverned)
  expect(plain.governor).toEqual(ungoverned.governor)
  expect(plain.families.map(f => f.id)).not.toContain('LD01.TG.ADM.POS')
  const governed = compileOperatingIcFrom(pages(), packet, { ...ungoverned, governor: { declared: true, basis: 'test: governed' } })
  const adm = governed.families.find(f => f.id === 'LD01.TG.ADM.POS')!
  expect(adm.quantity).toBe('admission_position')
  expect(adm.channel).toMatchObject({ lag_s: 0.1, min: 0, max: 100, quantum: 1 })
  expect(adm.channels).toEqual([{ id: 'LD01.TG.ADM.POS', supply: 'I1' }])
  expect(() => compileOperatingIcFrom(pages(), packet, undefined as never)).toThrow('explicit governor declaration')
  expect(() => compileOperatingIcFrom(pages(), packet, { governor: ungoverned.governor } as never)).toThrow('explicit dc declaration')
})

test('PROC T5: with the DC declared, per group output, charger, battery and one boolean per cause on its own supply, and the labelled engineering values', () => {
  const plain = compileOperatingIcFrom(pages(), packet, ungoverned)
  expect(plain.reports.some(r => r.id.startsWith('LD01.DC.'))).toBe(false)
  expect(plain.engineering).toEqual([])
  const s = compileOperatingIcFrom(pages(), packet, { ...ungoverned, dc: { declared: true, basis: 'test: DC' } })
  const dc = s.reports.filter(r => r.id.startsWith('LD01.DC.'))
  expect(dc).toHaveLength(30)
  expect(dc.slice(0, 6).map(r => r.id)).toEqual(['LD01.DC.I1.OUTPUT', 'LD01.DC.I1.CHARGER', 'LD01.DC.I1.BATTERY', 'LD01.DC.I1.CAUSE.OVERLOAD',
    'LD01.DC.I1.CAUSE.INSUFFICIENT_SUPPLY', 'LD01.DC.I1.CAUSE.OUTPUT_FAILURE'])
  expect(dc.find(r => r.id === 'LD01.DC.ACT.B.CAUSE.OUTPUT_FAILURE')).toMatchObject({ source: { dc_cause: { group: 'LD01.DC.ACT.B', cause: 'OutputFailure' } }, supply: 'ACT.B' })
  expect(s.engineering).toHaveLength(20)
  expect(s.engineering[3]).toMatchObject({ id: 'LD01.DC.I1.DEPLETION', field: 'depletion_s', unit: 's' })
  expect(s.dc).toEqual({ declared: true, basis: 'test: DC' })
})
