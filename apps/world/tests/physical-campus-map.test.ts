import { expect, test } from 'bun:test'
import type { PackPhysicalScene, PhysicalSceneObject } from '../src/core/packs/scene.ts'
import { buildVisibleMeshes } from '../src/ui/map/physical-scene/geometry.ts'
import { createPhysicalSceneController } from '../src/ui/map/physical-scene/controller.ts'
import { createPhysicalSceneOverview, physicalOverviewFeatures } from '../src/ui/map/physical-scene/overview.ts'
import { physicalSceneLayerAnchorId, physicalSceneLayerId, physicalSceneOverviewLayerId } from '../src/ui/map/physical-scene/order.ts'
import { defaultPhysicalSceneView, type PhysicalScenePresentation } from '../src/ui/map/physical-scene/types.ts'
import { createFakeMapStyle } from './helpers/fake-map-style.ts'

const shell = (): PhysicalSceneObject => {
  const positions: number[] = []
  const point = (radius: number, segment: number, z: number) => [radius * Math.cos(segment * Math.PI / 16), radius * Math.sin(segment * Math.PI / 16), z]
  const quad = (a: number[], b: number[], c: number[], d: number[]) => positions.push(...a, ...b, ...c, ...a, ...c, ...d)
  for (let index = 0; index < 32; index++) {
    const next = index + 1
    quad(point(2, index, 0), point(2, next, 0), point(2, next, 3), point(2, index, 3))
    quad(point(1, next, 0), point(1, index, 0), point(1, index, 3), point(1, next, 3))
    quad(point(1, index, 3), point(2, index, 3), point(2, next, 3), point(1, next, 3))
    quad(point(1, next, 0), point(2, next, 0), point(2, index, 0), point(1, index, 0))
  }
  return { id: 'shell', label: 'Hollow containment wall', kind: 'wall', levelId: 'ground', positions, subjectIds: [] }
}
const scene = (): PackPhysicalScene => ({ id: 'unit-layout', revision: 'design:retained', targetObjectId: 'unit', anchor: [11.47, 59.087], bearing: 0,
  bounds: { min: [-2, -2, 0], max: [2, 2, 30] }, levels: [{ id: 'ground', label: 'Ground', elevation: 0, cutHeight: 1.2 }, { id: 'upper', label: 'Upper', elevation: 4, cutHeight: 5.2 }], objects: [shell()] })

test('a circular hollow wall remains an annulus at the inspection cut, with no disk hiding its room', () => {
  const source = scene(), before = JSON.stringify(source)
  const meshes = buildVisibleMeshes(source, { ...defaultPhysicalSceneView(source.levels), mode: '3d' })
  let area = 0, capCount = 0
  for (const mesh of meshes) for (let index = 0; index < mesh.vertices.length; index += 21) {
    const v = mesh.vertices
    if (![index + 2, index + 9, index + 16].every(at => Math.abs(v[at]! - 1.2) < 1e-6) || v[index + 5] !== 1) continue
    const a = [v[index]!, v[index + 1]!], b = [v[index + 7]!, v[index + 8]!], c = [v[index + 14]!, v[index + 15]!]
    const cross = (p: number[], q: number[]) => p[0]! * q[1]! - p[1]! * q[0]!
    const signs = [cross(a, b), cross(b, c), cross(c, a)]
    expect(signs.every(sign => sign >= -1e-8) || signs.every(sign => sign <= 1e-8)).toBe(false)
    area += Math.abs((b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!)) / 2
    capCount++
  }
  expect(capCount).toBeGreaterThan(30)
  expect(area).toBeCloseTo(32 / 2 * (4 - 1) * Math.sin(Math.PI / 16), 6)
  expect(JSON.stringify(source)).toBe(before)
})

test('outdoor structures retain their full height when an indoor floor or separated view is selected', () => {
  const source = scene()
  source.objects = [{ ...shell(), id: 'pylon', kind: 'support', levelId: 'site' }]
  for (const levelId of ['ground', 'upper', 'all']) {
    const meshes = buildVisibleMeshes(source, { ...defaultPhysicalSceneView(source.levels), mode: '3d', levelId, separation: 20 })
    expect(meshes).toHaveLength(1)
    expect(meshes[0]!.bounds.min[2]).toBe(0)
    expect(meshes[0]!.bounds.max[2]).toBe(3)
    expect(meshes[0]!.offset[2]).toBe(0)
  }
})

const presentation = (status: PhysicalScenePresentation['status'] = 'distant'): PhysicalScenePresentation => {
  const { objects: _, ...descriptor } = scene()
  return { descriptor: { ...descriptor, locationValid: true, subjectIds: [], modelDigest: 'model', overviewFootprints: [{ id: 'reactor-building', label: 'Reactor building', ring: [[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]], base: 0, height: 30 }] }, status, view: defaultPhysicalSceneView(descriptor.levels), occurrenceCount: 0 }
}
test('coarse footprints are correctly georeferenced and replaced only by their own ready detailed scene', () => {
  const data = physicalOverviewFeatures([presentation(), { ...presentation('ready'), descriptor: { ...presentation().descriptor, id: 'other-unit', targetObjectId: 'other-owner' } }])
  expect(data.features).toHaveLength(1)
  expect(data.features[0]!.properties.objectId).toBe('unit')
  expect(data.features[0]!.geometry.coordinates[0]![0]![0]).toBeLessThan(11.47)
  expect(data.features[0]!.geometry.coordinates[0]![0]![1]).toBeLessThan(59.087)
  expect(physicalOverviewFeatures([{ ...presentation(), descriptor: { ...presentation().descriptor, locationValid: false } }]).features).toEqual([])
  const malformed = presentation()
  malformed.descriptor.overviewFootprints![0]!.ring[4] = [0, 0]
  expect(() => physicalOverviewFeatures([malformed])).toThrow('closed')
})

