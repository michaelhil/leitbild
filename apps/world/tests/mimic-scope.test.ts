import { describe, expect, test } from 'bun:test'
import {
  compileProcessPlant,
  createPwrReferencePlantDefinition,
  compilePlantGraph,
  processPlantComponentRegistry,
  type CompiledPlantGraph,
} from '../src/packs/process-plant/index.ts'
import { component, connect, plantGraph } from '../src/packs/process-plant/graph/builder.ts'
import { resolveMimicScope, stubText, type MimicIntent } from '../src/packs/process-plant/displays/mimic/scope.ts'
import { unpresentedKinds } from '../src/packs/process-plant/displays/mimic/presentation.ts'
import { framingRules, itemBinding, linkFlowBinding, NO_FLOW_FRACTION } from '../src/packs/process-plant/displays/mimic/bindings.ts'

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:scope', loopCount: 4 }))
const graph = plant.graph
const label = (graph: CompiledPlantGraph, index: number) => graph.components[index]!.metadata?.presentation?.shortLabel ?? String(graph.components[index]!.id)

const drawn = (graph: CompiledPlantGraph, intent: MimicIntent) => {
  const result = resolveMimicScope(graph, intent)
  if (!result.ok) throw new Error(JSON.stringify(result.issues))
  return { ...result.scope, labels: result.scope.components.map(index => label(graph, index)).sort() }
}
const rejection = (graph: CompiledPlantGraph, intent: MimicIntent) => {
  const result = resolveMimicScope(graph, intent)
  if (result.ok) throw new Error('expected a rejection')
  return result.issues
}

describe('mimic scope from the agent\'s intent', () => {
  test('a route keeps every parallel branch and never crosses circuits', () => {
    expect(drawn(graph, { from: ['feedwaterTank'], to: ['sgB'] }).labels).toEqual(['FCV B', 'FW tank', 'MFW A', 'MFW B', 'MFW header', 'SG B'])
    // The diesel feeds its own bus only; no route reaches the other train's pump.
    expect(drawn(graph, { from: ['dieselGeneratorA'], to: ['auxFeedwaterPumpMotor'] }).labels).toEqual(['Bus A', 'EDG A', 'EDG BKR A', 'MD AFW A'])
    expect(rejection(graph, { from: ['dieselGeneratorB'], to: ['auxFeedwaterPumpMotor'] })[0]!.message).toBe('no electricalPower route from dieselGeneratorB to auxFeedwaterPumpMotor in the Plant model; dieselGeneratorB delivers electricalPower and auxFeedwaterPumpMotor receives auxFeedwater, electricalPower')
  })

  test('names resolve from ids, the tags the agent already has, labels or short labels', () => {
    const scope = drawn(graph, { from: ['FW tank', 'AFW tank'], to: ['SG-B-LVL-NR'] })
    expect(scope.names.map(name => name.via)).toEqual(['label', 'label', 'tag'])
    expect(scope.labels).toContain('AFW valve B')
    // A label as an operator writes it: any case, spaces or hyphens.
    for (const [name, id] of [['safety bus A', 'safetyBusA'], ['motor-driven auxiliary feedwater pump', 'auxFeedwaterPumpMotor'], ['SG-B', 'sgB']] as const) {
      const [resolved] = drawn(graph, { to: [name], services: ['electricalPower', 'auxFeedwater', 'feedwater'] }).names
      expect(graph.components[resolved!.component]!.id).toBe(id as never)
    }
    // A class of equipment is not one component: the suggestions name each.
    const [unknown] = rejection(graph, { to: ['steam generators'], services: ['feedwater'] })
    expect(unknown!.message).toBe('unknown equipment "steam generators"; name one component per entry: its id, a tag measured on it, its label or its short label')
    expect(unknown!.didYouMean!.map(suggestion => suggestion.split(' ')[0])).toEqual(['sgA', 'sgB', 'sgC'])
  })

  test('a service the equipment does not carry is refused with what it carries', () => {
    expect(rejection(graph, { from: ['pressurizer'], services: ['feedwater'] })[0]!.message)
      .toBe('nothing feedwater connects to pressurizer in the Plant model; pressurizer carries electricalPower, primaryCoolant, primaryRelief')
  })

  test('one end needs a service when it has several, and a reversed route says so', () => {
    expect(rejection(graph, { to: ['sgB'] })[0]!.message).toBe('sgB receives auxFeedwater, feedwater, primaryCoolant; add services to say which')
    expect(rejection(graph, { from: ['sgB'], to: ['feedwaterTank'], services: ['feedwater'] })[0]!.message).toBe('feedwaterTank feeds sgB, not the other way: swap from and to')
    expect(rejection(graph, { services: ['AFW'] })[0]!.didYouMean).toEqual(['auxFeedwater'])
  })

  test('a one-ended intent reaches three links, draws the source just beyond, and stubs the rest', () => {
    const scope = drawn(graph, { to: ['sgB'], services: ['feedwater', 'auxFeedwater'] })
    // The tanks are one step past the reach and feed nothing else: drawn, not stubbed at every pump.
    expect(scope.labels).toEqual(['AFW header', 'AFW tank', 'AFW valve B', 'FCV B', 'FW tank', 'MD AFW A', 'MD AFW B', 'MFW A', 'MFW B', 'MFW header', 'SG B', 'TD AFW'])
    // A header's outlets to the other loops stop the drawing once.
    expect(scope.stubs.map(stub => `${label(graph, stub.component)}: ${stubText(graph, stub)}`)).toEqual([
      'MFW header: to FCV A, FCV C, FCV D',
      'AFW header: to AFW valve A, AFW valve C, AFW valve D',
    ])
  })

  test('loops narrow a system to their own links and the shared equipment on routes into them', () => {
    const scope = drawn(graph, { services: ['safetyInjection'], loops: ['C'] })
    expect(scope.labels).toEqual(['Core', 'HHSI A', 'HHSI B', 'RWST', 'SI header'])
    // Flow toward the other loops leaves the drawing at the header, named by port where the core has several alike.
    expect(scope.stubs.map(stub => stubText(graph, stub))).toEqual(['to Core cold leg A, cold leg B, cold leg D'])
    expect(drawn(graph, { services: ['primaryCoolant'], loops: ['A', 'B'] }).labels).toEqual(['Core', 'PZR', 'RCP A', 'RCP B', 'SG A', 'SG B'])
  })

  test('the same intent always draws the same equipment', () => {
    const intent = { to: ['sgB'], services: ['feedwater', 'auxFeedwater'] }
    expect(JSON.stringify(resolveMimicScope(graph, intent))).toBe(JSON.stringify(resolveMimicScope(graph, intent)))
  })
})

