import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { servedPlantTopology } from '../src/packs/process-plant/observation/topology.ts'
import { plantControlsFor } from '../src/packs/process-plant/operations/controls.ts'
import { scopeTopology } from '../src/features/displays/topology/scope.ts'
import { flowLayout } from '../src/features/displays/topology/flow-sizing.ts'
import { FLOW_ROOM } from '../src/features/displays/compose/topology.ts'
import { symbolOf } from '../src/ui/embed/vignette/flow-symbols.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

describe('RHR graph and existing process-display boundary', () => {
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:rhr-surfaces', loopCount: 4 }))
  const graph = servedPlantTopology(plant.id as never, plant)
  const declared = new Map(plantDeclaration(plant.id as never, plant, null).observables.map(row => [row.ref, row]))

  test('all four exchangers use existing transfer symbols and read-only physical heat readings', () => {
    for (const id of ['rhrHeatExchangerA', 'rhrHeatExchangerB', 'componentCoolingHeatExchangerA', 'componentCoolingHeatExchangerB']) {
      const node = graph.nodes.find(node => node.id === id)!
      expect(node.class).toBe('transfer')
      const bindings = node.bindings.map(binding => {
        const observable = declared.get(binding.ref)
        if (observable === undefined) throw Error(`Undeclared process-display reading: ${binding.ref}`)
        return { ...binding, quantity: observable.quantity, unit: observable.unit }
      })
      expect(symbolOf({ class: node.class, bindings }, [{ kind: 'fluid', out: false }, { kind: 'fluid', out: true }], false)).toBe('exchanger')
      expect(node.bindings.some(row => row.role === 'value' && row.ref === `${plant.id}#${id}.heatTransferMw`)).toBe(true)
      const observable = declared.get(`${plant.id}#${id}.heatTransferMw`)!
      expect(observable.quantity).toBe('thermal-power')
      expect(observable.unit).toBe('MW')
      expect(observable.basis).not.toBe('command')
      const signal = plant.graph.signalBindingByPath.get(`${id}.heatTransferMw` as never)!
      expect(signal.published).toBe(true)
      expect(signal.writable).toBe(false)
      expect(node.ports.find(port => port.id === 'hotIn')?.circuit).toBe('hot')
      expect(node.ports.find(port => port.id === 'hotOut')?.circuit).toBe('hot')
      expect(node.ports.find(port => port.id === 'coldIn')?.circuit).toBe('cold')
      expect(node.ports.find(port => port.id === 'coldOut')?.circuit).toBe('cold')
    }
  })

  test('hydraulic discovery never crosses an exchanger wall into the other fluid circuit', () => {
    const result = scopeTopology(graph, { from: ['containment'], to: ['core'], media: ['residualHeatRemoval'] })
    if (!result.ok) throw Error(JSON.stringify(result.refusal))
    expect(result.scoped.nodes).toContain('rhrHeatExchangerA')
    expect(result.scoped.nodes).toContain('rhrHeatExchangerB')
    expect(result.scoped.nodes).not.toContain('componentCoolingWaterPumpA')
    expect(result.scoped.nodes).not.toContain('componentCoolingHeatExchangerA')
    expect(result.scoped.edges.length).toBeGreaterThan(0)
    for (const id of result.scoped.edges) {
      const edge = graph.edges.find(edge => edge.id === id)!
      expect(edge.medium).toBe('residualHeatRemoval')
      expect(edge.bindings.some(binding => binding.role === 'flow' && binding.ref === `${plant.id}#${id}.flowKgPerS`)).toBe(true)
    }
    // An energy-transfer relationship is not a fluid connection through the wall.
    expect(scopeTopology(graph, { from: ['rhrPumpA'], to: ['serviceWaterPumpA'] }).ok).toBe(false)
  })

  test('converted cooling pumps and their feeders expose distinct real controls and achieved feedback', () => {
    const controls = plantControlsFor(plant)
    for (const train of ['A', 'B']) {
      for (const name of ['componentCoolingWaterPump', 'serviceWaterPump']) {
        const pumpId = `${name}${train}`
        const pump = controls.items.find(item => item.id === pumpId)!
        const start = pump.offered.find(control => control.path === `${pumpId}.running`)!
        expect(start.form).toBe('twoState')
        expect(start.options.map(option => option.word).sort()).toEqual(['START', 'STOP'])
        expect(start.state).toBe(`${pumpId}.runningState`)
        const feederId = `${name}Breaker${train}`
        const feeder = controls.items.find(item => item.id === feederId)!
        const contacts = feeder.offered.find(control => control.path === `${feederId}.closed`)!
        expect(contacts.state).toBe(`${feederId}.closedState`)
        expect(contacts.options.map(option => option.word).sort()).toEqual(['CLOSE', 'OPEN'])
        const topology = graph.nodes.find(node => node.id === pumpId)!
        expect(topology.class).toBe('mover')
        expect(topology.bindings.some(binding => binding.role === 'running')).toBe(true)
      }
    }
  })

  test('both sides can be shown together using the existing generic layout without a new drawing engine', () => {
    for (const train of ['A', 'B']) {
      const result = scopeTopology(graph, { around: [`rhrHeatExchanger${train}`], reach: 1 })
      if (!result.ok) throw Error(JSON.stringify(result.refusal))
      expect(result.scoped.media).toContain('residualHeatRemoval')
      expect(result.scoped.media).toContain('componentCoolingWater')
      const drawing = flowLayout(result.scoped, FLOW_ROOM, ref => declared.get(ref))
      expect(drawing).not.toBeNull()
      expect(drawing!.layout.nodes.some(node => node.id === `rhrHeatExchanger${train}`)).toBe(true)
      for (const node of drawing!.layout.nodes) {
        for (const value of [node.x, node.y, node.width, node.height]) expect(Number.isFinite(value)).toBe(true)
      }
    }
  })
})