test('coarse layer preserves operational ordering, recovers a replaced style and removes its own resources', async () => {
  const fake = createFakeMapStyle(), errors: Error[] = []
  let updates = 0, styleReady = true
  const addSource = fake.map.addSource.bind(fake.map)
  Object.assign(fake.map, { isStyleLoaded: () => styleReady, setPaintProperty: () => {}, addSource: (id: string, specification: Parameters<typeof fake.map.addSource>[1]) => {
    addSource(id, specification)
    fake.sources.get(id)!.setData = () => { updates++ }
  } })
  fake.map.addLayer({ id: physicalSceneLayerId, type: 'custom', renderingMode: '3d', render: () => {} }, 'poi-emergency')
  const overview = createPhysicalSceneOverview({ map: fake.map, beforeId: () => physicalSceneLayerAnchorId(fake.map.getStyle()), palette: { materials: {}, defaultMaterial: [0.4, 0.4, 0.4], line: [0.1, 0.1, 0.1] }, reportError: error => errors.push(error) })
  overview.update([presentation()]); overview.update([presentation()])
  const order = fake.map.getLayersOrder()
  expect(order.indexOf(physicalSceneOverviewLayerId)).toBeLessThan(order.indexOf(physicalSceneLayerId))
  expect(order.indexOf(physicalSceneLayerId)).toBeLessThan(order.indexOf('poi-emergency'))
  expect(physicalSceneLayerAnchorId(fake.map.getStyle())).toBe('poi-emergency')
  expect(updates).toBe(0)
  overview.update([presentation('loading')])
  expect(updates).toBe(0)
  styleReady = false
  overview.update([presentation('ready')])
  // Removing an existing coarse layer must not wait for a GeoJSON worker or
  // map idle: its closed roof would cover the ready interior in that interval.
  expect(fake.sources.size).toBe(0)
  styleReady = true
  fake.emit('idle', {})
  await Promise.resolve()
  expect(fake.sources.size).toBe(0)
  overview.update([presentation()])
  expect(fake.sources.size).toBe(1)
  fake.map.removeLayer(physicalSceneOverviewLayerId)
  for (const id of [...fake.sources.keys()]) fake.map.removeSource(id)
  fake.emit('style.load', {})
  await Promise.resolve()
  expect(fake.map.getLayer(physicalSceneOverviewLayerId)).toBeDefined()
  expect(fake.sources.size).toBe(1)
  overview.destroy()
  expect(fake.sources.size).toBe(0)
  expect(fake.map.getLayer(physicalSceneLayerId)).toBeDefined()
  expect(fake.listenerCount('style.load')).toBe(0)
  expect(fake.listenerCount('idle')).toBe(0)
  expect(errors).toEqual([])
})

test('one camera has one projection while each layout retains its own floor, separation and live settings', () => {
  const fake = createFakeMapStyle(), pitches: number[] = []
  const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ width: 800, height: 600 }) })
  Object.assign(fake.map, { getCanvas: () => canvas, project: () => ({ x: 400, y: 300 }), triggerRepaint: () => {}, isStyleLoaded: () => true,
    easeTo: (options: { pitch: number }) => pitches.push(options.pitch), getPadding: () => ({ top: 0, right: 0, bottom: 0, left: 0 }), fitBounds: () => {} })
  const controller = createPhysicalSceneController({ map: fake.map, palette: { materials: {}, defaultMaterial: [0.4, 0.4, 0.4], line: [0.1, 0.1, 0.1] }, beforeId: () => undefined,
    onChange: () => {}, reportError: error => { throw error } })
  const source = (id: string, revision = 'design:retained') => ({ descriptor: { ...presentation().descriptor, id, revision }, load: async (): Promise<PackPhysicalScene> => { throw new Error('Distant sources must remain unloaded') } })
  const a = source('a'), b = source('b'), c = source('c')
  controller.setSources([a, b])
  controller.setView('a', { ...presentation().view, mode: '3d', levelId: 'upper', separation: 12, cutaway: false, live: false })
  const view = (id: string) => controller.presentations().find(entry => entry.descriptor.id === id)!.view
  expect(view('b')).toEqual({ ...presentation().view, mode: '3d' })
  controller.setSources([a, b, c])
  expect(view('c').mode).toBe('3d')
  controller.setView('b', { ...view('b'), levelId: 'all', separation: 8, detail: 'hidden' })
  expect(view('a')).toEqual({ ...presentation().view, mode: '3d', levelId: 'upper', separation: 12, cutaway: false, live: false })
  controller.setView('a', { ...view('a'), mode: '2d' })
  expect(view('b')).toEqual({ ...presentation().view, levelId: 'ground', separation: 8, detail: 'hidden' })
  expect(view('a').levelId).toBe('upper')
  expect(view('c').mode).toBe('2d')
  controller.setView('a', { ...view('a'), mode: '3d' })
  controller.setSources([source('a', 'changed-design'), b, c])
  expect(controller.presentations().every(entry => entry.view.mode === '3d')).toBe(true)
  controller.reset('b')
  expect(controller.presentations().every(entry => entry.view.mode === '2d')).toBe(true)
  controller.setView('a', { ...view('a'), mode: '3d', levelId: 'all' })
  controller.setView('a', { ...view('a'), mode: '2d' })
  expect(view('a').levelId).toBe('ground')
  expect(pitches).toEqual([50, 0, 50, 0, 50, 0])
  controller.destroy()
})