describe('the mimic draws any Plant, not only the reference PWR', () => {
  // Two trains of a cooling-water skid with a diesel-backed bus: no PWR names, loops N and S.
  const water = {
    connectionKind: 'fluidFlow' as const, service: 'coolant', nominalFluid: 'water' as const, designPhase: 'liquid' as const, solverModel: 'incompressibleLiquid' as const,
    variables: [
      { path: 'flowKgPerS', label: 'Flow', kind: 'derived' as const, discipline: 'hydraulic' as const, writable: false, publish: 'telemetry' as const, quantity: 'flowRate' as const, unit: 'kg/s' as const, initialValue: 0 },
      { path: 'temperatureC', label: 'Temperature', kind: 'derived' as const, discipline: 'thermal' as const, writable: false, publish: 'telemetry' as const, quantity: 'temperature' as const, unit: 'degC' as const, initialValue: 20 },
    ] as never,
  }
  const tank = { nominalInventoryKg: 1000, initialInventoryFraction: 0.5, initialTemperatureC: 20, makeupFlowKgPerS: 0, maxOutletFlowKgPerS: 50 }
  const skid = compilePlantGraph(plantGraph({
    id: 'skid',
    title: 'Cooling skid',
    fixedStepMs: 100,
    components: [
      component('basin', 'processTank', 'Basin', tank, [], { presentation: { shortLabel: 'Basin' } }),
      component('pumpN', 'centrifugalPump', 'Pump North', { nominalFlowKgPerS: 40, nominalHeadPa: 2e5 }, [], { loopId: 'N', ordinal: 0, presentation: { shortLabel: 'P-N' } }),
      component('pumpS', 'centrifugalPump', 'Pump South', { nominalFlowKgPerS: 40, nominalHeadPa: 2e5 }, [], { loopId: 'S', ordinal: 1, presentation: { shortLabel: 'P-S' } }),
      component('collector', 'processHeader', 'Collector', {}, [], { presentation: { shortLabel: 'Collector' } }),
      component('checkN', 'processValve', 'Check North', { valveMode: 'check' }, [], { loopId: 'N', ordinal: 0, presentation: { shortLabel: 'CV-N' } }),
      component('checkS', 'processValve', 'Check South', { valveMode: 'check' }, [], { loopId: 'S', ordinal: 1, presentation: { shortLabel: 'CV-S' } }),
      component('cooler', 'processTank', 'Cooler', tank, [], { presentation: { shortLabel: 'Cooler' } }),
    ],
    connections: [
      connect('basin-to-pump-n', 'basin.outlet', 'pumpN.inlet', water),
      connect('basin-to-pump-s', 'basin.outlet', 'pumpS.inlet', water),
      connect('pump-n-to-check', 'pumpN.outlet', 'checkN.inlet', water),
      connect('pump-s-to-check', 'pumpS.outlet', 'checkS.inlet', water),
      connect('check-n-to-collector', 'checkN.outlet', 'collector.inletA', water),
      connect('check-s-to-collector', 'checkS.outlet', 'collector.inletB', water),
      connect('collector-to-cooler', 'collector.outletA', 'cooler.inlet', water),
    ],
  }), processPlantComponentRegistry)

  test('routes, loops and stubs need nothing from the reference model', () => {
    expect(drawn(skid, { from: ['Basin'], to: ['Cooler'] }).labels).toEqual(['Basin', 'CV-N', 'CV-S', 'Collector', 'Cooler', 'P-N', 'P-S'])
    const north = drawn(skid, { services: ['coolant'], loops: ['N'] })
    expect(north.labels).toEqual(['Basin', 'CV-N', 'Collector', 'Cooler', 'P-N'])
    expect(north.stubs.map(stub => `${label(skid, stub.component)}: ${stubText(skid, stub)}`)).toEqual(['Basin: to P-S'])
  })

  test('a link is rated by the pump driving it, through the check valve and collector', () => {
    const collectorToCooler = skid.links.find(link => String(link.id) === 'collector-to-cooler')!
    expect(linkFlowBinding(skid, collectorToCooler.index).noFlowBelow).toBeCloseTo(40 * NO_FLOW_FRACTION, 9)
  })
})

