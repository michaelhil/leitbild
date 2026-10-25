import { describe, expect, test } from 'bun:test'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { packPhysicalSceneSchema, type PackPhysicalScene, type PhysicalSceneObject } from '../src/core/packs/scene.ts'
import { resolvePhysicalDesign, currentPwrPhysicalDesignRef } from '../src/packs/physical-layout/design.ts'
import { compilePhysicalObjects, physicalObjectsBounds } from '../src/packs/physical-layout/native/compile-scene.ts'
import { createPhysicalSceneController, detailEligible } from '../src/ui/map/physical-scene/controller.ts'
import { buildVisibleMeshes } from '../src/ui/map/physical-scene/geometry.ts'
import { inverse, localMercatorMatrix, multiply, transform } from '../src/ui/map/physical-scene/math.ts'
import { pickPhysicalMesh } from '../src/ui/map/physical-scene/picking.ts'
import { physicalSceneLayerAnchorId } from '../src/ui/map/physical-scene/order.ts'
import { referenceLayerIdPrefix } from '../src/ui/map/reference-layer-factory.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'

const box = (id: string, min: [number, number, number], max: [number, number, number], kind = 'wall', subjectIds: string[] = []): PhysicalSceneObject => {
  const points = Array.from({ length: 8 }, (_, index) => [index & 1 ? max[0] : min[0], index & 2 ? max[1] : min[1], index & 4 ? max[2] : min[2]])
  const faces = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5]
  return { id, label: id, kind, levelId: 'lower', positions: faces.flatMap(index => points[index]!), subjectIds }
}
const scene = (objects: PhysicalSceneObject[]): PackPhysicalScene => ({ id: 'layout:a', revision: 'revision:a', targetObjectId: 'plant:a', anchor: [11.47, 59.087], bearing: 0, bounds: { min: [-1, -1, -1], max: [11, 2, 20] }, levels: [{ id: 'lower', label: 'Lower', elevation: 0, cutHeight: 1.2 }, { id: 'upper', label: 'Upper', elevation: 15, cutHeight: 16.2 }], objects })
const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1])

