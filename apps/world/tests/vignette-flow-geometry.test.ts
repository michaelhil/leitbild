import { describe, expect, test } from 'bun:test'
import type { Segment } from '@oicl/connector-diagram'
import type { ObjectId } from '../src/core/model/index.ts'
import type { VignetteSection } from '../src/features/displays/compose/model.ts'
import { FLOW_ROOM, overviewOf, scopeWithin, topologySection } from '../src/features/displays/compose/topology.ts'
import { flowLayout } from '../src/features/displays/topology/flow-sizing.ts'
import type { TopologyRequest } from '../src/features/displays/topology/scope.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { servedPlantTopology } from '../src/packs/process-plant/observation/topology.ts'
import { FLOW_TEXT } from '../src/features/displays/topology/text.ts'
import { flowDrawing } from '../src/ui/embed/vignette/flow-symbols.ts'
import { STUB_STRAIGHT } from '../src/ui/embed/vignette/pipe-segments.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// The flow drawing's geometry as a person sees it (plan v5 §5.5 "Overlap"; W6.3, W6.5): on the four-loop overview and
// the neighbourhoods the element defaults draw, every pipe that stops ends on a straight of at least 16 px, every flow
// chevron stands on a run, clear of the drawing's text and symbols, and no text stands on a pipe, a symbol or other
// text.

type Topology = Extract<VignetteSection, { kind: 'topology' }>
const objectId = 'plant:geometry' as ObjectId
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: objectId, loopCount: 4 }))
const graph = servedPlantTopology(objectId, plant)
const declaration = plantDeclaration(objectId, plant, null)
const declared = new Map(declaration.observables.map(observable => [observable.ref, observable]))
const sectionOf = (request: TopologyRequest | 'overview'): Topology => {
  const scoped = request === 'overview' ? overviewOf(graph)! : (() => { const result = scopeWithin(graph, request); if (!result.ok) throw new Error(result.reason); return result.scoped })()
  return topologySection(objectId, 'process-plant', scoped, flowLayout(scoped, FLOW_ROOM, ref => declared.get(ref))!, 38, ref => declared.get(ref)) as Topology
}
const REQUESTS = ['overview', { around: ['sgA'], reach: 1 }, { around: ['pressurizer'], reach: 1 }, { around: ['condenser'], reach: 1 }, { around: ['turbine'], reach: 1 }] as const
// Every flow bound and flowing, so each bound pipe carries its chevron.
const flowing = (section: Topology) => section.edges.flatMap(edge => edge.bindings.filter(binding => binding.role === 'flow')).map(binding => ({ ref: binding.ref, value: 10, quality: 'good', at: '2026-10-23T12:00:00.000Z' }) as never)
type Straight = Extract<Segment, { kind: 'straight' }>

