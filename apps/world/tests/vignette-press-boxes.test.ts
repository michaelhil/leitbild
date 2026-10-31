import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ObjectId } from '../src/core/model/index.ts'
import type { VignetteSection } from '../src/features/displays/compose/model.ts'
import { FLOW_ROOM, overviewOf, scopeWithin, topologySection } from '../src/features/displays/compose/topology.ts'
import { TOPOLOGY_REACH, type TopologyRequest } from '../src/features/displays/topology/scope.ts'
import { flowLayout } from '../src/features/displays/topology/flow-sizing.ts'

import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { servedPlantTopology } from '../src/packs/process-plant/observation/topology.ts'
import { BAR_PX, flowDrawing, lineHeight, type FlowDrawing } from '../src/ui/embed/vignette/flow-symbols.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A press on a drawn item opens that item (plan v5 §3; eval R3 nav finding 1): on the overview and on the neighbourhood
// every element's default draws, no item's press box (its symbol, a header's or a bus's bar, a stop's box) lies over
// another item's press box or its words. A header's layout box can hold other items' lines (SG A's detail: the MFW
// header's 78 × 298 box over the AFW header's bar), so a header presses only its bar.

type Topology = Extract<VignetteSection, { kind: 'topology' }>
type Box = { readonly id: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
const objectId = 'plant:press' as ObjectId
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: objectId, loopCount: 4 }))
const graph = servedPlantTopology(objectId, plant)
const declared = new Map(plantDeclaration(objectId, plant, null).observables.map(observable => [observable.ref, observable]))
const sectionOf = (request: TopologyRequest | 'overview'): Topology | null => {
  const scoped = request === 'overview' ? overviewOf(graph)! : (() => { const result = scopeWithin(graph, request); return result.ok ? result.scoped : null })()
  if (scoped === null) return null
  const layout = flowLayout(scoped, FLOW_ROOM, ref => declared.get(ref))
  return layout === null ? null : topologySection(objectId, 'process-plant', scoped, layout, 38, ref => declared.get(ref)) as Topology
}
/** The neighbourhoods an element's default may draw (defaults.ts aroundView, compose's fit): around its node, within its group, at each reach. */
const aroundOf = (node: (typeof graph.nodes)[number], reach: number): TopologyRequest => ({ around: [node.id], ...(node.group === undefined ? {} : { groups: [node.group] }), reach })

/** What a press takes on a drawing: a device's two cells, a vessel's box, an item drawn as a line, bar or stop its `press`; and each item's words. */
const pressBoxes = (drawing: FlowDrawing): { readonly presses: ReadonlyArray<Box>; readonly words: ReadonlyArray<Box> } => {
  const symbols = new Set([...drawing.devices, ...drawing.vessels].map(item => item.id))
  return {
    presses: [
      ...drawing.devices.map(device => ({ id: device.id, x: device.x - 24, y: device.y - 24, width: 48, height: 48 })),
      ...drawing.vessels.map(vessel => ({ id: vessel.id, x: vessel.x, y: vessel.y, width: vessel.width, height: vessel.height })),
      ...drawing.texts.filter(text => text.targets.length > 0 && !symbols.has(text.id)).map(text => ({ id: text.id, ...text.press })),
    ],
    words: drawing.texts.map(text => ({ id: text.id, x: text.x, y: text.y, width: text.width, height: text.lines.reduce((sum, line) => sum + lineHeight(line), 0) })),
  }
}
const cut = (a: Box, b: Box): { readonly width: number; readonly height: number } =>
  ({ width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) })
/** Two bars crossing meet in a square no wider than a bar: that is a crossing, not one lying over the other. */
const over = (a: Box, b: Box): boolean => { const both = cut(a, b); return both.width > 0 && both.height > 0 && (both.width > BAR_PX || both.height > BAR_PX) }

describe('a press opens the item pressed (eval R3 nav finding 1)', () => {
  test('on the overview and every element default\'s neighbourhood, no press box lies over another item\'s press box or words', () => {
    const requests: Array<readonly [string, TopologyRequest | 'overview']> = [['overview', 'overview'], ...graph.nodes.filter(node => node.element !== undefined).flatMap(node => Array.from({ length: TOPOLOGY_REACH }, (_, at) => [`${node.id} reach ${at + 1}`, aroundOf(node, at + 1)] as const))]
    const found: string[] = []
    let drawn = 0
    for (const [name, request] of requests) {
      const section = sectionOf(request)
      if (section === null) continue
      drawn += 1
      const { presses, words } = pressBoxes(flowDrawing(section, [], [], false))
      for (const press of presses) {
        for (const other of presses) if (other.id < press.id && over(press, other)) found.push(`${name}: ${press.id} and ${other.id}`)
        for (const word of words) if (word.id !== press.id && cut(press, word).width > 0 && cut(press, word).height > 0) found.push(`${name}: ${press.id} over the words of ${word.id}`)
      }
    }
    expect(drawn).toBeGreaterThan(100)
    expect(found).toEqual([])
  }, 300_000)

  test('a header\'s or a bus\'s press is its bar along the middle of its box; the drawing\'s button takes it', () => {
    // SG A's detail as the eval found it: the MFW header's box held the AFW header's bar.
    const detail = sectionOf(aroundOf(graph.nodes.find(node => node.element === 'sgA')!, TOPOLOGY_REACH))!
    const drawing = flowDrawing(detail, [], [], false)
    const headers = drawing.texts.filter(text => text.press.width === BAR_PX || text.press.height === BAR_PX)
    expect(headers.length).toBeGreaterThan(0)
    for (const header of headers) expect(header.press.width * header.press.height).toBeLessThan(header.area.width * header.area.height)
    const flow = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/FlowTopology.svelte'), 'utf8')
    expect(flow).toContain('style:left={`${text.press.x}px`} style:top={`${text.press.y}px`} style:width={`${text.press.width}px`} style:height={`${text.press.height}px`}')
  })
})
