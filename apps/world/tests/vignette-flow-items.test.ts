import { describe, expect, test } from 'bun:test'
import type { ObjectId } from '../src/core/model/index.ts'
import type { Observation } from '../src/core/observation/model.ts'
import type { AlertRow } from '../src/features/displays/alerts/rows.ts'
import type { VignetteSection } from '../src/features/displays/compose/model.ts'
import { FLOW_ROOM, overviewOf, scopeWithin, topologySection } from '../src/features/displays/compose/topology.ts'
import { flowLayout } from '../src/features/displays/topology/flow-sizing.ts'
import type { TopologyRequest } from '../src/features/displays/topology/scope.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { servedPlantTopology } from '../src/packs/process-plant/observation/topology.ts'
import { flowDrawing } from '../src/ui/embed/vignette/flow-symbols.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// W6.1's data (plan v5 contract 3; owner 5, F14, F15, #17-#19, U-17): every named item of a flow drawing says what a
// press on it opens (an item its element, a group its members, a stop the equipment it names; nothing where it
// carries no element), the box its symbol and text cover, and its outline: abnormal where it does not follow a
// command, expected where every active alert on it is expected after a first-out (W2.3), none where a frame says more.

type Topology = Extract<VignetteSection, { kind: 'topology' }>
const objectId = 'plant:items' as ObjectId
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: objectId, loopCount: 4 }))
const graph = servedPlantTopology(objectId, plant)
const declaration = plantDeclaration(objectId, plant, null)
const declared = new Map(declaration.observables.map(observable => [observable.ref, observable]))
const elements = new Set(declaration.elements.map(element => element.id))
const sectionOf = (request: TopologyRequest | 'overview'): Topology => {
  const scoped = request === 'overview' ? overviewOf(graph)! : (() => { const result = scopeWithin(graph, request); if (!result.ok) throw new Error(result.reason); return result.scoped })()
  return topologySection(objectId, 'process-plant', scoped, flowLayout(scoped, FLOW_ROOM)!, 38, ref => declared.get(ref)) as Topology
}
const at = '2026-10-22T12:00:00.000Z'
const row = (element: string, priority: 'alarm' | 'warning', expected: boolean): AlertRow => ({
  key: `${objectId}|${element}|${priority}`, objectId, objectLabel: 'Unit', packId: 'process-plant', categoryId: 'unit', group: { objectId }, priority, state: 'active-unack', raised: null,
  alert: { id: `${element}-${priority}`, kind: 'alarm', severity: priority === 'alarm' ? 'critical' : 'warning', message: 'm', raisedAt: at, acknowledged: false, priority, subject: { element } },
  ...(expected ? { expected: { after: 'RX TRIP' } } : {}),
}) as never

describe('what a press on a drawn item opens (W6.1)', () => {
  test('on the overview and the neighbourhoods element defaults draw: every named item opens a declared element, a group its members, a stop what it names', () => {
    for (const request of ['overview', { around: ['sgA'], reach: 1 }, { around: ['pressurizer'], reach: 1 }, { around: ['safetyBusA'], reach: 2 }, { around: ['offsiteBreakerA'], reach: 1 }] as const) {
      const section = sectionOf(request)
      const drawing = flowDrawing(section, [], [], false)
      const named = section.layout.nodes.filter(node => node.text !== undefined).map(node => node.id).sort()
      expect(drawing.texts.map(text => text.id).sort()).toEqual(named)
      for (const text of drawing.texts) {
        const node = section.layout.nodes.find(entry => entry.id === text.id)!
        const view = section.nodes.find(entry => entry.id === text.id)!
        // Every item of the Plant carries an element; each opens a declared element, whose default composes (vignette-element-defaults).
        expect(text.targets.length).toBeGreaterThan(0)
        expect(text.targets.filter(target => !elements.has(target.element))).toEqual([])
        if (view.class === 'stop') expect([text.kind, text.targets.map(target => target.element)]).toEqual(['stop', view.stop!.far.flatMap(end => end.element ?? [])])
        else if (node.members !== undefined) expect([text.kind, text.targets.map(target => target.element)]).toEqual(['group', node.members.flatMap(member => section.nodes.find(entry => entry.id === member)!.element ?? [])])
        else expect([text.kind, text.targets]).toEqual(['item', [{ element: view.element!, label: view.label }]])
        // Its area holds its text and its symbol.
        expect(text.area.x <= text.x && text.area.y <= text.y && text.area.x + text.area.width >= text.x + text.width).toBe(true)
      }
    }
    // The overview's stops each open the equipment they name; its groups their members; the bundled PORV its own element.
    const overview = flowDrawing(sectionOf('overview'), [], [], false)
    expect(overview.texts.find(text => text.lines[0]!.text === 'ACC check valve ×4 +4 more')!.targets.map(target => target.element)).toEqual([
      'safetyAccumulatorA.checkValve', 'safetyAccumulatorB.checkValve', 'safetyAccumulatorC.checkValve', 'safetyAccumulatorD.checkValve', 'chargingPump', 'chargingPumpB', 'rhrIsolationValve', 'safetyInjectionHeader',
    ])
    expect(overview.texts.find(text => text.lines[0]!.text === 'MFW A/B')!.targets.map(target => target.element)).toEqual(['mainFeedwaterPumpA', 'mainFeedwaterPumpB'])
    expect(flowDrawing(sectionOf({ around: ['pressurizer'], reach: 1 }), [], [], false).texts.find(text => text.id === 'pressurizer.blockValve')?.targets).toEqual([{ element: 'pressurizer.blockValve', label: 'PORV block' }])
  })

  test('an item no element is declared for opens nothing', () => {
    const section = sectionOf({ around: ['sgA'], reach: 1 })
    const bare: Topology = { ...section, nodes: section.nodes.map(node => (node.id === 'sgA' ? { id: node.id, class: node.class, label: node.label, bindings: node.bindings } : node)) }
    expect(flowDrawing(bare, [], [], false).texts.find(text => text.id === 'sgA')!.targets).toEqual([])
  })
})

describe('an item\'s outline', () => {
  const section = sectionOf('overview')
  const outline = (rows: ReadonlyArray<AlertRow>, observations: ReadonlyArray<Observation> = []) => {
    const drawing = flowDrawing(section, observations, rows, false)
    return (id: string) => { const text = drawing.texts.find(entry => entry.id === id)!; return [text.tone, text.outline] }
  }
  test('alerts all expected after a first-out: a neutral dashed outline, no frame (W2.3); one unexpected among them frames it', () => {
    expect(outline([row('sgA', 'alarm', true), row('sgA', 'warning', true)])('sgA')).toEqual([null, 'expected'])
    expect(outline([row('sgA', 'alarm', true), row('sgA', 'warning', false)])('sgA')).toEqual(['warning', null])
    expect(outline([])('sgA')).toEqual([null, null])
  })
  test('a command not followed: abnormal, before expected; a frame says more than either', () => {
    const rcp = section.nodes.find(node => node.id === 'rcpA')!.bindings.find(binding => binding.role === 'running')!
    const stopped: Observation = { ref: rcp.ref, at, clock: 'simulation', value: 'off', quality: 'good', priority: 'none', why: 'CMD RUN' }
    expect(outline([row('rcpA', 'warning', true)], [stopped])('rcpA')).toEqual([null, 'abnormal'])
    expect(outline([row('rcpA', 'alarm', false)], [stopped])('rcpA')).toEqual(['alarm', null])
  })
})