describe('Physical scene validation, projection and inspection fragments', () => {
  test('rejects invalid geometry, stale identity combinations and escaped bounds', () => {
    const valid = scene([box('wall', [0, 0, 0], [10, 0.5, 3])])
    expect(packPhysicalSceneSchema.safeParse(valid).success).toBe(true)
    expect(packPhysicalSceneSchema.safeParse({ ...valid, objects: [...valid.objects, valid.objects[0]] }).success).toBe(false)
    const changed = structuredClone(valid)
    changed.objects[0]!.positions[0] = 100
    expect(packPhysicalSceneSchema.safeParse(changed).success).toBe(false)
    changed.objects[0]!.positions[0] = 0
    changed.objects[0]!.indices = [0, 1, 1000]
    expect(packPhysicalSceneSchema.safeParse(changed).success).toBe(false)
    changed.objects[0]!.indices = [0, 1, 2]
    changed.objects[0]!.materialIndices = [0]
    expect(packPhysicalSceneSchema.safeParse(changed).success).toBe(false)
    expect(packPhysicalSceneSchema.safeParse({ ...valid, levels: [{ ...valid.levels[0], cutHeight: -1 }] }).success).toBe(false)
  })

  test('uses explicit geographic orientation and high precision before GPU conversion', () => {
    const matrix = localMercatorMatrix([11.47, 59.087], 0), origin = transform(matrix, [0, 0, 0])
    expect(transform(matrix, [1, 0, 0])[0]).toBeGreaterThan(origin[0])
    expect(transform(matrix, [0, 1, 0])[1]).toBeLessThan(origin[1])
    const rotated = localMercatorMatrix([11.47, 59.087], 90)
    expect(transform(rotated, [0, 1, 0])[0]).toBeGreaterThan(transform(rotated, [0, 0, 0])[0])
    const roundtrip = transform(multiply(inverse(matrix), matrix), [31.2, -20, 16.2])
    expect(roundtrip[0]).toBeCloseTo(31.2, 5)
    expect(roundtrip[1]).toBeCloseTo(-20, 5)
    expect(roundtrip[2]).toBeCloseTo(16.2, 5)
  })

  test('detail uses projected footprint with hysteresis and viewport culling', () => {
    expect(detailEligible(239, true, false)).toBe(false)
    expect(detailEligible(240, true, false)).toBe(true)
    expect(detailEligible(180, true, true)).toBe(true)
    expect(detailEligible(179, true, true)).toBe(false)
    expect(detailEligible(1000, false, true)).toBe(false)
  })

  test('native operational lines and zones stay above physical geometry regardless of registration order', () => {
    const style = { metadata: { 'leitbild:baseSources': ['base'] }, layers: [
      { id: 'base-ground', type: 'fill', source: 'base' },
      { id: `${referenceLayerIdPrefix}roads`, type: 'line', source: 'reference-roads' },
      { id: 'physical-scenes:solids', type: 'custom' },
      { id: 'live:grid:line', type: 'line', source: 'live-grid' },
      { id: 'base-label', type: 'symbol', source: 'base' },
    ] }
    expect(physicalSceneLayerAnchorId(style)).toBe('live:grid:line')
    expect(physicalSceneLayerAnchorId({ ...style, layers: style.layers.filter(layer => !layer.id.startsWith('live:')) })).toBe('base-label')
    expect(() => physicalSceneLayerAnchorId({ layers: [] })).toThrow('source metadata')
  })

  test('caps a cut wall without filling its hosted access opening', () => {
    const left = box('left', [0, 0, 0], [4, 0.5, 3]), right = box('right', [6, 0, 0], [10, 0.5, 3])
    const openingWall = { ...left, id: 'door-wall', positions: [...left.positions, ...right.positions] }
    const source = scene([openingWall]), meshes = buildVisibleMeshes(source, defaultPhysicalSceneView(source.levels))
    let capArea = 0
    for (const mesh of meshes) for (let index = 0; index < mesh.vertices.length; index += 21) {
      const v = mesh.vertices
      if ([index + 2, index + 9, index + 16].every(at => Math.abs(v[at]! - 1.2) < 1e-6) && v[index + 5] === 1) {
        capArea += Math.abs((v[index + 7]! - v[index]!) * (v[index + 15]! - v[index + 1]!) - (v[index + 8]! - v[index + 1]!) * (v[index + 14]! - v[index]!)) / 2
      }
    }
    expect(capArea).toBeCloseTo(4, 5)
    expect(meshes[0]!.lines.length).toBeGreaterThan(0)
    expect(JSON.stringify(source)).toBe(JSON.stringify(scene([openingWall])))
  })

  test('floor fragments and display separation preserve one physical occurrence identity', () => {
    const source = scene([box('spanning-wall', [0, 0, 0], [1, 0.5, 19]), box('lower-pump', [2, 0, 0], [3, 1, 2], 'equipment', ['pump'])])
    const upper = buildVisibleMeshes(source, { ...defaultPhysicalSceneView(source.levels), levelId: 'upper' })
    expect(upper.map(mesh => mesh.object.id)).toEqual(['spanning-wall'])
    expect(upper[0]!.bounds.min[2]).toBeCloseTo(14.99, 5)
    expect(upper[0]!.bounds.max[2]).toBeCloseTo(16.2, 5)
    const separated = buildVisibleMeshes(source, { ...defaultPhysicalSceneView(source.levels), levelId: 'all', separation: 8 })
    const fragments = separated.filter(mesh => mesh.object.id === 'spanning-wall')
    expect(fragments).toHaveLength(2)
    expect(fragments[0]!.object).toBe(fragments[1]!.object)
    expect(fragments.map(mesh => mesh.offset[2])).toEqual([0, 8])
  })

  test('an opaque slab blocks equipment picks, and selecting its lower floor exposes it', () => {
    const floor = { ...box('deck', [-0.8, -0.8, 0.7], [0.8, 0.8, 0.8], 'slab'), levelId: 'upper' }
    const pump = box('pump', [-0.3, -0.3, 0], [0.3, 0.3, 0.5], 'equipment', ['pump'])
    const source = scene([floor, pump])
    source.levels[1] = { id: 'upper', label: 'Upper', elevation: 0.7, cutHeight: 1.2 }
    const all = buildVisibleMeshes(source, { ...defaultPhysicalSceneView(source.levels), levelId: 'all', cutaway: false })
    expect(pickPhysicalMesh([{ sceneId: source.id, meshes: all, matrix: identity }], { x: 50, y: 50 }, 100, 100)?.mesh.object.id).toBe('deck')
    const lower = buildVisibleMeshes(source, defaultPhysicalSceneView(source.levels))
    expect(pickPhysicalMesh([{ sceneId: source.id, meshes: lower, matrix: identity }], { x: 50, y: 50 }, 100, 100)?.mesh.object.id).toBe('pump')
  })

  test('reused geometry has independently qualified scene picks', () => {
    const source = scene([box('pump', [-0.3, -0.3, 0], [0.3, 0.3, 0.5], 'equipment', ['pump'])])
    const meshes = buildVisibleMeshes(source, defaultPhysicalSceneView(source.levels))
    const shifted = new Float64Array(identity); shifted[12] = 1
    const entries = [{ sceneId: 'layout:a', meshes, matrix: identity }, { sceneId: 'layout:b', meshes, matrix: shifted }]
    expect(pickPhysicalMesh(entries, { x: 50, y: 50 }, 100, 100)?.sceneId).toBe('layout:a')
    expect(pickPhysicalMesh(entries, { x: 95, y: 50 }, 100, 100)?.sceneId).toBe('layout:b')
  })

  test('the real saved PWR delivery produces distinct credible lower and operating plans without source mutation', () => {
    const data = resolvePhysicalDesign(currentPwrPhysicalDesignRef), objects = compilePhysicalObjects(data)
    const real: PackPhysicalScene = { ...scene(objects), bounds: physicalObjectsBounds(objects), levels: data.source.levels.map(level => ({ ...level, cutHeight: level.elevation + level.cutHeight })) }
    const before = JSON.stringify(real)
    const lower = buildVisibleMeshes(real, defaultPhysicalSceneView(real.levels)), upper = buildVisibleMeshes(real, { ...defaultPhysicalSceneView(real.levels), levelId: 'operating' })
    expect(lower.some(mesh => mesh.object.subjectIds.includes('condenser'))).toBe(true)
    expect(upper.some(mesh => mesh.object.subjectIds.includes('turbine'))).toBe(true)
    expect(lower.some(mesh => mesh.object.kind === 'roof')).toBe(false)
    expect(lower.filter(mesh => mesh.object.kind === 'door').some(mesh => mesh.lines.length > 0)).toBe(true)
    expect(lower.length).not.toBe(upper.length)
    expect(JSON.stringify(real)).toBe(before)
  })
})

