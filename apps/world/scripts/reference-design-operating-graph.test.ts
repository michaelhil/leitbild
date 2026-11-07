import { describe, expect, test } from 'bun:test'
import { compilePlantGraph, processPlantComponentRegistry } from '../src/packs/process-plant/graph/index.ts'
import { bindLd01TagMap, convertLd01Channel, ld01ChannelIdOf, ld01CommandSchema, type Ld01Channel } from '../src/packs/process-plant/engine/tag-map.ts'
import { principalCircuits } from '../src/packs/process-plant/equipment/circuits.ts'
import { compileOperatingGraph } from './reference-design-operating-graph'
import { elec, ic, packet, unitOf } from './reference-design-operating-graph.fixture'

const compiled = compileOperatingGraph({ packet, ic, elec, sha8: 'abcdef12' })
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
    expect(compiled.tagMap.channels['CORE.rod.LD01.CR.002' as never]).toBe('LD01.ROD.LD01.CR.002.TRAVEL')
    expect(compiled.tagMap.commands['PUMP.B1.supplyLoss' as never]).toEqual({ kind: 'SupplyLoss', rotor: 1 })
    expect(compiled.tagMap.commands['PROTECTION.manualReactorTrip' as never]).toEqual({ kind: 'ManualReactorTrip' })
  })

  test('maps every graph variable to a channel or a command, and binds to the channels it names', () => {
    expect(graph.variables.every(variable => compiled.tagMap.channels[variable.path] !== undefined || compiled.tagMap.commands[variable.path] !== undefined)).toBe(true)
    const binding = bindLd01TagMap(graph, compiled.tagMap, channelsFor(Object.values(compiled.tagMap.channels).map(ld01ChannelIdOf)))
    expect(binding.byPath.size).toBe(graph.variables.length)
    const missing = Object.values(compiled.tagMap.channels).map(ld01ChannelIdOf).filter(id => id !== 'LD01.PZR.PT2')
    expect(() => bindLd01TagMap(graph, compiled.tagMap, channelsFor(missing))).toThrow('PZR.PT2 reads channel LD01.PZR.PT2, which the unit does not deliver')
  })

  test('refuses a pump with no supply consumer of its name', () => {
    expect(() => compileOperatingGraph({ packet, ic, elec: { ...elec, distribution: { consumers: { 'LD01.P.A1': 'AC.A' } } }, sha8: 'abcdef12' }))
      .toThrow('RCP PUMP.B1 has 0 ELEC consumers named B1')
  })
})

