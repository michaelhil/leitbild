import { describe, expect, test } from 'bun:test'
import { compilePlantGraph, processPlantComponentRegistry } from '../src/packs/process-plant/graph/index.ts'
import { bindLd01TagMap, type Ld01Channel } from '../src/packs/process-plant/engine/tag-map.ts'
import { principalCircuits } from '../src/packs/process-plant/equipment/circuits.ts'
import { compileOperatingGraph } from './reference-design-operating-graph'

// A two-loop spine with the joined packet's shape: one core region, a plenum each side, per loop a hot leg, an SG
// primary, one pump and a cold leg, and the PZR on loop A's hot leg through its surge line.
const ids = ['CORE.1', 'DOWN', 'UPPER', 'HOT.A', 'SG.A.PRIMARY', 'PUMP.A1', 'COLD.A', 'HOT.B', 'SG.B.PRIMARY', 'PUMP.B1', 'COLD.B', 'SURGE', 'PZR']
const at = (id: string): number => ids.indexOf(id)
const faces = [
  ['DOWN', 'CORE.1'], ['CORE.1', 'UPPER'],
  ['UPPER', 'HOT.A'], ['HOT.A', 'SG.A.PRIMARY'], ['SG.A.PRIMARY', 'PUMP.A1'], ['PUMP.A1', 'COLD.A'], ['COLD.A', 'DOWN'],
  ['UPPER', 'HOT.B'], ['HOT.B', 'SG.B.PRIMARY'], ['SG.B.PRIMARY', 'PUMP.B1'], ['PUMP.B1', 'COLD.B'], ['COLD.B', 'DOWN'],
  ['HOT.A', 'SURGE'], ['SURGE', 'PZR.SURGE.MOUTH'],
].map(([from, to]) => ({ id: `${from}->${to}`, from: at(from!), to: to === 'PZR.SURGE.MOUTH' ? at('PZR') : at(to!) }))
const packet = {
  identity: 'TEST-SPINE',
  mechanics: { regions: ids.map((id, index) => ({ id, volume_m3: 1 + index, elevation_m: 0 })), faces },
  source_water: [at('CORE.1'), at('CORE.1')],
  thermal: { sg_segments: [{ primary: at('SG.A.PRIMARY'), secondary: 0 }, { primary: at('SG.B.PRIMARY'), secondary: 1 }] },
  hydraulics: { sections: [{ id: 'PUMP.A1', region: at('PUMP.A1'), parameters: { pump: { a: 1 } } }, { id: 'PUMP.B1', region: at('PUMP.B1'), parameters: { pump: { a: 1 } } }, { id: 'DOWN', region: at('DOWN'), parameters: { pump: null } }] },
  pzr: { cell: { index: at('PZR'), bottom_m: 6.5, top_m: 18.5, fluidVolume_m3: 60, ports: [{ id: 'PZR.SURGE.MOUTH', kind: 'surge', face: faces.length - 1 }, { id: 'PZR.RELIEF', kind: 'relief', face: null }] } },
  secondary: { steamGenerators: [{ id: 'A', volume_m3: 120, steamDemand_kg_s: 820 }, { id: 'B', volume_m3: 120, steamDemand_kg_s: 820 }] },
  rods: { clusters: [{ id: 'LD01.CR.001' }, { id: 'LD01.CR.002' }] },
}
const channelSpec = { lag_s: 0.2, quantum: null, indeterminate_band: null, sample_s: 0.1, transport_s: 0.1 }
const ic = {
  identity: 'test-ic',
  frame_s: 0.1,
  families: [
    { id: 'LD01.PZR.PT', quantity: 'pzr_roof_pressure', channels: [1, 2, 3].map(n => ({ id: `LD01.PZR.PT${n}`, supply: `I${n}` })), channel: { ...channelSpec, min: 0, max: 20_000_000 } },
    { id: 'LD01.SG.A.LT.NR', quantity: { sg_collapsed_level: { sg: 'A', area_m2: 12 } }, channels: [{ id: 'LD01.SG.A.LT.NR1', supply: 'unselected' }], channel: { ...channelSpec, min: 4, max: 9 } },
    { id: 'LD01.RCS.A.FT', quantity: { loop_flow: { loop_id: 'A', face: 6, face_id: 'COLD.A->DOWN' } }, channels: [{ id: 'LD01.RCS.A.FT', supply: 'I1' }], channel: { ...channelSpec, min: -1.5, max: 1.5 } },
    { id: 'LD01.CORE.POWER.P', quantity: { current_proxy: { weights: [1] } }, channels: [{ id: 'LD01.CORE.POWER.P1', supply: 'I1' }], channel: { ...channelSpec, min: null, max: null } },
    { id: 'LD01.RCP.A1.SPEED', quantity: { pump_speed: { rotor: 0, rotor_id: 'PUMP.A1' } }, channels: [{ id: 'LD01.RCP.A1.SPEED', supply: 'I1' }], channel: { ...channelSpec, min: 0, max: 1.5 } },
    { id: 'LD01.RCP.B1.SPEED', quantity: { pump_speed: { rotor: 1, rotor_id: 'PUMP.B1' } }, channels: [{ id: 'LD01.RCP.B1.SPEED', supply: 'I2' }], channel: { ...channelSpec, min: 0, max: 1.5 } },
  ],
  functions: [
    { id: 'LD01.PROT.PZR.HIGH_PRESSURE', rule: { voted: { family: 'LD01.PZR.PT', side: { at_or_above: 15_898_400 }, qualification_s: 0.2 } }, effects: { reactor_trip: true, cmt_injection: false, heater_isolation: true, prhr: false } },
    { id: 'LD01.PROT.PZR.LOW_PRESSURE', rule: { voted: { family: 'LD01.PZR.PT', side: { at_or_below: 13_000_000 }, qualification_s: 0.5 } }, effects: { reactor_trip: true, cmt_injection: false, heater_isolation: false, prhr: false } },
    { id: 'LD01.PROT.PZR.S_PRESSURE', rule: { voted: { family: 'LD01.PZR.PT', side: { at_or_below: 12_477_415 }, qualification_s: 0.5 } }, effects: { reactor_trip: true, cmt_injection: true, heater_isolation: false, prhr: true } },
    { id: 'LD01.PROT.RCS.A.LOW_FLOW', rule: { armed: { family: 'LD01.RCS.A.FT', side: { at_or_below: 0.87 }, qualification_s: 1, arming_family: 'LD01.CORE.POWER.P', arming: { above: 0.2 } } }, effects: { reactor_trip: true, cmt_injection: false, heater_isolation: false, prhr: false } },
  ],
  holding: { interface: 'LD01.TRIP.HOLD', supply: 'LD01.DC.ACT.A', manual_interrupt: 'LD01.TRIP.MANUAL', divisions: ['I1', 'I2', 'I3'], contacts: ['LD01.TRIP.PERM.I1'] },
}
const elec = {
  distribution: { consumers: { 'LD01.P.A1': 'AC.A', 'LD01.FW.P1': 'AC.A', 'LD01.P.B1': 'AC.B' } },
  slice: { generator: {}, turbine: {} },
}

