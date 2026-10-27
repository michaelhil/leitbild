import { expect, test } from 'bun:test'
import { createPhysicalPreparedResidency } from '../src/ui/map/physical-scene/prepared-residency.ts'
import { preparePhysicalGeometry, type PhysicalPreparedGeometry } from '../src/ui/map/physical-scene/preparation.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'
import type { PackPhysicalScene } from '../src/core/packs/scene.ts'
const scene: PackPhysicalScene = { id: 's', revision: 'r', targetObjectId: 'owner', anchor: [0, 0], bearing: 0, bounds: { min: [0, 0, 0], max: [0, 0, 0] }, levels: [{ id: 'l', label: 'L', elevation: 0, cutHeight: 1 }], objects: [] }
const make = (key: string, bytes: number, identity = 'source', vertices = new Float32Array(bytes / 4)): PhysicalPreparedGeometry => {
  const empty = preparePhysicalGeometry(scene, defaultPhysicalSceneView(scene.levels), key, identity)
  return { ...empty, buffers: { ...empty.buffers, vertices } }
}
test('Plan and 3D CPU variants share one measured working set with inactive byte-based LRU eviction', () => {
  const pool = createPhysicalPreparedResidency(), a = make('plan/lower', 64), b = make('3d/all', 128), c = make('plan/upper', 80)
  pool.update([a, b]); expect(pool.metrics()).toEqual({ residentViews: 2, residentBytes: 192, peakRequiredBytes: 192, evictions: 0 })
  pool.update([a]); pool.update([c]); expect(pool.metrics()).toEqual({ residentViews: 2, residentBytes: 144, peakRequiredBytes: 192, evictions: 1 })
  pool.update([a]); expect(pool.metrics().evictions).toBe(1) // A survived; B was the older inactive view.
  const large = make('3d/tall-scope', 256); pool.update([large]); expect(pool.metrics()).toEqual({ residentViews: 1, residentBytes: 256, peakRequiredBytes: 256, evictions: 3 })
  for (let index = 0; index < 40; index++) { pool.update([make(`scope-${index}`, 16)]); expect(pool.metrics().residentBytes).toBeLessThanOrEqual(pool.metrics().peakRequiredBytes) }
  pool.clear(); expect(pool.metrics()).toMatchObject({ residentViews: 0, residentBytes: 0, peakRequiredBytes: 0 })
})
test('repeated placements and shared backing buffers count once; motion or status does not rescan or grow residency', () => {
  const pool = createPhysicalPreparedResidency(), shared = new ArrayBuffer(128), a = make('a', 128, 'source', new Float32Array(shared)), b = make('b', 64, 'source', new Float32Array(shared, 0, 16))
  const placement = { ...a, sourceAsset: a, meshes: [] }
  pool.update([a, placement, b]); const metrics = pool.metrics(); expect(metrics).toEqual({ residentViews: 2, residentBytes: 128, peakRequiredBytes: 128, evictions: 0 })
  for (let index = 0; index < 20; index++) pool.update([b, placement, a])
  expect(pool.metrics()).toEqual(metrics)
  pool.retainIdentities(new Set()); expect(pool.metrics()).toMatchObject({ residentViews: 0, residentBytes: 0, peakRequiredBytes: 0 })
})
test('source closure releases its variants while another source remains required, without depending on GC timing', () => {
  const pool = createPhysicalPreparedResidency(), a = make('a', 64, 'one'), b = make('b', 128, 'two')
  pool.update([a, b]); pool.retainIdentities(new Set(['two'])); expect(pool.metrics()).toMatchObject({ residentViews: 1, residentBytes: 128, peakRequiredBytes: 128 })
  pool.update([b]); expect(pool.metrics().residentBytes).toBe(128)
  pool.clear(); expect(pool.metrics().residentBytes).toBe(0)
})
test('an immutable residency key cannot alias different prepared storage or identities', () => {
  const pool = createPhysicalPreparedResidency(), a = make('a', 64)
  pool.update([a]); const before = pool.metrics()
  expect(() => pool.update([make('a', 64)])).toThrow('key changed')
  expect(() => pool.update([make('b', 64), make('b', 128)])).toThrow('key changed')
  expect(pool.metrics()).toEqual(before)
})
