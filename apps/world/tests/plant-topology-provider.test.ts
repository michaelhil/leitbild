import { afterAll, describe, expect, test } from 'bun:test'
import type { ObjectId } from '../src/core/model/index.ts'
import { topologyGraphSchema } from '../src/core/observation/topology.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { processPlantElectricalPortDefinitions } from '../src/packs/process-plant/electrical-ports.ts'
import { principalCircuits } from '../src/packs/process-plant/equipment/circuits.ts'
import { plantControlsFor } from '../src/packs/process-plant/operations/controls.ts'
import { lineStateProjectionRevision, plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { plantTopology, servedPlantTopology } from '../src/packs/process-plant/observation/topology.ts'
import { guardPlantTests } from './plant-hang-guard.ts'
import { createSteadyPlantRun, plantOperator, type SteadyPlantRun } from './steady-plant-run.ts'

guardPlantTests()

// P5: the Plant as World's `flow` topology (architecture A5; R35); P2 D1:
// its bindings and boundaries, so a drawing shows it live and joins the grid.

const objectId = 'plant:halden-2' as ObjectId
const plantOf = (loopCount: number) => compileProcessPlant(createPwrReferencePlantDefinition({ id: objectId, loopCount }))
const plant = plantOf(4)
const graph = plantTopology(objectId, plant.graph, plant.modelDigest)
const served = servedPlantTopology(objectId, plant)
const node = (id: string) => graph.nodes.find(candidate => candidate.id === id)!
const bindings = (id: string) => served.nodes.find(candidate => candidate.id === id)!.bindings.map(binding => `${binding.role} ${binding.ref.slice(binding.ref.indexOf('#') + 1)}`)
let run: SteadyPlantRun | undefined

afterAll(async () => { await run?.remove() })

describe('plant topology provider (P5)', () => {
  test('the graph validates against core\'s topology schema for two to six loops', () => {
    for (const loopCount of [2, 4, 6]) {
      const other = plantOf(loopCount)
      const topology = servedPlantTopology(objectId, other)
      expect(topologyGraphSchema.parse(topology)).toEqual(topology)
      expect(topology.groups.map(group => group.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F'].slice(0, loopCount))
    }
    expect(served).toMatchObject({ objectId, revision: lineStateProjectionRevision(plant), family: 'flow' })
  })

  test('D1: nodes and lines are bound to what the Plant publishes, each binding a declared observable of the Plant', () => {
    const declared = new Map(plantDeclaration(objectId, plant, null).observables.map(observable => [observable.ref, observable]))
    // Its key values first, as its kind ranks them (a drawing writes its readings in this order), then what its aspects drive.
    expect({
      pressurizer: bindings('pressurizer'), rcp: bindings('rcpA'), bus: bindings('safetyBusA'), valve: bindings('mainSteamIsolationValveA'), header: bindings('feedwaterHeader'),
    }).toEqual({
      // Its level traced (W6.6) and held to its level program, which the drawing marks on it.
      pressurizer: ['value pressurizer.pressureMPa', 'value pressurizer.levelPercent', 'level pressurizer.levelPercent', 'program pressurizer.levelProgramPercent'],
      rcp: ['running rcpA.state'],
      bus: ['conducting safetyBusA.state', 'value safetyBusA.voltageKv'],
      valve: ['conducting mainSteamIsolationValveA.state', 'position mainSteamIsolationValveA.effectivePositionFraction'],
      header: ['flow feedwaterHeader.outletFlowKgPerS'],
    })
    // The core (W1.2): what says a trip stopped it, its flux on the instrument in range (counted by the source range, a
    // current while P-6 holds, a percent while P-10 does), CET, the vessel's level, and its rod banks' inserted shares in
    // their groups, shutdown banks then control banks. A position is a fraction of travel: a valve's opening, each bank's
    // inserted share (the role's contract).
    const core = served.nodes.find(candidate => candidate.id === 'core')!.bindings
    expect(bindings('core')).toEqual(['stopped core.stopped', 'value core.sourceRangeCountRateCps', 'value core.intermediateRangeCurrentAmps', 'value core.powerRangePercent',
      'value core.coreExitTemperatureC', 'level vessel.collapsedLiquidLevelPercent',
      ...['shutdownBankA', 'shutdownBankB', 'shutdownBankC', 'shutdownBankD', 'controlBankA', 'controlBankB', 'controlBankC', 'controlBankD'].map(bank => `position core.${bank}StepsWithdrawn.inserted`)])
    expect(core.slice(1, 4).map(binding => [binding.while?.slice(binding.while.indexOf('#') + 1), binding.word])).toEqual([[undefined, undefined], ['core.aboveP6', undefined], ['core.aboveP10', 'PWR']])
    expect(core.filter(binding => binding.role === 'position').map(binding => binding.group)).toEqual(['1', '1', '1', '1', '2', '2', '2', '2'])
    // A share says what it reads where a drawing writes it (LVL, PWR); a value whose unit says it carries no word.
    const worded = served.nodes.flatMap(entry => entry.bindings.filter(binding => ['level', 'value', 'flow', 'loading'].includes(binding.role)).map(binding => [declared.get(binding.ref)!.unit, binding.word] as const))
    expect(worded.filter(([unit, word]) => (unit === '%' || unit === '1') !== (word !== undefined))).toEqual([])
    expect([...new Set(worded.flatMap(([, word]) => word ?? []))].sort()).toEqual(['LVL', 'PWR'])
    const positions = served.nodes.flatMap(entry => entry.bindings.filter(binding => binding.role === 'position').map(binding => declared.get(binding.ref)!))
    expect(positions.length).toBeGreaterThan(20)
    expect(positions.filter(observable => observable.quantity !== 'fraction' || observable.unit !== '1').map(observable => observable.ref)).toEqual([])
    // Each item that runs, is live, or opens and shuts runs or conducts on its state observable, so a drawing writes its word and
    // the command it does not follow (RUN, SHUT, ON LINE); a valve's glyph opens with its position.
    expect([bindings('offsiteBreakerA'), bindings('condensatePumpA'), bindings('turbine')]).toEqual([['conducting offsiteBreakerA.state'], ['running condensatePumpA.state'], ['running turbine.state', 'value turbine.electricMw']])
    // W1.3: a state it is commanded to and may not follow keeps a line for the command (a pump, a breaker); the turbine's, which nothing commands, keeps none.
    const commanded = (id: string) => served.nodes.find(candidate => candidate.id === id)!.bindings.find(binding => binding.role === 'running' || binding.role === 'conducting')!.commanded === true
    expect([commanded('rcpA'), commanded('offsiteBreakerA'), commanded('mainSteamIsolationValveA'), commanded('turbine'), commanded('safetyBusA')]).toEqual([true, true, true, false, false])
    expect(served.nodes.filter(entry => declared.has(`${objectId}#${entry.id}.state`) && !entry.bindings.some(binding => binding.ref === `${objectId}#${entry.id}.state`)).map(entry => entry.id)).toEqual([])
    expect(served.edges.find(edge => edge.id === 'rcs-hot-leg-a')?.bindings).toEqual([{ role: 'flow', ref: `${objectId}#rcs-hot-leg-a.flowKgPerS` }])
    const refs = [...served.nodes, ...served.edges].flatMap(item => item.bindings.map(binding => binding.ref))
    expect(refs.filter(ref => !declared.has(ref))).toEqual([])
    // Q8: a running or conducting binding reads a boolean (true is on) or a state reading that marks its on state.
    const switching = served.nodes.flatMap(entry => entry.bindings.filter(binding => binding.role === 'running' || binding.role === 'conducting')).map(binding => declared.get(binding.ref)!)
    expect(switching.filter(observable => observable.valueType !== 'boolean' && !observable.states?.some(state => state.active === true)).map(observable => observable.ref)).toEqual([])
    expect(new Set(served.nodes.flatMap(entry => entry.bindings.map(binding => binding.role)))).toEqual(new Set(['level', 'running', 'conducting', 'flow', 'position', 'value', 'stopped', 'program']))
  })

  test('B3: a device its equipment bundles is a switch on the line its port feeds, the item a person operates (the PORV on the relief line)', () => {
    const relief = (from: string) => served.edges.filter(edge => edge.from.node === from).map(edge => `${edge.from.node}.${edge.from.port} -> ${edge.to.node}.${edge.to.port}`)
    expect([...relief('pressurizer').filter(edge => !edge.startsWith('pressurizer.surgeLine')), ...relief('pressurizer.blockValve'), ...relief('pressurizer.reliefValve'), ...relief('pressurizer.safetyValves')]).toEqual([
      'pressurizer.reliefOutlet -> pressurizer.blockValve.in',
      'pressurizer.safetyOutlet -> pressurizer.safetyValves.in',
      'pressurizer.blockValve.out -> pressurizer.reliefValve.in',
      'pressurizer.reliefValve.out -> pressurizerReliefHeader.inletA',
      'pressurizer.safetyValves.out -> pressurizerReliefHeader.inletA',
    ])
    const porv = served.nodes.find(entry => entry.id === 'pressurizer.reliefValve')!
    expect(porv).toMatchObject({ class: 'switch', label: 'PORV', shortLabel: 'PORV' })
    // Its element is its own (W6.1): a press on it opens the device, not its host.
    expect(porv.element).toBe('pressurizer.reliefValve')
    expect(bindings('pressurizer.reliefValve')).toEqual(['conducting pressurizer.reliefValve.state', 'flow pressurizer.reliefFlowKgPerS', 'position pressurizer.reliefValveEffectivePositionFraction'])
    // Each is the item controls.list names, so the pop-over's element actions operate it.
    const items = new Set(plantControlsFor(plant).items.map(item => item.id))
    expect(served.nodes.filter(entry => entry.id.includes('.')).every(entry => items.has(entry.id))).toBe(true)
    // The drawing the old path keeps (plantTopology) has none of them.
    expect(graph.nodes.some(entry => entry.id.includes('.'))).toBe(false)
  })

  test('P9: the overview is the principal circuits, as the unit overview draws them: 29 equipment and the 42 lines among them on four loops', () => {
    const principal = principalCircuits(plant.graph)
    if (!principal.ok) throw new Error(principal.reason)
    expect(served.overview).toEqual({ nodes: principal.components.map(index => String(plant.graph.components[index]!.id)), edges: principal.links.map(index => String(plant.graph.links[index]!.id)) })
    expect([served.overview!.nodes.length, served.overview!.edges.length]).toEqual([29, 42])
    expect(served.overview!.nodes).toEqual(expect.arrayContaining(['core', 'pressurizer', 'sgA', 'rcpA', 'turbine', 'condenser']))
    expect(served.overview!.nodes).not.toContain('chargingPump')
  })

  test('D1: the grid source is the boundary a Scenario connection joins, by the port id the Plant\'s electrical ports name', () => {
    expect(served.boundaries).toEqual([{ node: 'offsiteGrid', port: 'outlet', externalPortId: 'grid-420kv' }])
    expect(processPlantElectricalPortDefinitions(plant).map(port => port.id)).toEqual(['grid-420kv'])
    expect(bindings('offsiteGrid')).toEqual(['conducting offsiteGrid.state'])
  })

  test('nodes are the equipment that pipes or cables join, in the model\'s order, named and labelled as the unit names them', () => {
    const order = plant.graph.components.map(component => String(component.id))
    expect(graph.nodes.map(entry => order.indexOf(entry.id))).toEqual([...graph.nodes.map(entry => order.indexOf(entry.id))].sort((a, b) => a - b))
    expect(graph.nodes.every(entry => entry.element === entry.id)).toBe(true)
    expect(new Set(graph.nodes.map(entry => entry.label)).size).toBe(graph.nodes.length)
    expect(node('pressurizer')).toMatchObject({ label: 'Pressurizer', shortLabel: 'PZR', rank: 'pressurizer|pressurizer|pressure-control' })
    expect(node('sgA')).toMatchObject({ class: 'transfer', group: 'A' })
    // Every node is an element the declaration names, so alert subjects and observables meet the drawing.
    const elements = new Set(plantDeclaration(objectId, plant, null).elements.map(element => element.id))
    expect(graph.nodes.filter(entry => !elements.has(entry.id)).map(entry => entry.id)).toEqual([])
  })

  test('ports carry their circuit and every service on them; media are the services, groups the loops', () => {
    expect(node('core').ports.find(port => port.id === 'coldLegA')).toEqual({ id: 'coldLegA', rank: 'coldLegA', media: ['charging', 'primaryCoolant', 'primaryInjection', 'residualHeatRemoval', 'safetyInjection'], direction: 'in', circuit: 'coolant' })
    expect(node('sgA').ports.map(port => [port.id, port.circuit, port.media.join('+')])).toEqual([
      ['primaryInlet', 'primary', 'primaryCoolant'], ['primaryOutlet', 'primary', 'primaryCoolant'], ['feedwaterInlet', 'secondary', 'auxFeedwater+feedwater'],
      ['steamOutlet', 'secondary', 'mainSteam'], ['steamReliefOutlet', 'relief', 'mainSteam'],
    ])
    // The added cooling chain keeps each exchanger's two fluid circuits distinct all the way to the terminal injection.
    for (const train of ['A', 'B']) {
      expect(node(`rhrHeatExchanger${train}`).ports.map(port => [port.id, port.circuit, port.media])).toEqual([
        ['hotIn', 'hot', ['residualHeatRemoval']], ['hotOut', 'hot', ['residualHeatRemoval']],
        ['coldIn', 'cold', ['componentCoolingWater']], ['coldOut', 'cold', ['componentCoolingWater']],
      ])
      expect(node(`componentCoolingHeatExchanger${train}`).ports.map(port => [port.id, port.circuit, port.media])).toEqual([
        ['hotIn', 'hot', ['componentCoolingWater']], ['hotOut', 'hot', ['componentCoolingWater']],
        ['coldIn', 'cold', ['serviceWater']], ['coldOut', 'cold', ['serviceWater']],
      ])
    }
    expect(graph.edges.find(edge => edge.id === 'rhr-isolation-valve-to-cold-leg-a')).toMatchObject({ medium: 'residualHeatRemoval', from: { node: 'rhrIsolationValve', port: 'outlet' }, to: { node: 'core', port: 'coldLegA' } })
    expect(graph.media.find(medium => medium.id === 'electricalPower')?.kind).toBe('electric-ac')
    expect(graph.media.find(medium => medium.id === 'mainSteam')?.kind).toBe('steam')
    expect(graph.media.find(medium => medium.id === 'feedwater')).toEqual({ id: 'feedwater', label: 'Feedwater', kind: 'fluid' })
  })

  test('an edge carries its own loop where it has one, apart from its ends\' (the charging line into cold leg A)', () => {
    const groupOf = (id: string) => node(id).group
    const own = graph.edges.filter(edge => edge.group !== undefined && edge.group !== (groupOf(edge.from.node) ?? groupOf(edge.to.node)))
    expect(own).toHaveLength(13)
    expect(graph.edges.find(edge => edge.id === 'charging-pump-to-cold-leg-a')).toMatchObject({ group: 'A', medium: 'charging', from: { node: 'chargingPump' }, to: { node: 'core', port: 'coldLegA' } })
  })

  test('the Run serves it to World as the caller, the same graph, unchanged when the caller holds its revision', async () => {
    run = await createSteadyPlantRun()
    const port = run.run.observations(plantOperator)
    const served = await port.topology(run.plantId)
    expect('refused' in served).toBe(false)
    if ('refused' in served) return
    expect(served).toMatchObject({ objectId: run.plantId, family: 'flow', boundaries: [{ node: 'offsiteGrid', port: 'outlet', externalPortId: 'grid-420kv' }] })
    // The drawing's equipment and the devices it bundles, drawn on their lines.
    expect(served.nodes).toHaveLength(graph.nodes.length + plant.graph.components.reduce((count, component) => count + component.semantics.embedded.length, 0))
    expect(await port.topology(run.plantId)).toEqual(served)
    // Every binding reads, as the caller, at the Run's time: the drawing has live state.
    const refs = [...new Set([...served.nodes, ...served.edges].flatMap(item => item.bindings.map(binding => binding.ref)))]
    const reads = await Promise.all(Array.from({ length: Math.ceil(refs.length / 64) }, (_, at) => port.read({ refs: refs.slice(64 * at, 64 * at + 64) })))
    expect(reads.flatMap(read => [...read.unknown, ...read.refused])).toEqual([])
    const observations = reads.flatMap(read => read.observations)
    expect(observations).toHaveLength(refs.length)
    expect(observations.find(observation => observation.ref === `${run!.plantId}#offsiteBreakerA.state`)).toMatchObject({ value: 'on', quality: 'good' })
  })
})
