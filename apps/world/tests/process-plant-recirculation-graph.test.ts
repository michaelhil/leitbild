import { expect, test } from 'bun:test'
import { observableSchema } from '../src/core/observation/model.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { plantControlsFor } from '../src/packs/process-plant/operations/controls.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { servedPlantTopology } from '../src/packs/process-plant/observation/topology.ts'

const plantOf = (loopCount = 4) => compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:recirculation-graph', loopCount }))
const valves = [
  ['rhrRwstSuctionValve', 'RHR-RWST', 1],
  ['rhrSumpSuctionValve', 'RHR-SUMP', 0],
  ['rhrInjectionValve', 'RHR-INJ', 0],
  ['siRwstSuctionValve', 'SI-RWST', 1],
  ['siPiggybackValve', 'SI-PIGGYBACK', 0],
] as const

test('each RHR train has two isolated suction sources and independent direct and same-train SI delivery paths', () => {
  for (const loopCount of [2, 4, 6]) {
    const plant = plantOf(loopCount), graph = plant.sourceGraph
    expect(graph.components.some(component => ['rhrHeader', 'rhrIsolationValve'].includes(component.id))).toBe(false)
    const incident = (id: string, direction: 'from' | 'to') => graph.connections.filter(edge => edge[direction].startsWith(`${id}.`)).map(edge => [edge.from, edge.to, edge.service])
    for (const train of ['A', 'B']) {
      expect(incident(`rhrSuctionHeader${train}`, 'to')).toEqual([
        [`rhrRwstSuctionValve${train}.outlet`, `rhrSuctionHeader${train}.inletA`, 'residualHeatRemoval'],
        [`rhrSumpSuctionValve${train}.outlet`, `rhrSuctionHeader${train}.inletB`, 'residualHeatRemoval'],
      ])
      expect(incident(`rhrPump${train}`, 'to').filter(([, , service]) => service !== undefined)).toEqual([
        [`rhrSuctionHeader${train}.outletA`, `rhrPump${train}.inlet`, 'residualHeatRemoval'],
      ])
      expect(incident(`rhrDischargeHeader${train}`, 'to')).toEqual([
        [`rhrHeatExchanger${train}.hotOut`, `rhrDischargeHeader${train}.inletA`, 'residualHeatRemoval'],
      ])
      expect(incident(`rhrDischargeHeader${train}`, 'from')).toEqual([
        [`rhrDischargeHeader${train}.outletA`, `rhrInjectionValve${train}.inlet`, 'residualHeatRemoval'],
        [`rhrDischargeHeader${train}.outletB`, `siPiggybackValve${train}.inlet`, 'safetyInjection'],
      ])
      expect(incident(`rhrInjectionValve${train}`, 'from')).toEqual([
        [`rhrInjectionValve${train}.outlet`, `core.coldLeg${train}`, 'residualHeatRemoval'],
      ])
      expect(incident(`siSuctionHeader${train}`, 'to')).toEqual([
        [`siPiggybackValve${train}.outlet`, `siSuctionHeader${train}.inletB`, 'safetyInjection'],
        [`siRwstSuctionValve${train}.outlet`, `siSuctionHeader${train}.inletA`, 'safetyInjection'],
      ])
      expect(incident(`safetyInjectionPump${train}`, 'to').filter(([, , service]) => service !== undefined)).toEqual([
        [`siSuctionHeader${train}.outletA`, `safetyInjectionPump${train}.inlet`, 'safetyInjection'],
      ])
      // Source valves are local train hardware. Containment spray remains a
      // separate RWST user after both ECCS suction branches are transferred.
      expect(incident(`rhrRwstSuctionValve${train}`, 'to')).toEqual([['rwst.outlet', `rhrRwstSuctionValve${train}.inlet`, 'residualHeatRemoval']])
      expect(incident(`rhrSumpSuctionValve${train}`, 'to')).toEqual([['containment.sumpOut', `rhrSumpSuctionValve${train}.inlet`, 'residualHeatRemoval']])
      expect(incident(`siRwstSuctionValve${train}`, 'to')).toEqual([['rwst.outlet', `siRwstSuctionValve${train}.inlet`, 'safetyInjection']])
      expect(incident(`containmentSprayPump${train}`, 'to').filter(([, , service]) => service !== undefined)).toEqual([['rwst.outlet', `containmentSprayPump${train}.inlet`, 'containmentSpray']])
    }
  }
})

