import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { compileOperatingIc, compileOperatingIcFrom, MISSING_BLOCKS, OPERATING_IC_PAGES } from './reference-design-operating-ic'

const fence = (name: string, body: string) => '```' + name + '\n' + body + '\n```\n'
const channel = '{"lag_s":0.2,"min_pa":0,"max_pa":20000000,"quantum_pa":1000,"sample_s":0.1,"transport_s":0.1}'
const protection = '{"maximum_age_s":0.3,"recovery_s":1,"high_pa":15500000,"high_qualification_s":0.2,"low_pa":13000000,"low_qualification_s":0.5,"unavailable_qualification_s":1,"reset_low_pa":13500000,"reset_high_pa":15200000,"reset_qualification_s":5}'
const taps = '### PZR electronic differential level\n\n' + fence('ld01-pzr-taps', '{"pt1Elevation_m":18.5,"ltLowElevation_m":6.5,"ltHighElevation_m":18.5}')
const pages = (over: Partial<Record<(typeof OPERATING_IC_PAGES)[number], string>> = {}) => ({
  'safety/source-and-primary-protection.md': fence('reference-pzr-pressure-protection', protection),
  'systems/instrumentation/operational-observations.md': fence('reference-pzr-pressure-channel', channel),
  'systems/instrumentation/phase-dependent-measurements.md': taps,
  'safety/reactor-trip-and-hold.md': fence('ld01-s2-holding-circuit', '{"turbineTripToOpening_s":0.2}'),
  ...over,
})

test('the section carries only strict-block values and lists what has none', () => {
  const s = compileOperatingIcFrom(pages())
  expect(s.frame_s).toBe(0.1)
  expect(s.families[0]!.channel).toEqual({ lag_s: 0.2, min: 0, max: 20e6, quantum: 1000, sample_s: 0.1, transport_s: 0.1 })
  expect(s.families[0]!.channels.map(c => [c.id, c.supply])).toEqual([['LD01.PZR.PT1', 'I1'], ['LD01.PZR.PT2', 'I2'], ['LD01.PZR.PT3', 'I3']])
  expect(s.functions.map(f => f.id)).toEqual(['LD01.PROT.PZR.HIGH_PRESSURE', 'LD01.PROT.PZR.LOW_PRESSURE',
    'LD01.PROT.PZR.PRESSURE.UNAVAILABLE', 'LD01.PROT.TG.TRIP'])
  expect(s.functions[0]!.rule).toEqual({ voted: { family: 'LD01.PZR.PT', side: { at_or_above: 15.5e6 }, qualification_s: 0.2 } })
  expect(s.functions[1]!.rule).toEqual({ voted: { family: 'LD01.PZR.PT', side: { at_or_below: 13e6 }, qualification_s: 0.5 } })
  expect(s.functions[1]!.effects.cmt_injection).toBe(true)
  expect(s.functions[2]!.rule).toEqual({ unavailable: { family: 'LD01.PZR.PT', qualification_s: 1 } })
  expect(s.functions[0]!.reset).toEqual({ band: [13.5e6, 15.2e6], duration_s: 5 })
  expect(s.reports[0]).toMatchObject({ sample_s: 0.1, transport_s: 0.1, maximum_age_s: 0.3, recovery_s: 1, supply: 'ACT.B' })
  expect(s.holding.contacts).toEqual(['LD01.TRIP.PERM.I1', 'LD01.TRIP.PERM.I2', 'LD01.TRIP.PERM.I3'])
  // SG low level and loop low flow have no strict blocks: listed, not emitted.
  expect(s.missing).toBe(MISSING_BLOCKS)
  expect(s.functions.some(f => f.id.includes('SG') || f.id.includes('LOW_FLOW'))).toBe(false)
})

test('refusals: a duration off the frame, a disagreeing S2 boundary, a missing block', () => {
  expect(() => compileOperatingIcFrom(pages({ 'safety/source-and-primary-protection.md':
    fence('reference-pzr-pressure-protection', protection.replace('"high_qualification_s":0.2', '"high_qualification_s":0.25')) })))
    .toThrow('not whole')
  expect(() => compileOperatingIcFrom(pages({ 'safety/reactor-trip-and-hold.md':
    fence('ld01-s2-holding-circuit', '{"turbineTripToOpening_s":0.3}') }))).toThrow('S2 holding boundary')
  expect(() => compileOperatingIcFrom(pages({ 'systems/instrumentation/operational-observations.md': 'no block' })))
    .toThrow('Expected one reference-pzr-pressure-channel block')
  expect(() => compileOperatingIcFrom(pages({ 'systems/instrumentation/operational-observations.md':
    fence('reference-pzr-pressure-channel', channel.replace('"transport_s":0.1', '"transport_s":0.2')) }))).toThrow()
})

const wiki = process.env.LD01_WIKI_ROOT
test.skipIf(!wiki)('the actual section from the wiki', async () => {
  const s = await compileOperatingIc(wiki!)
  expect(s.frame_s).toBe(0.1)
  expect(s.functions).toHaveLength(4)
  expect(s.functions[1]!.rule).toEqual({ voted: { family: 'LD01.PZR.PT', side: { at_or_below: 13e6 }, qualification_s: 0.5 } })
  expect(s.provenance[0]).toMatchObject({ pt1_tap_elevation_m: 18.5, s2_holding_boundary_replaced_s: 0.2 })
  const root = join(wiki!, 'world/packs/process-plant/reference-designs/ld-01')
  for (const [i, name] of OPERATING_IC_PAGES.entries()) {
    const text = await Bun.file(join(root, name)).text()
    expect(s.provenance[i + 1]).toEqual({ name, sha256: createHash('sha256').update(text).digest('hex') })
  }
})
