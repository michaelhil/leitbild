import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import type { Observation } from '../src/core/observation/model.ts'
import type { VignetteSection } from '../src/features/displays/compose/model.ts'
import { bindingRefs, FLOW_ROOM, overviewOf, scopeWithin, topologySection } from '../src/features/displays/compose/topology.ts'
import { flowLayout } from '../src/features/displays/topology/flow-sizing.ts'
import type { TopologyRequest } from '../src/features/displays/topology/scope.ts'
import { stopLabel } from '../src/features/displays/topology/stops.ts'
import { commandsForProcessPlantAction, compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { readPlant } from '../src/packs/process-plant/observation/read.ts'
import { servedPlantTopology } from '../src/packs/process-plant/observation/topology.ts'
import { createProcessPlantProtectionRunner, createProcessPlantRuntime } from '../src/packs/process-plant/runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { flowDrawing } from '../src/ui/embed/vignette/flow-symbols.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Where a drawing stops (plan v5 W6.2; #41, #42, U-17; the old mimic-stub-words test, re-expressed for World's
// stops): a stop says "to" or "from" and names what lies beyond, alike names once with how many, never cut; on a
// power line it says the state of the equipment it names, never of the line towards it (HMI review of run 26: "to
// Bus A DEAD" on a loss of offsite power while the diesels held both safety buses), and its pipe draws its lines.

type Topology = Extract<VignetteSection, { kind: 'topology' }>
const objectId = 'plant:stops' as ObjectId
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: objectId, loopCount: 4 }))
const graph = servedPlantTopology(objectId, plant)
const declared = new Map(plantDeclaration(objectId, plant, null).observables.map(observable => [observable.ref, observable]))
const drawn = (request: TopologyRequest | 'overview') => {
  const scoped = request === 'overview' ? overviewOf(graph)! : (() => { const result = scopeWithin(graph, request); if (!result.ok) throw new Error(result.reason); return result.scoped })()
  const layout = flowLayout(scoped, FLOW_ROOM, ref => declared.get(ref))!
  return { scoped, section: topologySection(objectId, 'process-plant', scoped, layout, 38, ref => declared.get(ref)) as Topology }
}

// The Plant run on its own runtime and protection, as a Run does, read as World reads it.
const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const system = { plant, runtime, protection } as unknown as ProcessPlantRuntimeInstance
  const run = (seconds: number): void => {
    for (let second = 0; second < seconds; second += 1) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-stops' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
  }
  const act = (actionId: string): void => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters: {}, graph: plant.graph })) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  }
  const sampled = (scoped: ReturnType<typeof drawn>['scoped']): ReadonlyArray<Observation> => readPlant({ objectId, system, recording: null, simulationTime: '2026-10-22T12:00:00.000Z' as IsoTimestamp, history: undefined },
    bindingRefs(scoped).map(ref => ref.slice(ref.indexOf('#') + 1))).flatMap(observation => observation ?? [])
  return { run, act, sampled, read: (path: string) => runtime.readVariableSnapshot(path as never).value }
}

describe('an overview, worked out once a graph (§5.8)', () => {
  test('the same graph gives the same overview; another graph, even an equal copy, its own, equal', () => {
    const first = overviewOf(graph)
    expect(overviewOf(graph)).toBe(first)
    const copy = structuredClone(graph)
    expect(overviewOf(copy)).not.toBe(first)
    expect(overviewOf(copy)).toEqual({ ...first!, graph: copy })
  })
})