describe('mimic presentation and bindings', () => {
  test('every component kind is drawn by an OpenBridge component, or says why not', () => {
    expect(unpresentedKinds(processPlantComponentRegistry.keys())).toEqual([])
  })

  test('state comes from solved signals; the PORV, whose position is not solved, is judged by its relief flow', () => {
    const framed = framingRules(plant)
    const pzr = graph.componentIndexById.get('pressurizer' as never)!
    const porv = itemBinding(plant, { kind: 'device', component: pzr, device: 'reliefValve' }, 'position', framed)
    expect(porv.label).toBe('PORV')
    expect(porv.state).toEqual({
      aspect: 'position',
      command: 'pressurizer.reliefValvePositionFraction' as never,
      throughput: { path: 'pressurizer.reliefFlowKgPerS' as never, noFlowBelow: graph.components[pzr]!.semantics.ratedOutflow[0]!.flowKgPerS * NO_FLOW_FRACTION },
    })
    expect(porv.frames).toEqual([{ ruleId: 'pzr-relief-flow-high', flap: 'F HI' }])
    for (const component of graph.components) {
      for (const aspect of component.semantics.aspects) {
        if (aspect.state !== undefined) expect(graph.signalBindingByPath.get(aspect.state.path)!.writable && graph.signalBindingByPath.get(aspect.state.path)!.actuation !== 'boundary').toBe(false)
      }
    }
  })

  test('flaps say what a rule watches: the drawn level by its limit, other signals by their letter, a run command as NOT RUN', () => {
    const framed = framingRules(plant)
    const flaps = (id: string, aspect: 'level' | 'running') => Object.fromEntries(itemBinding(plant, { kind: 'component', component: graph.componentIndexById.get(id as never)! }, aspect, framed).frames.map(frame => [frame.ruleId, frame.flap]))
    expect(flaps('pressurizer', 'level')).toMatchObject({ 'pzr-pressure-low': 'P LO', 'pzr-pressure-low-reactor-trip': 'P LO-LO', 'pzr-level-low': 'LO' })
    expect(flaps('sgB', 'level')).toMatchObject({ 'sg-b-level-low': 'LO', 'sg-b-level-low-low-afw-actuation': 'LO-LO', 'sg-b-pressure-high': 'P HI', 'sg-b-feedwater-low': 'LO & F LO' })
    expect(flaps('rcpA', 'running')).toMatchObject({ 'rcp-a-trip': 'NOT RUN', 'rcp-a-loop-flow-low': 'F LO' })
    // A vote across loops frames no single pump; it leads the banner.
    const voted = plant.automation.rules.filter(rule => rule.condition.type === 'vote').map(rule => rule.id)
    expect(voted.length).toBeGreaterThan(0)
    expect([...framed.values()].flat().some(rule => voted.includes(rule.id))).toBe(false)
  })

  test('pipes draw only flows the runtime solves, against their rated flow', () => {
    const link = (id: string) => graph.links.find(candidate => String(candidate.id) === id)!.index
    expect(linkFlowBinding(graph, link('pressurizer-surge-line')).fidelity).toBe('unverified')
    expect(linkFlowBinding(graph, link('rcs-hot-leg-a'))).toMatchObject({ fidelity: 'magnitudeOnly', noFlowBelow: 4250 * NO_FLOW_FRACTION })
  })
})