test('source and injection valves expose ordinary controls, achieved feedback and finite travel without invented transfer interlocks', () => {
  const plant = plantOf(), controls = plantControlsFor(plant), topology = servedPlantTopology(plant.id as never, plant)
  for (const train of ['A', 'B']) for (const [prefix, tag, initial] of valves) {
    const id = `${prefix}${train}`, component = plant.graph.components.find(component => component.id === id)!
    expect(component.parameters).toMatchObject({ initialPositionFraction: initial, valveMode: 'isolation', strokeOpenTimeS: 8, strokeCloseTimeS: 8 })
    expect(component.semantics.aspects.find(aspect => aspect.aspect === 'position')).toMatchObject({ state: { path: `${id}.effectivePositionFraction` }, command: `${id}.positionFraction`, travel: { onS: 8, offS: 8 } })
    const control = controls.items.find(item => item.id === id)!.offered.find(control => control.path === `${id}.positionFraction`)!
    expect(String(control.state)).toBe(`${id}.effectivePositionFraction`)
    expect(control.options.map(option => option.word).sort()).toEqual(['OPEN', 'SHUT'])
    const node = topology.nodes.find(node => node.id === id)!
    expect(node.class).toBe('switch')
    expect(node.bindings.some(binding => binding.role === 'position' && binding.ref === `${plant.id}#${id}.effectivePositionFraction`)).toBe(true)
    for (const [path, expectedTag, writable] of [['positionFraction', `${tag}-${train}`, true], ['effectivePositionFraction', `${tag}-${train}-POS`, false]] as const) {
      const signal = plant.graph.signalBindingByPath.get(`${id}.${path}` as never)!
      expect(signal.tagId).toBe(expectedTag); expect(signal.writable).toBe(writable); expect(signal.published).toBe(true)
    }
    expect(plant.automation.rules.flatMap(rule => rule.commandGates).some(gate => 'path' in gate.signal && gate.signal.path === `${id}.positionFraction`)).toBe(false)
  }
})

test('source-specific flow tags are read-only native quantities and every observable fits the existing wire contract', () => {
  const plant = plantOf(), declaration = plantDeclaration(plant.id as never, plant, null)
  for (const observable of declaration.observables) expect(observableSchema.parse(observable)).toEqual(observable)
  for (const train of ['A', 'B']) {
    const t = train.toLowerCase()
    for (const [edge, tag] of [
      [`rhr-sump-suction-valve-${t}-to-suction-header`, `RHR-SUMP-${train}-FLOW`],
      [`rhr-rwst-suction-valve-${t}-to-suction-header`, `RHR-RWST-${train}-FLOW`],
      [`rhr-injection-valve-${t}-to-cold-leg-${t}`, `RHR-INJ-${train}-FLOW`],
      [`si-piggyback-valve-${t}-to-suction-header`, `SI-PIGGYBACK-${train}-FLOW`],
      [`si-rwst-suction-valve-${t}-to-suction-header`, `SI-RWST-${train}-FLOW`],
    ]) {
      const signal = plant.graph.signalBindingByPath.get(`${edge}.flowKgPerS` as never)!
      expect(signal).toMatchObject({ tagId: tag, unit: 'kg/s', quantity: 'flowRate', published: true, writable: false })
      expect(declaration.observables.find(observable => observable.ref === `${plant.id}#${edge}.flowKgPerS`)).toMatchObject({ unit: 'kg/s', valueType: 'number' })
    }
  }
  expect(plant.graph.signalBindings.some(signal => ['LO-HEAD-FLOW', 'RHR-ISOL', 'RHR-ISOL-POS'].includes(signal.tagId ?? ''))).toBe(false)
  for (const id of ['vessel-release-to-containment', 'rwst-to-containment-spray-pump-a', 'rwst-to-containment-spray-pump-b', 'containment-spray-pump-a-to-header', 'containment-spray-pump-b-to-header', 'containment-spray-header-to-containment']) {
    expect(plant.graph.signalBindingByPath.get(`${id}.soluteConcentrationPpm` as never)).toMatchObject({ unit: 'ppm', quantity: 'concentration', published: true, writable: false })
    expect(declaration.observables.find(observable => observable.ref === `${plant.id}#${id}.soluteConcentrationPpm`)).toMatchObject({ unit: 'ppm', valueType: 'number' })
  }
})