/** A lifecycle-only map test double. Actual GL composition is checked in the browser. */
const lifecycleMap = () => {
  const listeners = new Map<string, Set<() => void>>(), layers = new Map<string, unknown>()
  const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ width: 1000, height: 700 }) })
  let scale = 2_000_000, adds = 0
  const map = {
    getCanvas: () => canvas,
    on(event: string, listener: () => void) { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set) },
    off(event: string, listener: () => void) { listeners.get(event)?.delete(listener) },
    project: (p: { lng: number; lat: number }) => ({ x: 500 + (p.lng - 11.47) * scale, y: 350 - (p.lat - 59.087) * scale }),
    getLayer: (id: string) => layers.get(id),
    addLayer(layer: { id: string }) { layers.set(layer.id, layer); adds++ },
    removeLayer: (id: string) => layers.delete(id),
    isStyleLoaded: () => true,
    triggerRepaint() {},
    easeTo() {},
    getPadding: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    fitBounds() {},
  }
  return {
    map: map as unknown as MapLibreMap,
    scale: (value: number) => { scale = value },
    emit: (event: string) => { for (const listener of listeners.get(event) ?? []) listener() },
    replaceStyle: () => { layers.clear(); for (const listener of listeners.get('style.load') ?? []) listener() },
    layerCount: () => layers.size,
    adds: () => adds,
    listenerCount: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
  }
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
const descriptorFor = (value: PackPhysicalScene) => ({ ...value, locationValid: true, subjectIds: ['pump'], modelDigest: 'a'.repeat(64) })
const palette = { materials: {}, defaultMaterial: [0.5, 0.5, 0.5] as const, line: [0.2, 0.2, 0.2] as const }