describe('the ECA0 binding: a section declaring the governor and the DC groups', () => {
  const groups = ['LD01.DC.I3', 'LD01.DC.ACT.A']
  const position = (id: string, quantity: unknown) => ({ id, quantity, channels: [{ id, supply: 'ACT.B' }], channel: { min: 0, max: 100, sample_s: 0.1, transport_s: 0.1 } })
  const declared = {
    ...ic,
    governor: { declared: true, basis: 'test' },
    dc: { declared: true, basis: 'test' },
    families: [...ic.families, position('LD01.TG.STOP.POS', { stop_valve_position: { stop_travel_s: 0.3 } }), position('LD01.TG.ADM.POS', 'admission_position')],
    reports: [
      ...ic.reports,
      { id: 'LD01.AC.A.UNIT.CLOSED', source: { incoming_closed: { bus: 'AC.A', source: 'unit' } }, supply: 'I1' },
      ...groups.flatMap(group => [
        { id: `${group}.OUTPUT`, source: { dc_output: { group } }, supply: group.slice('LD01.DC.'.length) },
        { id: `${group}.CAUSE.OVERLOAD`, source: { dc_cause: { group, cause: 'Overload' } }, supply: group.slice('LD01.DC.'.length) },
      ]),
    ],
    engineering: groups.flatMap(group => [
      { id: `${group}.LOAD.REQUESTED`, group, field: 'requested_w', unit: 'W', label: 'present requested duty' },
      { id: `${group}.ENERGY`, group, field: 'energy_j', unit: 'J', label: 'estimate: usable stored energy' },
      { id: `${group}.DEPLETION`, group, field: 'depletion_s', unit: 's', label: 'estimate: time the energy reaches its limit' },
    ]),
  }
  const dcCharging = { 'LD01.DC.I3': { normal: 'AC.A', alternate: 'AC.B' }, 'LD01.DC.ACT.A': { normal: 'AC.A' } }
  const bound = compileOperatingGraph({ packet, ic: declared, elec, sha8: 'abcdef12', dcCharging })
  const graph = compilePlantGraph(bound.graph, processPlantComponentRegistry)
  const channels = channelsFor(Object.values(bound.tagMap.channels).map(ld01ChannelIdOf))
  const binding = bindLd01TagMap(graph, bound.tagMap, channels)
  const tagged = (tag: string) => graph.variables.find(variable => variable.descriptor.tagId === tag)
  const command = (path: string) => bound.tagMap.commands[`TG.${path}` as never]

  test('binds ADM.POS beside the STOP on the turbine-generator, in percent, each under its own tag', () => {
    expect(tagged('LD01.TG.ADM.POS')).toMatchObject({ path: 'TG.ADM_POS', descriptor: { unit: 'percent', quantity: 'ratio' } })
    expect(tagged('LD01.TG.STOP.POS')).toMatchObject({ path: 'TG.POS', descriptor: { unit: 'percent' } })
    expect(bound.tagMap.channels['TG.ADM_POS.quality' as never]).toBe('LD01.TG.ADM.POS.QUALITY')
  })

  test('binds the DC reports as booleans and the engineering values in kW, MJ and s, each under its tag', () => {
    expect(tagged('LD01.DC.I3.OUTPUT')?.descriptor).toMatchObject({ unit: 'boolean', quantity: 'boolean' })
    expect(tagged('LD01.DC.ACT.A.CAUSE.OVERLOAD')?.descriptor).toMatchObject({ unit: 'boolean' })
    const read = (tag: string, sample: number) => {
      const entry = binding.byPath.get(tagged(tag)!.path)!
      if (entry.kind === 'command') throw new Error(`${tag} is a command`)
      return { unit: entry.variable.descriptor.unit, value: convertLd01Channel(entry, sample) }
    }
    expect(read('LD01.DC.I3.LOAD.REQUESTED', 3_000)).toEqual({ unit: 'kW', value: 3 })
    expect(read('LD01.DC.I3.ENERGY', 86_400_000)).toEqual({ unit: 'MJ', value: 86.4 })
    expect(read('LD01.DC.I3.DEPLETION', 27_703.37)).toEqual({ unit: 's', value: 27_703.37 })
    // No estimate while the group is not discharging reads as no number, never as a time.
    expect(read('LD01.DC.I3.DEPLETION', Number.NaN).value).toBeNaN()
  })

  test('offers the operator electrical commands, RESET and CLOSE separate, the charger input only where one is selectable', () => {
    expect(command('incoming.AC.A.unit.open')).toEqual({ kind: 'IncomingDevice', bus: 'AC.A', source: 'unit', target: 'Open' })
    expect(command('incoming.AC.A.unit.close')).toEqual({ kind: 'IncomingDevice', bus: 'AC.A', source: 'unit', target: 'Closed' })
    expect(command('start.LD01.P.A1')).toEqual({ kind: 'StartConsumer', consumer: 'LD01.P.A1' })
    expect(command('dc.LD01.DC.I3.reset')).toEqual({ kind: 'DcDistribution', group: 'LD01.DC.I3', action: 'Reset' })
    expect(command('dc.LD01.DC.I3.close')).toEqual({ kind: 'DcDistribution', group: 'LD01.DC.I3', action: 'Close' })
    expect(command('dc.LD01.DC.I3.charger.AC.B')).toEqual({ kind: 'DcChargerInput', group: 'LD01.DC.I3', bus: 'AC.B' })
    expect(command('dc.LD01.DC.ACT.A.charger.AC.A')).toBeUndefined()
    for (const entry of Object.values(bound.tagMap.commands)) expect(ld01CommandSchema.parse(entry)).toEqual(entry)
  })

  test('refuses a section declaring the DC groups without their charging block, and a group it does not hold', () => {
    expect(() => compileOperatingGraph({ packet, ic: declared, elec, sha8: 'abcdef12' })).toThrow('needs their ld01-dc-charging block')
    expect(() => compileOperatingGraph({ packet, ic: declared, elec, sha8: 'abcdef12', dcCharging: { 'LD01.DC.I3': { normal: 'AC.A' } } })).toThrow('LD01.DC.ACT.A has no ld01-dc-charging record')
  })

  test('a section declaring neither gains no DC or ADM variable, and only the commands its routing holds', () => {
    const undeclared = Object.keys(compiled.tagMap.channels)
    expect(undeclared.some(path => path.includes('DC-') || path.includes('ADM_POS'))).toBe(false)
    expect(Object.keys(compiled.tagMap.commands).some(path => path.startsWith('TG.dc.') || path.startsWith('TG.incoming.'))).toBe(false)
    expect(compiled.tagMap.commands['TG.start.LD01.P.A1' as never]).toEqual({ kind: 'StartConsumer', consumer: 'LD01.P.A1' })
  })

  test('refuses a malformed operator command', () => {
    expect(() => ld01CommandSchema.parse({ kind: 'DcDistribution', group: 'LD01.DC.I3', action: 'Trip' })).toThrow()
    expect(() => ld01CommandSchema.parse({ kind: 'IncomingDevice', bus: 'AC.A', source: 'grid', target: 'Open' })).toThrow()
    expect(() => ld01CommandSchema.parse({ kind: 'StartConsumer', consumer: 'LD01.P.A1', extra: 1 })).toThrow()
  })
})