describe('what a stop writes', () => {
  test('"to" or "from" and what lies beyond; alike names once with how many; what its room does not hold counted, never cut', () => {
    expect(stopLabel('in', ['AFW valve A'])).toBe('from AFW valve A')
    expect(stopLabel('out', ['PZR', 'SG B', 'SG C', 'SG D'])).toBe('to PZR, SG B, SG C, SG D')
    expect(stopLabel('in', ['RCP A', 'RCP B', 'RCP C', 'RCP D', 'RCP E'])).toBe('from RCP ×5')
    expect(stopLabel('in', ['ARV B', 'ARV C', 'ARV D', 'MSSV B', 'MSSV C', 'MSSV D'])).toBe('from ARV ×3, MSSV ×3')
    expect(stopLabel('in', ['ACC A check valve', 'ACC B check valve', 'ACC C check valve', 'ACC D check valve', 'CHG A', 'CHG B', 'RHR iso', 'SI header'])).toBe('from ACC check valve ×4 +4 more')
    // A name is never cut, however long; one name the room cannot hold is written whole.
    expect(stopLabel('out', ['A name longer than any room a stop keeps for it'])).toBe('to A name longer than any room a stop keeps for it')
    // Where its drawing has no room for the direction's word, the names alone.
    expect(stopLabel(null, ['AFW valve A'])).toBe('AFW valve A')
  })

  test('each stop names every far end it stands for, and opens them: on the overview and around SG A', () => {
    for (const request of ['overview', { around: ['sgA'], reach: 1 }] as const) {
      const { section } = drawn(request)
      for (const stop of section.nodes.filter(node => node.class === 'stop')) {
        const far = stop.stop!.far.map(end => end.label)
        const counted = /\+(\d+) more$/.exec(stop.label)
        const named = far.filter(name => stop.label.includes(name) || stop.label.includes(name.split(' ').filter(word => !/^([A-Z]|\d+)$/.test(word)).join(' ')))
        // Every far end is named, or stands in an alike group ("SG ×3"), or is counted.
        expect(named.length + Number(counted?.[1] ?? 0)).toBeGreaterThanOrEqual(far.length)
        expect(stop.stop!.far.every(end => end.element !== undefined)).toBe(true)
      }
    }
    // Around SG A the stops say where the lines go to and come from.
    expect(drawn({ around: ['sgA'], reach: 1 }).section.nodes.filter(node => node.class === 'stop').map(node => node.label).sort()).toEqual([
      'from AFW header', 'from ARV ×3, MSSV ×3', 'from MFW header', 'from RCP B, RCP C, RCP D', 'to PZR, SG B, SG C, SG D', 'to Steam header',
    ])
  })
})

