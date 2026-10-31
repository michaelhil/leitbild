import { describe, expect, test } from 'bun:test'
import { compilePlantGraph, processPlantComponentRegistry } from '../src/packs/process-plant/graph/index.ts'
import { bindLd01TagMap, type Ld01Channel } from '../src/packs/process-plant/engine/tag-map.ts'
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
