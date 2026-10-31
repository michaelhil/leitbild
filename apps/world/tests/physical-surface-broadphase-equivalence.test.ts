import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { buildVisibleMeshes, meshBounds, type PhysicalMesh } from '../src/ui/map/physical-scene/geometry.ts'
import { preparePhysicalSurfaceOwnership as current, visiblePhysicalSurfaceOwners } from '../src/ui/map/physical-scene/surface-ownership.ts'
import { preparePhysicalSurfaceOwnership as before } from './fixtures/physical-layout/surface-ownership-before-two-level.ts'
import { preparePhysicalPickAcceleration } from '../src/ui/map/physical-scene/picking.ts'
import { preparePhysicalRenderBuffers } from '../src/ui/map/physical-scene/render-buffers.ts'
import type { PackPhysicalScene } from '../src/core/packs/scene.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'

const fingerprint = (owned: ReturnType<typeof current>): string => {
  const hash = createHash('sha256'), binary = (values: ArrayBufferView) => hash.update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength))
  for (const { object, vertices, lines, ...metadata } of owned.meshes) { hash.update(JSON.stringify([object.id, metadata])); binary(Float64Array.from(vertices)); binary(Float64Array.from(lines)) }
  const buffers = preparePhysicalRenderBuffers(owned.meshes); binary(buffers.vertices); binary(buffers.lines); hash.update(JSON.stringify([buffers.roles, buffers.objectCount]))
  const pick = preparePhysicalPickAcceleration(owned.meshes)
  for (const index of [pick.meshes, ...pick.triangles.map(item => item.triangles)]) for (const values of [index.bounds, index.children, index.ranges, index.order]) binary(values)
  const { broadPhaseCandidates: _work, ...truth } = owned.diagnostics; hash.update(JSON.stringify(truth)); return hash.digest('hex')
}
const compare = (meshes: readonly PhysicalMesh[]) => {
  const a = before(meshes), b = current(meshes)
  expect(fingerprint(b)).toBe(fingerprint(a))
  for (let at = 0; at < meshes.length; at++) {
    const masked = (value: ReturnType<typeof current>) => visiblePhysicalSurfaceOwners(value.meshes.filter(mesh => mesh.object.id !== meshes[at]!.object.id))
    expect(masked(b).map(mesh => [mesh.key, mesh.occludedBy])).toEqual(masked(a).map(mesh => [mesh.key, mesh.occludedBy]))
  }
}
const mesh = (id: string, xy: readonly number[], z = 0): PhysicalMesh => {
  const vertices = Float64Array.from(xy.flatMap((value, at) => at % 2 ? [] : [value, xy[at + 1]!, z, -0, 0, 1, at % 3]))
  return { key: id, object: { id, label: id, kind: 'equipment', levelId: 'site', positions: [], subjectIds: [id], materials: ['equipment', 'metal', 'line'] }, vertices, lines: new Float64Array([0, 0, z, 4, 0, z]), lineMaterials: ['line'], lineStyles: ['feature'], levelId: 'site', offset: [0, 0, 0], bounds: meshBounds(vertices) }
}
const quad = (id: string, x: number, y: number, width: number, height: number, z = 0) => mesh(id, [x,y,x+width,y,x+width,y+height,x,y,x+width,y+height,x,y+height], z)

test('mesh hierarchy keeps earlier self faces, same occurrence alternatives, material order and stale declared bounds', () => {
  const a = quad('first', 0, 0, 4, 4), b = quad('later', 1, -1, 1, 6)
  const self = { ...a, key: 'self', vertices: Float64Array.from([...a.vertices, ...b.vertices]) }
  const full = { ...a, key: 'full', inspectionPart: 'full' as const }, cut = { ...b, key: 'cut', object: a.object, inspectionPart: 'cut' as const }
  compare([self]); compare([full, cut]); compare([cut, full])
  compare([a, { ...b, bounds: { min: [1e9,1e9,1e9], max: [1e9+1,1e9+1,1e9+1] } }])
  compare([a, { ...b, offset: [0,0,1] }, { ...b, key: 'other-band', planPriority: 1 }])
})

test('zero-thickness meshes, degenerate faces and high-magnitude nearby planes preserve exact ownership', () => {
  compare([quad('a', 0, 0, 4, 4), mesh('degenerate', [0,0,1,0,2,0]), quad('b', 1, 1, 4, 4)])
  for (const z of [0, 1e-8, 1e8]) compare([quad('a', 1e8, 1e8, 4, 4, z), quad('b', 1e8+1, 1e8-1, 1, 6, z), quad('separate', 1e8+2, 1e8, 2, 2, z+1e-7)])
})

test('dense and spatially separated source meshes retain exact render and picking arrays', () => {
  let seed = 713; const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 2 ** 32 }
  for (const spread of [2, 200]) {
    const meshes = Array.from({ length: 30 }, (_, id) => quad(`m${id}`, Math.floor(random()*spread), Math.floor(random()*spread), 1+random()*2, 1+random()*2, id % 3))
    compare(meshes)
  }
})

test('source view output and semantic Plan bands retain source order', () => {
  const a = quad('floor', -1, -1, 2, 2), b = quad('machine', -.7, -.4, 1.4, .8)
  const objects = [a, b].map(({ object, vertices }, at) => ({ ...object, kind: at ? 'equipment' as const : 'slab' as const, positions: Array.from(vertices).flatMap((_, index) => index % 7 ? [] : [vertices[index]!, vertices[index+1]!, vertices[index+2]!]) }))
  const scene: PackPhysicalScene = { id:'test',revision:'test',targetObjectId:'owner',anchor:[0,0],bearing:0,bounds:{min:[-1,-1,0],max:[1,1,0]},levels:[{id:'lower',label:'Lower',elevation:0,cutHeight:1}],objects }
  for (const mode of ['2d','3d'] as const) compare(buildVisibleMeshes(scene, { ...defaultPhysicalSceneView(scene.levels), mode, levelId:'all' }))
})