describe('pipe ends (W6.3, owner finding 4, U-18)', () => {
  test(`every pipe that stops ends on a straight of at least ${STUB_STRAIGHT} px: no cap or arrow in a bend`, () => {
    for (const request of REQUESTS) {
      const section = sectionOf(request)
      const { segments } = flowDrawing(section, flowing(section), [], false)
      const ends = segments.filter(segment => segment.kind === 'endpoint' || segment.kind === 'arrow')
      expect(ends.length).toBeGreaterThan(0)
      const short = ends.flatMap(end => {
        const pipe = segments.filter((segment): segment is Straight => segment.kind === 'straight' && `${segment.connectionId}:end` === end.connectionId)
        const last = pipe.find(piece => (piece.x2 === end.x && piece.y2 === end.y) || (piece.x1 === end.x && piece.y1 === end.y))
        const corners = segments.filter(segment => segment.kind === 'corner' && `${segment.connectionId}:end` === end.connectionId)
        // A pipe that is one short straight and nothing else is as long as its layout made it.
        if (last !== undefined && pipe.length === 1 && corners.length === 0) return []
        const length = last === undefined ? 0 : Math.abs(last.x2 - last.x1) + Math.abs(last.y2 - last.y1)
        return length >= STUB_STRAIGHT ? [] : [`${JSON.stringify(request)} ${end.connectionId} ${length}`]
      })
      expect(short).toEqual([])
    }
  })

  test('every flow chevron stands on a straight run, clear of the text and the symbols drawn', () => {
    for (const request of REQUESTS) {
      const section = sectionOf(request)
      const drawing = flowDrawing(section, flowing(section), [], false)
      const chevrons = drawing.segments.filter(segment => segment.kind === 'direction')
      expect(chevrons.length).toBeGreaterThan(0)
      const boxes = [
        ...drawing.texts.map(text => ({ x: text.x, y: text.y, width: text.width, height: text.lines.reduce((sum, line) => sum + FLOW_TEXT[line.style].line, 0) })),
        ...drawing.devices.map(device => ({ x: device.x - 24, y: device.y - 24, width: 48, height: 48 })),
        ...drawing.vessels,
      ]
      const against = chevrons.filter(chevron => chevron.kind === 'direction' && boxes.some(box => chevron.x > box.x - 4 && chevron.x < box.x + box.width + 4 && chevron.y > box.y - 4 && chevron.y < box.y + box.height + 4))
      expect(against).toEqual([])
    }
  })
})

describe('text (W6.5): clear of pipes, symbols and other text', () => {
  type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  const meets = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  test('on the overview at two to four loops and the neighbourhoods element defaults draw, every text block keeps off every pipe, symbol and other text', () => {
    const cases: Array<readonly [string, Topology]> = REQUESTS.map(request => [JSON.stringify(request), sectionOf(request)] as const)
    for (const loops of [2, 3]) {
      const id = `plant:geometry-${loops}` as ObjectId
      const model = compileProcessPlant(createPwrReferencePlantDefinition({ id, loopCount: loops }))
      const known = new Map(plantDeclaration(id, model, null).observables.map(observable => [observable.ref, observable]))
      const scoped = overviewOf(servedPlantTopology(id, model))!
      cases.push([`overview ${loops} loops`, topologySection(id, 'process-plant', scoped, flowLayout(scoped, FLOW_ROOM, ref => known.get(ref))!, 38, ref => known.get(ref)) as Topology])
    }
    for (const [name, section] of cases) {
      const drawing = flowDrawing(section, flowing(section), [], false)
      // Each text block at its lines' height; the symbols at their drawn boxes (a device its two cells round its centre).
      const texts = drawing.texts.map(text => ({ id: text.id, x: text.x, y: text.y, width: text.width, height: text.lines.reduce((sum, line) => sum + FLOW_TEXT[line.style].line, 0) }))
      const symbols = [...drawing.devices.map(device => ({ id: device.id, x: device.x - 24, y: device.y - 24, width: 48, height: 48 })), ...drawing.vessels]
      // A pipe as the band its outline takes (6 px wide).
      const pipes = drawing.segments.flatMap(segment => (segment.kind !== 'straight' ? []
        : [{ id: segment.connectionId, x: Math.min(segment.x1, segment.x2) - 3, y: Math.min(segment.y1, segment.y2) - 3, width: Math.abs(segment.x2 - segment.x1) + 6, height: Math.abs(segment.y2 - segment.y1) + 6 }]))
      const against = texts.flatMap(text => [
        ...pipes.filter(pipe => meets(text, pipe)).map(pipe => `${name}: ${text.id} on pipe ${pipe.id}`),
        ...symbols.filter(symbol => symbol.id !== text.id && meets(text, symbol)).map(symbol => `${name}: ${text.id} on ${symbol.id}`),
        ...texts.filter(other => other.id < text.id && meets(text, other)).map(other => `${name}: ${text.id} on ${other.id}'s text`),
      ])
      expect(against).toEqual([])
    }
  })
})
