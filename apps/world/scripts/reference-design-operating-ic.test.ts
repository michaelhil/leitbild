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
const taps = '### PZR electronic differential level\n\n' + fence('ld01-pzr-taps', '{"pt1Elevation_m":18.5,"ltLowElevation_m":6.5,"ltHighElevation_m":18.5}')
const pages = (over: Partial<Record<(typeof OPERATING_IC_PAGES)[number], string>> = {}) => ({
  'safety/source-and-primary-protection.md': fence('reference-pzr-pressure-protection', protection) + fence('ld01-loop-low-flow-protection', lowFlow),
  'systems/instrumentation/operational-observations.md': fence('reference-pzr-pressure-channel', channel)
    + fence('ld01-loop-flow-channel', flowChannel) + fence('ld01-power-proxy-protective-paths', proxyPaths),
  'systems/instrumentation/phase-dependent-measurements.md': taps,
  'safety/reactor-trip-and-hold.md': fence('ld01-s2-holding-circuit', '{"turbineTripToOpening_s":0.2}')
    + fence('ld01-turbine-state-report', '{"sample_s":0.1,"transport_s":0.1,"maximumAge_s":0.3,"recovery_s":1}'),
  'safety/steam-generator-protection.md': fence('ld01-sg-level-protection', sgProtection)
    + fence('ld01-sg-level-protective-acquisition', '{"sample_s":0.1,"transport_s":0.1,"maximumAge_s":0.3}'),
  'systems/steam-generation/instrumentation.md': fence('ld01-sg-level-channels', '{"nrLag_s":0.5,"nrSpan_m":[4,9],"indicatedLevelArea_m2":12}'),
  'systems/instrumentation/nuclear-observation-apparatus.md': fence('ld01-regional-current-reference', reference),
  ...over,
})
// Four sectors of six axial bands over -2..2 m, as the packet's source regions.
const bands = [-2, -4 / 3, -2 / 3, 0, 2 / 3, 4 / 3, 2]
const packet = {
  mechanics: { faces: [{ id: 'SG.A.PRIMARY->PUMP.A1' }, { id: 'RETURN.A->DOWN' }, { id: 'RETURN.B->DOWN' }] },
  secondary: { steamGenerators: [{ id: 'A' }, { id: 'B' }] },
  feedback_metadata: { regions: Array.from({ length: 24 }, (_, i) => ({ z0_m: bands[i % 6]!, z1_m: bands[i % 6 + 1]! })) },
}

test('the section carries only strict-block values and the packet identities', () => {
  const s = compileOperatingIcFrom(pages(), packet)
  expect(s.frame_s).toBe(0.1)
  expect(s.families.map(f => f.id)).toEqual(['LD01.PZR.PT', 'LD01.SG.A.LT.NR', 'LD01.SG.B.LT.NR', 'LD01.RCS.A.FT', 'LD01.RCS.B.FT', 'LD01.CORE.POWER.P'])
  expect(s.families[1]!.quantity).toEqual({ sg_collapsed_level: { sg: 'A', area_m2: 12 } })
  expect(s.families[1]!.channel).toMatchObject({ lag_s: 0.5, min: 4, max: 9, quantum: null })
  expect(s.families[3]!.quantity).toEqual({ loop_flow: { loop_id: 'A', face: 1, face_id: 'RETURN.A->DOWN', nominal_kg_s: null, quantum_kg_s: 5, indeterminate_band_kg_s: 10 } })
  expect(s.families[3]!.channels).toEqual([{ id: 'LD01.RCS.A.FT', supply: 'I1' }])
  expect(s.families[4]!.channels).toEqual([{ id: 'LD01.RCS.B.FT', supply: 'I2' }])
  const proxy = s.families[5]!.quantity as { current_proxy: { weights: number[], fref_events_per_s: number } }
  // The span 0.95–1.05 m lies in the band 2/3–4/3 m of each sector.
  expect(proxy.current_proxy.weights.map((w, i) => w > 0 ? i : -1).filter(i => i >= 0)).toEqual([4, 10, 16, 22])
  expect(proxy.current_proxy.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 14)
  expect(s.families[5]!.channel).toMatchObject({ lag_s: 0.2, min: null, max: null, quantum: null })
  const ids = s.functions.map(f => f.id)
  expect(ids).toEqual(['LD01.PROT.PZR.HIGH_PRESSURE', 'LD01.PROT.PZR.LOW_PRESSURE', 'LD01.PROT.PZR.PRESSURE.UNAVAILABLE',
    'LD01.PROT.TG.TRIP', 'LD01.PROT.SG.A.LOW', 'LD01.PROT.SG.A.UNAVAILABLE', 'LD01.PROT.SG.B.LOW', 'LD01.PROT.SG.B.UNAVAILABLE',
    'LD01.PROT.RCS.A.LOW_FLOW', 'LD01.PROT.RCS.A.FLOW.UNAVAILABLE', 'LD01.PROT.RCS.B.LOW_FLOW', 'LD01.PROT.RCS.B.FLOW.UNAVAILABLE'])
  expect(s.functions[4]!.rule).toEqual({ voted: { family: 'LD01.SG.A.LT.NR', side: { at_or_below: 5 }, qualification_s: 1 } })
  expect(s.functions[8]!.rule).toEqual({ armed: { family: 'LD01.RCS.A.FT', side: { at_or_below: 0.7 }, qualification_s: 0.5,
    arming_family: 'LD01.CORE.POWER.P', arming: { above: 0.2 } } })
  expect(s.functions[9]!.rule).toEqual({ armed_unavailable: { family: 'LD01.RCS.A.FT', qualification_s: 0.5,
    arming_family: 'LD01.CORE.POWER.P', arming: { above: 0.2 } } })
  expect(s.missing).toBe(OPEN_ITEMS)
})