const compiled = compileOperatingGraph({ packet, ic, elec, sha8: 'abcdef12' })
const unitOf = (channel: string): string => {
  if (channel.endsWith('RELEASED_POWER') || channel.endsWith('.WT') || channel.endsWith('HEATER.REQUEST')) return 'W'
  if (channel.endsWith('.QUALITY') || channel.endsWith('.LATCHED') || channel.endsWith('.REQUEST') || channel.includes('.FT') || channel.includes('.SPEED') || channel.includes('POWER.P')) return '1'
  if (/\.(TRIP|POWERED|CLOSED|AVAILABLE|INITIATED|OFFSITE_LOST)$/u.test(channel)) return '1'
  if (channel.includes('PT') || channel.endsWith('PRESSURE')) return 'Pa'
  if (channel.endsWith('.FLOW')) return 'kg/s'
  if (channel.endsWith('OMEGA')) return 'rad/s'
  if (channel.endsWith('RELEASED_POWER') || channel.endsWith('.WT') || channel.endsWith('HEATER.REQUEST')) return 'W'
  if (channel.endsWith('EXPORT_ENERGY')) return 'J'
  return 'm'
}
const channelsFor = (ids: ReadonlyArray<string>): ReadonlyArray<Ld01Channel> => ids.map(id => ({ id, unit: unitOf(id), quantity: 'q', source: 's' }))

