import { expect, test } from 'bun:test'
import type { PhysicalMesh } from '../src/ui/map/physical-scene/geometry.ts'
import { physicalRenderMeshRanges, preparePhysicalRenderBuffers } from '../src/ui/map/physical-scene/render-buffers.ts'
import { physicalVisibleElements, updatePhysicalOpaqueRunMask } from '../src/ui/map/physical-scene/visible-elements.ts'

const mesh = (id: string, triangles: number, segments: number): PhysicalMesh => ({
  object: { id, label: id, kind: 'equipment', levelId: 'floor', positions: [], subjectIds: [] }, offset: [0, 0, 0],
  vertices: new Float64Array(triangles * 3 * 7).map((_, at) => at % 7 === 6 ? 0 : at + 1),
  lines: new Float64Array(segments * 6).map((_, at) => at + 1),
})
const rowsFor = (instances: ReadonlyArray<ReadonlyArray<number>>): Float32Array => {
  const rows = new Float32Array(instances.reduce((count, list) => count + list.length * 12, 0))
  instances.forEach((list, instance) => list.forEach((alpha, object) => { rows[(instance * list.length + object) * 12 + 7] = alpha }))
  return rows
}

test('every subset selects original independent solid/line ranges, preserving all packed attributes and order', () => {
  // Duplicate occurrence IDs deliberately do not identify prepared ordinals.
  // A zero-solid mesh still contributes its authored native line.
  const meshes = [mesh('same', 2, 1), mesh('same', 1, 0), mesh('line-only', 0, 2)], ranges = physicalRenderMeshRanges(meshes), buffers = preparePhysicalRenderBuffers(meshes)
  expect([...ranges]).toEqual([0, 6, 0, 2, 6, 3, 2, 0, 9, 0, 2, 4])
  for (let subset = 0; subset < 8; subset++) {
    const mask = Uint8Array.from(meshes, (_, at) => Number(Boolean(subset & 1 << at))), elements = physicalVisibleElements(ranges, mask)
    for (const [values, indices, stride, ownerAt] of [[buffers.vertices, elements.solid, 8, 7], [buffers.lines, elements.lines, 6, 4]] as const) {
      const expected = [] as number[], actual = [] as number[]
      for (let at = 0; at < values.length; at += stride) if (mask[values[at + ownerAt]!]) expected.push(...values.subarray(at, at + stride))
      for (const index of indices) actual.push(...values.subarray(index * stride, (index + 1) * stride))
      expect(actual).toEqual(expected)
      expect([...indices]).toEqual([...indices].sort((a, b) => a - b))
    }
    expect(elements.solid.length % 3).toBe(0); expect(elements.lines.length % 2).toBe(0)
  }
})

test('union uses actual Float32 shader alpha and retains differing instance masks without regrouping', () => {
  const nearOne = 1 - Number.EPSILON / 2, nearZero = Number.MIN_VALUE, instances = [[0, nearOne, .5, nearZero, 1], [1, 0, .25, 0, 0]], rows = rowsFor(instances), mask = new Uint8Array(5)
  expect(rows[19]).toBe(1); expect(rows[43]).toBe(0)
  expect(updatePhysicalOpaqueRunMask(rows, 5, 0, 2, mask)).toBe(true)
  expect([...mask]).toEqual([1, 1, 0, 0, 1]); expect(updatePhysicalOpaqueRunMask(rows, 5, 0, 2, mask)).toBe(false)
  for (let object = 0; object < 5; object++) expect(Boolean(mask[object])).toBe(instances.some((_, instance) => !(rows[(instance * 5 + object) * 12 + 7]! <= 0 || rows[(instance * 5 + object) * 12 + 7]! < 1)))
  expect(updatePhysicalOpaqueRunMask(rows, 5, 1, 1, mask)).toBe(true); expect([...mask]).toEqual([1, 0, 0, 0, 0])
  rows[67] = 0; expect(updatePhysicalOpaqueRunMask(rows, 5, 1, 1, mask)).toBe(true); expect([...mask]).toEqual([0, 0, 0, 0, 0])
})

test('only the current original run contributes to union; no A1/B/A2 regrouping', () => {
  const rows = rowsFor([[1, 0, .5], [0, 1, 0]]), first = new Uint8Array(3), last = new Uint8Array(3)
  updatePhysicalOpaqueRunMask(rows, 3, 0, 1, first); updatePhysicalOpaqueRunMask(rows, 3, 1, 1, last)
  expect([...first]).toEqual([1, 0, 0]); expect([...last]).toEqual([0, 1, 0])
  const union = new Uint8Array(3); updatePhysicalOpaqueRunMask(rows, 3, 0, 2, union); expect([...union]).toEqual([1, 1, 0])
})

test('invalid table/range dimensions and nonfinite actual visibility fail explicitly', () => {
  expect(() => updatePhysicalOpaqueRunMask(new Float32Array(12), 1, 0, 2, new Uint8Array(1))).toThrow('instance table')
  expect(() => updatePhysicalOpaqueRunMask(rowsFor([[NaN]]), 1, 0, 1, new Uint8Array(1))).toThrow('finite')
  expect(() => physicalVisibleElements(new Uint32Array(4), new Uint8Array(2))).toThrow('source mesh ordinals')
  expect(() => physicalRenderMeshRanges([{ ...mesh('bad', 1, 0), vertices: new Float64Array(7) }])).toThrow('index address space')
  expect(physicalRenderMeshRanges([]).length).toBe(0)
})
