import { expect, test } from 'bun:test'
import type { PhysicalMesh } from '../src/ui/map/physical-scene/geometry.ts'
import { meshBounds } from '../src/ui/map/physical-scene/geometry.ts'
import { inverse, normalize, rayBox, rayTriangle, subtract, transform, type Vector3 } from '../src/ui/map/physical-scene/math.ts'
import { pickPhysicalMesh, preparePhysicalPickAcceleration, type PhysicalPickEntry } from '../src/ui/map/physical-scene/picking.ts'

const matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1])
const mesh = (id: string, triangles: ReadonlyArray<number>, offset: Vector3 = [0, 0, 0]): PhysicalMesh => {
  const vertices: number[] = []
  for (let at = 0; at < triangles.length; at += 3) vertices.push(...triangles.slice(at, at + 3), 0, 0, 1, 0)
  return { key: id, object: { id, label: id, kind: 'equipment', levelId: 'site', positions: [...triangles], subjectIds: [id] }, vertices, lines: [], bounds: meshBounds(vertices), offset }
}
const plane = (id: string, z: number, offset?: Vector3) => mesh(id, [-0.8, -0.8, z, 0.8, -0.8, z, 0.8, 0.8, z, -0.8, -0.8, z, 0.8, 0.8, z, -0.8, 0.8, z], offset)
/** Frozen reference traversal, confined to tests, including original equal-depth ordering. */
const reference = (entries: ReadonlyArray<PhysicalPickEntry>, point: { x: number; y: number }) => {
  const clip: Vector3 = [point.x / 500 - 1, 1 - point.y / 350, -1]
  let nearest: ReturnType<typeof pickPhysicalMesh> = null
  for (const entry of entries) {
    const inverted = inverse(entry.matrix), origin = transform(inverted, clip), far = transform(inverted, [clip[0], clip[1], 1]), direction = normalize(subtract(far, origin))
    let localNearest = Infinity
    for (const mesh of entry.meshes) {
      const local = subtract(origin, mesh.offset), bounds = rayBox(local, direction, mesh.bounds)
      if (bounds === null || bounds > localNearest) continue
      for (let at = 0; at < mesh.vertices.length; at += 21) {
        const a = mesh.vertices.slice(at, at + 3) as unknown as Vector3, b = mesh.vertices.slice(at + 7, at + 10) as unknown as Vector3, c = mesh.vertices.slice(at + 14, at + 17) as unknown as Vector3, d = rayTriangle(local, direction, a, b, c)
        if (d === null || d >= localNearest) continue
        localNearest = d
        const position: Vector3 = [origin[0] + direction[0] * d, origin[1] + direction[1] * d, origin[2] + direction[2] * d], depth = transform(entry.matrix, position)[2]
        if (!nearest || depth < nearest.depth) nearest = { sceneId: entry.sceneId, mesh, position, depth }
      }
    }
  }
  return nearest
}

test('indexed picks retain occlusion, coplanar order, instance identity and separated offsets', () => {
  const shifted = new Float64Array(matrix); shifted[12] = 0.4
  const entries = [{ sceneId: 'a', matrix, meshes: [plane('wall', 0.4), plane('column', 0.4), plane('hidden-pump', 0)] }, { sceneId: 'b', matrix: shifted, meshes: [plane('higher', 0.5, [0, 0, 0.2])] }]
  expect(pickPhysicalMesh(entries.slice(0, 1), { x: 500, y: 350 }, 1000, 700)?.mesh.object.id).toBe('wall')
  for (let y = -50; y <= 750; y += 20) for (let x = -50; x <= 1050; x += 20) {
    const actual = pickPhysicalMesh(entries, { x, y }, 1000, 700), expected = reference(entries, { x, y })
    expect(actual?.sceneId).toBe(expected?.sceneId); expect(actual?.mesh.object.id).toBe(expected?.mesh.object.id); expect(actual?.depth).toBe(expected?.depth)
  }
})

test('SAH hierarchy preserves exact winners on long, dense and degenerate geometry without candidate truncation', () => {
  const triangles: number[] = []
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    const px = x / 12 - 1, py = y / 12 - 1, z = (x + y) / 200
    triangles.push(px, py, z, px + 0.08, py, z, px, py + 0.08, z)
  }
  triangles.push(0, 0, 0, 0, 0, 0, 0, 0, 0)
  const entries = [{ sceneId: 'grid', matrix, meshes: [mesh('dense', triangles), mesh('long', [-10, -0.01, 0.6, 10, -0.01, 0.6, 0, 0.01, 0.6])] }]
  const prepared = preparePhysicalPickAcceleration(entries[0]!.meshes)
  expect(preparePhysicalPickAcceleration(entries[0]!.meshes)).toBe(prepared)
  expect(prepared.triangles[0]!.triangles.order.length).toBe(577)
  for (let y = 0; y <= 700; y += 25) for (let x = 0; x <= 1000; x += 25) {
    const actual = pickPhysicalMesh(entries, { x, y }, 1000, 700), expected = reference(entries, { x, y })
    expect(actual?.mesh.object.id).toBe(expected?.mesh.object.id); expect(actual?.depth).toBe(expected?.depth)
  }
  expect(pickPhysicalMesh(entries, { x: NaN, y: 1 }, 1000, 700)).toBeNull()
})