describe('a power stop says the state of the equipment it names (the old mimic-stub-words)', () => {
  // Run 26's "why did the turbine trip" drawing: the generator, its transformer and the four breakers it feeds.
  const request: TopologyRequest = { from: ['turbine'], to: ['offsiteBreakerA', 'offsiteBreakerB', 'unitBusBreakerA', 'unitBusBreakerB'] }
  const words = (section: Topology, observations: ReadonlyArray<Observation>) => Object.fromEntries(flowDrawing(section, observations, [], false).texts
    .filter(text => /^s\d+$/.test(text.id)).map(text => [text.lines[0]!.text, text.lines[1]?.text ?? null]))

  test('on a loss of offsite power the diesel-held safety buses read LIVE, while the lines to them through the open offsite breakers are dead', () => {
    const { scoped, section } = drawn(request)
    expect(section.nodes.filter(node => node.class === 'stop').map(node => node.label).sort()).toEqual(['from Grid', 'to Bus A', 'to Bus B', 'to Unit Bus A', 'to Unit Bus B'])
    const plantRun = started()
    plantRun.run(60)
    expect(words(section, plantRun.sampled(scoped))).toEqual({ 'from Grid': 'LIVE', 'to Bus A': 'LIVE', 'to Bus B': 'LIVE', 'to Unit Bus A': 'LIVE', 'to Unit Bus B': 'LIVE' })
    plantRun.act('loss-offsite-power')
    plantRun.run(60)
    // The diesels hold both safety buses at their 6.60 kV; the grid and the unit buses are lost.
    expect(plantRun.read('safetyBusA.voltageKv')).toBeCloseTo(6.6, 1)
    const observations = plantRun.sampled(scoped)
    expect(words(section, observations)).toEqual({ 'from Grid': 'DEAD', 'to Bus A': 'LIVE', 'to Bus B': 'LIVE', 'to Unit Bus A': 'DEAD', 'to Unit Bus B': 'DEAD' })
    // The stop's line is drawn as the line is: dead through the open offsite breaker, the bus beyond it live.
    const busA = section.nodes.find(node => node.label === 'to Bus A')!.id
    const pipe = flowDrawing(section, observations, [], false).segments.filter(segment => 'connectionId' in segment && segment.connectionId === `${busA}.edge`)
    expect(pipe.length).toBeGreaterThan(0)
    expect(pipe.every(segment => segment.value === 'empty')).toBe(true)
  })

  test('a stop naming several: how many are live ("LIVE 1/2"); all, none, or "?" while one is not known; a fluid line\'s stop writes nothing under its name', () => {
    const { section } = drawn({ around: ['offsiteBreakerA'], reach: 1 })
    const several = section.nodes.find(node => node.class === 'stop' && node.stop!.far.length === 3)!
    expect(several.label).toBe('to Offsite BKR B, Unit BKR ×2')
    const at = (values: ReadonlyArray<string | null>): ReadonlyArray<Observation> => several.stop!.far.map((end, index) => {
      const ref = end.bindings[0]!.ref
      return { ref, at: '2026-10-22T12:00:00.000Z', clock: 'simulation', value: values[index] ?? null, quality: values[index] === null ? 'bad' : 'good', priority: 'none' }
    })
    const word = (values: ReadonlyArray<string | null>) => flowDrawing(section, at(values), [], false).texts.find(text => text.id === several.id)!.lines[1]!.text
    const [on, off] = [several.stop!.far[0]!.bindings[0]!.states!.find(state => state.active === true)!.value, several.stop!.far[0]!.bindings[0]!.states!.find(state => state.active !== true)!.value]
    expect([word([on, on, on]), word([off, on, off]), word([off, off, off]), word([on, null, on])]).toEqual(['CLOSED', 'CLOSED 1/3', 'OPEN', '?'])
    // Around SG A, every stop is on a fluid line: one line each, its name.
    expect(flowDrawing(drawn({ around: ['sgA'], reach: 1 }).section, [], [], false).texts.filter(text => /^s\d+$/.test(text.id)).every(text => text.lines.length === 1)).toBe(true)
  })

  test('a stop\'s pipe draws the flow of the lines it stands for: flowing, still, not known', () => {
    const { scoped, section } = drawn({ around: ['sgA'], reach: 1 })
    const plantRun = started()
    plantRun.run(5)
    const observations = plantRun.sampled(scoped)
    const flowing = section.edges.filter(edge => /^s\d+\.edge$/.test(edge.id) && edge.bindings.some(binding => observations.some(observation => observation.ref === binding.ref && typeof observation.value === 'number' && observation.value > 0)))
    expect(flowing.map(edge => section.nodes.find(node => `${node.id}.edge` === edge.id)!.label)).toContain('to PZR, SG B, SG C, SG D')
    const pipe = (edge: string, sample: ReadonlyArray<Observation>) => flowDrawing(section, sample, [], false).segments.filter(segment => 'connectionId' in segment && segment.connectionId === edge)
    for (const edge of flowing) {
      expect(pipe(edge.id, observations).some(segment => segment.value === 'open-flow')).toBe(true)
      expect(pipe(edge.id, observations).some(segment => segment.kind === 'direction')).toBe(true)
      const still = observations.map(observation => (edge.bindings.some(binding => binding.ref === observation.ref) ? { ...observation, value: 0 } : observation))
      expect(pipe(edge.id, still).every(segment => segment.value !== 'open-flow')).toBe(true)
      const unknown = observations.filter(observation => !edge.bindings.some(binding => binding.ref === observation.ref))
      expect(pipe(edge.id, unknown).every(segment => segment.value === 'closed-dash' || segment.kind === 'endpoint')).toBe(true)
    }
  })
})
