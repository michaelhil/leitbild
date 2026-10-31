import { expect, test } from 'bun:test'
import type { PhysicalPlanPrimitive, PhysicalSceneObject } from '../src/core/packs/scene.ts'
import { compilePhysicalPlanPaint } from '../src/ui/physical-layout/plan-paint-stream.ts'
import { physicalPlanContinuations } from '../src/ui/physical-layout/plan-continuations.ts'

const shape = (id: string, x: number): PhysicalPlanPrimitive => ({ id, kind: 'path', depiction: 'projection', scopeIds: ['room'], bounds: { min: [x, 0], max: [x + 1, 1] }, commands: [['M', x, 0], ['L', x + 1, 0], ['L', x + 1, 1], ['Z']], fill: 'machine', stroke: 'line', width: .05 })
/** Native Path2D stand-in confined to command-retention tests. Pixel comparison
 * uses actual browser canvases; this test does not claim raster equivalence. */
const group = (primitives: PhysicalPlanPrimitive[], objects: ReadonlyMap<string, PhysicalSceneObject> = new Map()) => {
  const previous = globalThis.Path2D
  class TestPath { addPath() {} }
  globalThis.Path2D = TestPath as unknown as typeof Path2D
  try { return compilePhysicalPlanPaint(primitives, objects, () => new Path2D()) }
  finally { globalThis.Path2D = previous }
}
test('paint streams preserve every source submission including disjoint paths with shared device-pixel coverage', () => {
  expect(group([shape('a', 0), shape('b', 2)])).toHaveLength(2)
  expect(group([shape('a', 0), shape('b', .5)])).toHaveLength(2)
  expect(group([{ ...shape('a', 0), opacity: .5 } as PhysicalPlanPrimitive, { ...shape('b', 2), opacity: .5 } as PhysicalPlanPrimitive])).toHaveLength(2)
  const label: PhysicalPlanPrimitive = { id: 'text', kind: 'text', depiction: 'annotation', scopeIds: ['room'], bounds: { min: [0, 0], max: [1, 1] }, anchor: [.5, .5], text: 'HP', height: .5, rotation: 0, align: 'middle', material: 'line' }
  expect(group([shape('a', 0), label, shape('b', 2)]).map(command => command.kind)).toEqual(['geometry', 'text', 'geometry'])
})
test('paint streams retain operational subjects and cross-floor depiction policies', () => {
  const objects = new Map(['a', 'b'].map(id => [id, { id, label: id, kind: 'equipment', levelId: 'floor', positions: [], subjectIds: [id] } as PhysicalSceneObject]))
  expect(group([{ ...shape('a', 0), occurrenceId: 'a' }, { ...shape('b', 2), occurrenceId: 'b' }], objects)).toHaveLength(2)
  expect(group([{ ...shape('a', 0), depiction: 'above' }, shape('b', 2)])).toHaveLength(2)
})
test('continuations use the union of source envelopes and retain the route direction', () => {
  const boxes = [{ min: [0, 0, 0], max: [4, 4, 4] }, { min: [3, 0, 0], max: [8, 4, 4] }] as const
  expect(physicalPlanContinuations([[-1, 2, 1], [10, 2, 1]], boxes)).toEqual([{ point: [0, 2], outward: [-1, -0] }, { point: [8, 2], outward: [1, 0] }])
  expect(physicalPlanContinuations([[-1, 2, 5], [10, 2, 5]], boxes, { low: 0, high: 4 })).toEqual([])
  expect(physicalPlanContinuations([[1, 2, 1], [3.5, 2, 1], [6, 2, 1]], boxes)).toEqual([])
  expect(physicalPlanContinuations([[-1, 2, 1], [10, 2, 1]], [])).toEqual([])
})
