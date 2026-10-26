import { expect, test } from 'bun:test'
import { visiblePhysicalInspectionBoundaries } from '../src/ui/map/physical-scene/inspection-cutaway.ts'
import { multiply, normalize, cross, dot, subtract, type Vector3 } from '../src/ui/map/physical-scene/math.ts'
import type { PhysicalMesh } from '../src/ui/map/physical-scene/geometry.ts'

const mesh = (part: 'full' | 'cut', normal: [number, number, 0]): PhysicalMesh => ({ key: `wall/${part}`, inspectionPart: part, object: { id: 'wall', label: 'Wall', kind: 'wall', levelId: 'floor', positions: [], subjectIds: [], bounds: { min: [43.8, -25.6, 0], max: [44.2, 10.4, 31.2] }, inspectionBoundary: { outward: normal } }, vertices: new Float64Array(), lines: new Float64Array(), lineMaterials: [], lineStyles: [], bounds: { min: [43.8, -25.6, 0], max: [44.2, 10.4, 31.2] }, offset: [0, 0, 0], levelId: 'floor' })
const camera = (eye: Vector3, target: Vector3, fov = .8, padding: [number, number] = [0, 0], orthographic = false) => {
  const back = normalize(subtract(eye, target)), right = normalize(cross([0, 0, 1], back)), up = cross(back, right)
  const view = new Float64Array([right[0], up[0], back[0], 0, right[1], up[1], back[1], 0, right[2], up[2], back[2], 0, -dot(right, eye), -dot(up, eye), -dot(back, eye), 1])
  const f = 1 / Math.tan(fov / 2), near = .1, far = 1000
  const projection = orthographic ? new Float64Array([.01, 0, 0, 0, 0, .01, 0, 0, 0, 0, -2 / (far - near), 0, padding[0], padding[1], -(far + near) / (far - near), 1]) : new Float64Array([f, 0, 0, 0, 0, f, 0, 0, padding[0], padding[1], (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0])
  return multiply(projection, view)
}
test('foreground enclosure direction stays cut when an elevated close camera is inside the wall plane', () => {
  const meshes = [mesh('full', [1, 0, 0]), mesh('cut', [1, 0, 0])]
  for (const eye of [[43.1, -99.6, 101.3], [20, -60, 80], [4, -12, 28]] as Vector3[]) expect(visiblePhysicalInspectionBoundaries(meshes, camera(eye, [0, -7.6, 15]))[0]!.inspectionPart).toBe('cut')
  expect(visiblePhysicalInspectionBoundaries(meshes, camera([-60, -60, 80], [0, -7.6, 15]))[0]!.inspectionPart).toBe('full')
})
test('pan, zoom and off-axis padding preserve the same foreground sides without rebuilding meshes', () => {
  const meshes = [mesh('full', [0, -1, 0]), mesh('cut', [0, -1, 0])], baseline = visiblePhysicalInspectionBoundaries(meshes, camera([40, -100, 90], [0, 0, 15]))
  for (const transform of [camera([340, 600, 290], [300, 700, 215]), camera([80, -200, 165], [0, 0, 15]), camera([40, -100, 90], [0, 0, 15], .35), camera([40, -100, 90], [0, 0, 15], .8, [.6, -.4])]) expect(visiblePhysicalInspectionBoundaries(meshes, transform)).toBe(baseline)
})
test('perspective and orthographic use the same architectural foreground orientation', () => {
  for (const normal of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]] as [number, number, 0][]) {
    const meshes = [mesh('full', normal), mesh('cut', normal)]
    const perspective = visiblePhysicalInspectionBoundaries(meshes, camera([40, -100, 90], [0, 0, 15]))
    expect(visiblePhysicalInspectionBoundaries(meshes, camera([40, -100, 90], [0, 0, 15], .8, [0, 0], true))).toBe(perspective)
  }
})
