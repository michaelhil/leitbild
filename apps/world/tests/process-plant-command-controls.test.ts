import { expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  answerProcessPlantQuery, compileProcessPlant, createProcessPlantProtectionRunner,
  compilePlantGraph, createProcessPlantRampRunner, createProcessPlantRuntime, createPwrReferencePlantDefinition,
  processPlantComponentRegistry,
} from '../src/packs/process-plant/index.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import { plantControlsFor } from '../src/packs/process-plant/operations/controls.ts'
import type { ListedItem, ListedReset } from '../src/packs/process-plant/operations/instance-ports.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:command-controls', loopCount: 4 }))
const capability = processPlantCapabilities.find(row => row.id === 'world.process-plant.controls.list')!
const binding = (tagId: string) => resolveProcessPlantSignalBinding(plant.graph, { tagId: tagId as never })
const fixture = (): ProcessPlantRuntimeInstance => {
  const runtime = createProcessPlantRuntime({ system: plant })
  return { plant, runtime, protection: createProcessPlantProtectionRunner({ system: plant, protection: plant.automation }),
    ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() }
}
const list = (instance: ProcessPlantRuntimeInstance, input: Record<string, unknown>) => capability.output.parse(answerProcessPlantQuery({
  request: { capabilityId: capability.id, input: capability.input.parse({ plantId: plant.id, ...input }) },
  plants: new Map([[plant.id, instance]]), objects: new Map(),
})) as { plantId: string; plantElapsedMs: number; items: Array<ListedItem>; resets: Array<ListedReset> }

test('a discovered command resolves its actual drawn control owner without a catalog or equipment-id guess', () => {
  const instance = fixture()
  const before = instance.runtime.snapshot()
  const protectionBefore = instance.protection!.snapshot()
  const selected = list(instance, { commands: [{ tagId: 'RX-TRIP-MAN' }] })
  expect(selected.items.map(item => [item.id, item.label])).toEqual([['core', 'Core']])
  expect(selected.items[0]!.offered).toHaveLength(1)
  const offered = selected.items[0]!.offered[0]!
  expect(offered.control.path).toBe(binding('RX-TRIP-MAN').path)
  expect(offered.control.form).toBe('pushbutton')
  expect(offered.protection?.role).toBe('trip')
  const core = list(instance, { items: ['core'] })
  expect(offered).toEqual(core.items[0]!.offered.find(row => row.control.path === offered.control.path)!)
  expect(selected.items[0]!.withheld).toEqual([])
  const all = list(instance, {})
  expect(JSON.stringify(selected).length).toBeLessThan(JSON.stringify(core).length)
  expect(JSON.stringify(core).length).toBeLessThan(JSON.stringify(all).length)
  expect(instance.runtime.snapshot()).toEqual(before)
  expect(instance.protection!.snapshot()).toEqual(protectionBefore)
})

test('exact path and tag lookup return the same controls, deduplicating repeated bindings', () => {
  const instance = fixture()
  const path = binding('RX-TRIP-MAN').path
  expect(list(instance, { commands: [{ path }] })).toEqual(list(instance, { commands: [{ tagId: 'RX-TRIP-MAN' }] }))
  expect(list(instance, { commands: [{ path }, { tagId: 'RX-TRIP-MAN' }, { path }] }))
    .toEqual(list(instance, { commands: [{ path }] }))
})

test('withheld commands keep their declared and automatic reasons rather than becoming an offered substitute', () => {
  const instance = fixture()
  for (const tagId of ['TRIP-BKR-A', 'MFW-A-CV']) {
    const path = binding(tagId).path
    const selected = list(instance, { commands: [{ tagId }] })
    expect(selected.items).toHaveLength(1)
    const owner = selected.items[0]!
    const original = list(instance, { items: [owner.id] }).items[0]!
    expect(owner.offered).toEqual(original.offered.filter(row => row.control.path === path))
    expect(owner.withheld).toEqual(original.withheld.filter(row => row.path === path))
    expect(owner.withheld.length).toBeGreaterThan(0)
  }
})

test('an embedded device resolves to its canonical owner and preserves actual position and option consequences', () => {
  const instance = fixture()
  const selected = list(instance, { commands: [{ tagId: 'MOV-8000A' }] })
  expect(selected.items.map(item => item.id)).toEqual(['pressurizer.blockValve'])
  const item = selected.items[0]!
  const original = list(instance, { items: [item.id] }).items[0]!
  expect(item.position).toEqual(original.position)
  expect(item.offered).toEqual(original.offered.filter(row => row.control.path === binding('MOV-8000A').path))
  expect(item.offered[0]!.consequenceLines).toHaveLength(item.offered[0]!.control.options.length)
})