test('refusals: a duration off the frame, a missing face, a wrong Fref, a missing block', () => {
  expect(() => compileOperatingIcFrom(pages({ 'safety/source-and-primary-protection.md':
    fence('reference-pzr-pressure-protection', protection) + fence('ld01-loop-low-flow-protection', lowFlow.replace('"lowFlowQualification_s":0.5', '"lowFlowQualification_s":0.55')) }), packet))
    .toThrow('not whole')
  expect(() => compileOperatingIcFrom(pages(), { ...packet, mechanics: { faces: [{ id: 'RETURN.A->DOWN' }] } })).toThrow('No face RETURN.B->DOWN')
  expect(() => compileOperatingIcFrom(pages({ 'systems/instrumentation/nuclear-observation-apparatus.md':
    fence('ld01-regional-current-reference', reference.replace('9.36226e19', '9.4e19')) }), packet)).toThrow('Fref')
  expect(() => compileOperatingIcFrom(pages({ 'systems/steam-generation/instrumentation.md': 'no block' }), packet))
    .toThrow('Expected one ld01-sg-level-channels block')
})

const wiki = process.env.LD01_WIKI_ROOT, joined = process.env.LD01_OPERATING_HOT_SPINE_PACKET
test.skipIf(!wiki || !joined)('the actual section from the wiki and the packet', async () => {
  const s = await compileOperatingIc(wiki!, joined!)
  expect(s.functions).toHaveLength(12)
  const root = join(wiki!, 'world/packs/process-plant/reference-designs/ld-01')
  for (const [i, name] of OPERATING_IC_PAGES.entries()) {
    const text = await Bun.file(join(root, name)).text()
    expect(s.provenance[i + 1]).toEqual({ name, sha256: createHash('sha256').update(text).digest('hex') })
  }
})

test('the PZR LT family and C2.N3 vote compile from the proposed blocks, and refuse without them', () => {
  const levelChannels = '{"calibrationPressure_Pa":15000000,"lag_s":0.5,"interfaceSpan_Pa":[0,25000000],"indicatedSpan_m":[-1,13],"quantum_m":0.01,"supplies":["I1","I2","I3"]}'
  const levelProtection = '{"lowLevel_m":3.0,"lowQualification_s":0.5,"highLevel_m":10.0,"highQualification_s":0.5,"unavailableQualification_s":1,"resetBand_m":[3.5,9.5],"resetDuration_s":5}'
  const p = pages()
  const texts = {
    measurements: p['systems/instrumentation/phase-dependent-measurements.md'] + fence('ld01-pzr-level-channels', levelChannels),
    observations: p['systems/instrumentation/operational-observations.md'],
    protection: p['safety/source-and-primary-protection.md'] + fence('ld01-pzr-level-protection', levelProtection),
  }
  const { family, monitors } = compilePzrLevelFrom(texts)
  expect(family.quantity).toEqual({ pzr_level: { calibration_pressure_pa: 15e6, interface_span_pa: [0, 25e6] } })
  expect(family.channel).toEqual({ lag_s: 0.5, min: -1, max: 13, quantum: 0.01, indeterminate_band: null, sample_s: 0.1, transport_s: 0.1 })
  expect(family.channels.map(c => c.id)).toEqual(['LD01.PZR.LT1', 'LD01.PZR.LT2', 'LD01.PZR.LT3'])
  expect(monitors[0]!.rule).toEqual({ voted: { family: 'LD01.PZR.LT', side: { at_or_below: 3 }, qualification_s: 0.5 } })
  expect(() => compilePzrLevelFrom({ ...texts, measurements: p['systems/instrumentation/phase-dependent-measurements.md'] }))
    .toThrow('Expected one ld01-pzr-level-channels block')
  // The main section carries no monitor until the blocks land.
  expect(compileOperatingIcFrom(pages(), packet).monitors).toEqual([])
})