describe('Physical scene load and shared-map lifecycle boundaries', () => {
  test('does not load distant/hidden geometry, coalesces pending detail and removes all listeners', async () => {
    const fake = lifecycleMap(), value = scene([box('wall', [0, 0, 0], [10, 0.5, 3])]), errors: Error[] = []
    let resolve!: (value: PackPhysicalScene) => void, calls = 0
    const loaded = new Promise<PackPhysicalScene>(done => { resolve = done })
    const controller = createPhysicalSceneController({ map: fake.map, palette, beforeId: () => undefined, onChange() {}, reportError: error => errors.push(error) })
    fake.scale(100)
    const source = { descriptor: descriptorFor(value), load: () => { calls++; return loaded } }
    controller.setSources([source])
    expect(calls).toBe(0)
    fake.scale(2_000_000); fake.emit('move'); await flush()
    expect(calls).toBe(1)
    controller.setView(value.id, { ...defaultPhysicalSceneView(value.levels), detail: 'hidden' })
    controller.setView(value.id, defaultPhysicalSceneView(value.levels))
    expect(calls).toBe(1)
    resolve(value); await flush()
    expect(controller.presentations()[0]!.status).toBe('ready')
    expect(fake.layerCount()).toBe(1)
    controller.setSources([])
    expect(fake.layerCount()).toBe(0)
    controller.destroy()
    expect(fake.listenerCount()).toBe(0)
    expect(errors).toHaveLength(0)
  })

  test('late delivery cannot replace a new revision or resurrect removed visibility', async () => {
    const fake = lifecycleMap(), a = scene([box('wall', [0, 0, 0], [10, 0.5, 3])]), b = { ...a, revision: 'revision:b' }, errors: Error[] = []
    let finishA!: (value: PackPhysicalScene) => void
    const pending = new Promise<PackPhysicalScene>(done => { finishA = done })
    const controller = createPhysicalSceneController({ map: fake.map, palette, beforeId: () => undefined, onChange() {}, reportError: error => errors.push(error) })
    controller.setSources([{ descriptor: descriptorFor(a), load: () => pending }])
    controller.setSources([{ descriptor: descriptorFor(b), load: async () => b }])
    await flush(); expect(controller.scene(a.id)?.revision).toBe('revision:b')
    finishA(a); await flush(); expect(controller.scene(a.id)?.revision).toBe('revision:b')
    controller.setSources([]); await flush()
    expect(controller.presentations()).toEqual([])
    expect(fake.layerCount()).toBe(0)
    expect(errors).toHaveLength(0)
    controller.destroy()
  })

  test('style replacement reinstalls once and incompatible delivery fails visibly without retries', async () => {
    const fake = lifecycleMap(), value = scene([box('wall', [0, 0, 0], [10, 0.5, 3])]), errors: Error[] = []
    const controller = createPhysicalSceneController({ map: fake.map, palette, beforeId: () => undefined, onChange() {}, reportError: error => errors.push(error) })
    controller.setSources([{ descriptor: descriptorFor(value), load: async () => value }]); await flush()
    expect(fake.adds()).toBe(1)
    fake.replaceStyle(); await flush()
    expect(fake.adds()).toBe(2)
    fake.emit('styledata'); await flush()
    expect(fake.adds()).toBe(2)
    let calls = 0
    const changed = { ...value, revision: 'revision:invalid' }
    const badSource = { descriptor: descriptorFor(changed), load: async () => { calls++; return value } }
    controller.setSources([badSource]); await flush()
    expect(controller.presentations()[0]!.status).toBe('unavailable')
    controller.setSources([badSource]); fake.emit('move'); await flush()
    expect(calls).toBe(1)
    expect(errors[0]?.message).toContain('does not match')
    expect(fake.layerCount()).toBe(0)
    controller.destroy()
  })
})