test('AFW command lookup preserves actual protective floors and related reset holds on all requested valves', () => {
  const instance = fixture()
  instance.runtime.writeCommand({ type: 'setVariable', path: binding('SI-MAN').path, value: true })
  for (let tick = 0; tick < 3; tick++) {
    instance.runtime.tick(1_000)
    instance.protection!.evaluate({ runtime: instance.runtime, elapsedMs: instance.runtime.elapsedMs(),
      simulationRunId: 'run-command-controls' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
  }
  const tags = ['AFW-A-CV', 'AFW-B-CV', 'AFW-C-CV', 'AFW-D-CV']
  const before = instance.runtime.snapshot()
  const protectionBefore = instance.protection!.snapshot()
  const selected = list(instance, { commands: tags.map(tagId => ({ tagId })) })
  const paths = new Set(tags.map(tagId => binding(tagId).path))
  expect(selected.items.flatMap(item => item.offered.map(row => row.control.path)).sort()).toEqual([...paths].sort())
  for (const item of selected.items) {
    const original = list(instance, { items: [item.id] }).items[0]!
    for (const offered of item.offered) {
      expect(offered).toEqual(original.offered.find(row => row.control.path === offered.control.path)!)
      expect(offered.actuationHold?.floor?.value).toBe(0.2)
      expect(offered.actuationHold!.rules.length).toBeGreaterThan(0)
    }
  }
  const allResets = list(instance, {}).resets
  const expected = allResets.filter(reset => reset.holds.some(path => paths.has(path)))
  expect(expected.length).toBeGreaterThan(0)
  expect(selected.resets).toEqual(expected)
  expect(instance.runtime.snapshot()).toEqual(before)
  expect(instance.protection!.snapshot()).toEqual(protectionBefore)
})

test('a protective pushbutton retains its own latched consequence reset even when it holds different equipment', () => {
  const instance = fixture()
  instance.runtime.writeCommand({ type: 'setVariable', path: binding('RX-TRIP-MAN').path, value: true })
  instance.runtime.tick(1_000)
  instance.protection!.evaluate({ runtime: instance.runtime, elapsedMs: instance.runtime.elapsedMs(),
    simulationRunId: 'run-command-controls' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
  const selected = list(instance, { commands: [{ tagId: 'RX-TRIP-MAN' }] })
  const reset = selected.resets.find(row => row.ruleId === 'reactor-manual-trip')
  expect(reset).toEqual(list(instance, {}).resets.find(row => row.ruleId === 'reactor-manual-trip'))
  expect(reset).toBeDefined()
  expect(reset!.holds).not.toContain(binding('RX-TRIP-MAN').path)
  expect(reset!.holds.length).toBeGreaterThan(0)
})

test('unknown, stale, read-only, boundary and injected-fault references refuse without widening the selection or changing state', () => {
  const instance = fixture()
  const before = instance.runtime.snapshot()
  expect(() => list(instance, { commands: [{ tagId: 'manualReactorTrip' }] })).toThrow('signal tag not found')
  expect(() => list(instance, { commands: [{ path: 'halden-2.reactor' }] })).toThrow('signal path not found')
  expect(() => list(instance, { commands: [{ tagId: 'NIS-PR-AVG' }] })).toThrow('not a writable Plant command')
  const boundary = [...plant.graph.signalBindingByPath.values()].find(row => row.writable && row.actuation === 'boundary')!
  expect(boundary).toBeDefined()
  expect(() => list(instance, { commands: [{ path: boundary.path }] })).toThrow('not a writable Plant command')
  const fault = [...plant.graph.signalBindingByPath.values()].find(row => row.actuation === 'faultInjection')!
  expect(fault).toBeDefined()
  expect(() => list(instance, { commands: [{ path: fault.path }] })).toThrow('fault the scenario injects')
  expect(() => list(instance, { commands: [{ tagId: 'RX-TRIP-MAN' }, { tagId: 'NIS-PR-AVG' }] })).toThrow('not a writable Plant command')
  expect(instance.runtime.snapshot()).toEqual(before)
})

test('command references use the existing exact reference schema and cannot be mixed with item selection', () => {
  const instance = fixture()
  for (const input of [
    { commands: [] }, { commands: [{}] }, { commands: [{ tagId: 'RX-TRIP-MAN', path: binding('RX-TRIP-MAN').path }] },
    { commands: [{ tagId: 'RX-TRIP-MAN', equipmentId: 'reactor' }] },
    { commands: [{ tagId: 'RX-TRIP-MAN' }], items: ['core'] },
  ]) expect(() => list(instance, input)).toThrow()
  // Default and item requests still retain their complete pre-existing shape.
  const controls = plantControlsFor(plant)
  expect(list(instance, {}).items.map(item => item.id)).toEqual(controls.items.map(item => item.id))
  expect(list(instance, { items: ['core'] }).items[0]!.offered.map(row => row.control.path))
    .toEqual(controls.items.find(item => item.id === 'core')!.offered.map(row => row.path))
})

test('a real writable logic command without a drawn offered/withheld control is refused instead of widened', () => {
  const input = binding('SI-BLOCK')
  if (input.owner.type !== 'component') throw new Error('SI block must be a component command')
  const component = plant.graph.components[input.owner.componentIndex]!
  const sourceGraph = { ...plant.sourceGraph, components: plant.sourceGraph.components.map(row => {
    if (row.id !== component.id) return row
    const { momentary: _momentary, ...presentation } = row.metadata?.presentation ?? {}
    return { ...row, metadata: { ...row.metadata, presentation } }
  }) }
  const unwordedPlant = { ...plant, graph: compilePlantGraph(sourceGraph, processPlantComponentRegistry) }
  const runtime = createProcessPlantRuntime({ system: unwordedPlant })
  const instance = { ...fixture(), plant: unwordedPlant, runtime }
  const before = runtime.snapshot()
  expect(input.writable).toBe(true)
  expect(input.actuation).toBe('command')
  expect(() => list(instance, { commands: [{ tagId: 'SI-BLOCK' }] })).toThrow('has no offered or withheld control')
  expect(runtime.snapshot()).toEqual(before)
})