describe('the LD-01 graph compiler', () => {
  const graph = compilePlantGraph(compiled.graph, processPlantComponentRegistry)
  const component = (id: string) => graph.components.find(entry => String(entry.id) === id)!

  test('makes equipment of the packet structure: one core of the source regions, SGs, pumps, the PZR, the TG', () => {
    expect(component('CORE').kind).toBe('nativeReactorCore' as never)
    expect(component('SG.A.PRIMARY').kind).toBe('nativeSteamGenerator' as never)
    expect(component('PUMP.B1').kind).toBe('nativeCoolantPump' as never)
    expect(component('PZR').kind).toBe('nativePressurizer' as never)
    expect(component('TG').semantics.energy).toEqual([{ role: 'sink', circuit: 'steam', rate: 'TG.terminalPower' as never }])
    expect(graph.components.some(entry => String(entry.id) === 'CORE.1')).toBe(false)
  })

  test('assigns each loop the equipment on a cycle through its SG alone', () => {
    expect(['HOT.A', 'SG.A.PRIMARY', 'PUMP.A1', 'COLD.A'].map(id => component(id).metadata?.loopId)).toEqual(['A', 'A', 'A', 'A'])
    expect(['HOT.B', 'PUMP.B1', 'COLD.B'].map(id => component(id).metadata?.loopId)).toEqual(['B', 'B', 'B'])
    expect(['CORE', 'DOWN', 'UPPER', 'SURGE', 'PZR'].map(id => component(id).metadata?.loopId)).toEqual([undefined, undefined, undefined, undefined, undefined])
    const principal = principalCircuits(graph)
    expect(principal.ok).toBe(true)
  })

  test('publishes the IC channel ids as tags, with their span and protection setpoints', () => {
    const pt1 = graph.signalBindingByTagId.get('LD01.PZR.PT1' as never)!
    expect(String(pt1.path)).toBe('PZR.PT1')
    expect(pt1.unit).toBe('MPa')
    expect(pt1.limits).toEqual({ instrumentSpan: { min: 0, max: 20 }, alarmLimits: { low: 13, lowLow: 12.477415, highHigh: 15.8984 } })
    expect(graph.signalBindingByTagId.get('LD01.RCS.A.FT' as never)!.limits?.alarmLimits).toEqual({ lowLow: 0.87 })
    expect(compiled.tagMap.channels['PZR.PT1' as never]).toBe('LD01.PZR.PT1')
    expect(compiled.tagMap.channels['PUMP.A1.speed' as never]).toBe('LD01.P.A1.OMEGA')
    expect(compiled.tagMap.channels['CORE.rod.LD01.CR.002' as never]).toBe('LD01.ROD.y[LD01.CR.002]')
    expect(compiled.tagMap.commands['PUMP.B1.supplyLoss' as never]).toEqual({ kind: 'SupplyLoss', rotor: 1 })
    expect(compiled.tagMap.commands['PROTECTION.manualReactorTrip' as never]).toEqual({ kind: 'ManualReactorTrip' })
  })

  test('maps every graph variable to a channel or a command, and binds to the channels it names', () => {
    expect(graph.variables.every(variable => compiled.tagMap.channels[variable.path] !== undefined || compiled.tagMap.commands[variable.path] !== undefined)).toBe(true)
    const binding = bindLd01TagMap(graph, compiled.tagMap, channelsFor(Object.values(compiled.tagMap.channels)))
    expect(binding.byPath.size).toBe(graph.variables.length)
    const missing = Object.values(compiled.tagMap.channels).filter(id => id !== 'LD01.PZR.PT2')
    expect(() => bindLd01TagMap(graph, compiled.tagMap, channelsFor(missing))).toThrow('PZR.PT2 reads channel LD01.PZR.PT2, which the unit does not deliver')
  })

  test('refuses a pump with no supply consumer of its name', () => {
    expect(() => compileOperatingGraph({ packet, ic, elec: { ...elec, distribution: { consumers: { 'LD01.P.A1': 'AC.A' } } }, sha8: 'abcdef12' }))
      .toThrow('RCP PUMP.B1 has 0 ELEC consumers named B1')
  })
})
