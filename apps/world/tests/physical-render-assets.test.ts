import { expect, test } from 'bun:test'
import type { PackPhysicalScene } from '../src/core/packs/scene.ts'
import { createPhysicalSceneControllerForViewport } from '../src/ui/map/physical-scene/scene-controller.ts'
import { preparePhysicalGeometry } from '../src/ui/map/physical-scene/preparation.ts'
import { buildVisibleMeshes } from '../src/ui/map/physical-scene/geometry.ts'
import { createPhysicalOverviewScene, physicalOverviewContextMeshes } from '../src/ui/map/physical-scene/overview-geometry.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'
import type { PhysicalViewport } from '../src/ui/map/physical-scene/viewport.ts'
import type { PhysicalLayerEntry } from '../src/ui/map/physical-scene/layer.ts'

const scene = (id: string): PackPhysicalScene => ({ id, revision: 'r', targetObjectId: id, anchor: [0, 0], bearing: 0,
  bounds: { min: [0, 0, 0], max: [10, 10, 8] }, levels: [{ id: 'lower', label: 'Lower', elevation: 0, cutHeight: 2 }, { id: 'upper', label: 'Upper', elevation: 4, cutHeight: 6 }],
  scopes: [{ id: 'a', label: 'A', kind: 'building', bounds: { min: [0, 0, 0], max: [5, 10, 8] }, levelIds: ['lower', 'upper'] }, { id: 'b', label: 'B', kind: 'building', bounds: { min: [5, 0, 0], max: [10, 10, 8] }, levelIds: ['lower', 'upper'] }],
  layers: [{ id: 'utilities', label: 'Utilities', defaultVisible: true }],
  objects: ['machine', 'utility'].map((key, index) => ({ id: key, label: key, kind: 'equipment', levelId: 'lower', scopeIds: [index ? 'b' : 'a'], ...(index ? { layerId: 'utilities' } : {}), positions: [0, 0, 0, 5, 0, 8, 0, 5, 8], subjectIds: [`${id}:${key}`], material: 'metal' })) })
const harness = () => {
  let getEntries: () => ReadonlyArray<PhysicalLayerEntry> = () => [], prepares = 0, paletteUpdates = 0
  const listeners = new Map<string, Set<() => void>>(), fits: Parameters<PhysicalViewport['fitWorld']>[1][] = []
  const viewport: PhysicalViewport = {
    surface: { kind: 'canvas', element: {} as HTMLElement, getSize: () => ({ width: 800, height: 600 }), getPadding: () => ({ top: 0, right: 0, bottom: 0, left: 0 }), on: () => () => {} },
    ready: () => true, on(event, fn) { const list = listeners.get(event) ?? new Set(); list.add(fn); listeners.set(event, list); return () => { list.delete(fn) } },
    projectGeographic: point => ({ x: 400 + point.lng * 1_000_000, y: 300 + point.lat * 1_000_000 }), requestRender() {}, registered: () => true, orderRenderer() {}, removeRenderer() {},
    installRenderer(entries) { getEntries = entries; return { setPalette() { paletteUpdates++ }, retainGeometryIdentities() {}, dispose() {}, invalidatePicks() {}, metrics: () => null, pick: () => null, cheapProject: () => null, visibleAt: () => false, project: () => null } },
    cameraPose: () => ({ center: [0, 0], pitch: 0, bearing: 0, zoom: 1, revision: 0 }), setPose() {}, fitWorld(_bounds, options) { fits.push(options) }, panBy() {}, setNavigationTool() {}, cancelCamera() {}, destroy() {},
  }
  let waitForPreparation: Promise<void> | null = null
  const hold = () => { let release!: () => void; waitForPreparation = new Promise<void>(resolve => { release = resolve }); return () => { waitForPreparation = null; release() } }
  const cache = new Map<string, ReturnType<typeof preparePhysicalGeometry>>()
  const controller = createPhysicalSceneControllerForViewport(viewport, { palette: { materials: {}, defaultMaterial: [.5, .5, .5], line: [0, 0, 0] }, onChange() {}, reportError(error) { throw error },
    prepare: async (value, view, key, identity) => { const prior = cache.get(key); if (prior) return prior; prepares++; if (waitForPreparation) await waitForPreparation; const asset = preparePhysicalGeometry(value, view, key, identity); cache.set(key, asset); return asset } })
  const source = (value: PackPhysicalScene) => { const { objects: _, ...metadata } = value; return { descriptor: { ...metadata, geometryKey: 'same-template', locationValid: true, subjectIds: value.objects.flatMap(o => o.subjectIds), modelDigest: 'm' }, load: async () => value } }
  return { controller, source, fits, hold, entries: () => getEntries(), prepares: () => prepares, paletteUpdates: () => paletteUpdates }
}
const settled = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('shared render geometry preserves each placement owner and subject binding', async () => {
  const h = harness(), a = scene('a'), b = scene('b'); h.controller.setSources([h.source(a), h.source(b)])
  h.controller.setView('a', { ...defaultPhysicalSceneView(a.levels), mode: '3d', levelId: 'all' }); h.controller.setView('b', { ...defaultPhysicalSceneView(b.levels), mode: '3d', levelId: 'all' }); await settled()
  expect(h.prepares()).toBe(1)
  expect(h.entries()).toHaveLength(2)
  expect(h.entries()[0]!.asset!.buffers).toBe(h.entries()[1]!.asset!.buffers)
  expect(h.entries()[0]!.asset!.sourceAsset).toBe(h.entries()[1]!.asset!.sourceAsset)
  expect(h.entries().map(entry => entry.meshes[0]!.object.subjectIds[0])).toEqual(['a:machine', 'b:machine'])
  h.controller.destroy()
})

test('offset magnitude, layers, scope and palette preserve immutable base buffers; whole site clears scope filters', async () => {
  const h = harness(), a = scene('a'); h.controller.setSources([h.source(a)])
  const view = { ...defaultPhysicalSceneView(a.levels), mode: '3d' as const, levelId: 'all', separation: 4 }
  h.controller.setView('a', view); await settled(); const asset = h.entries()[0]!.asset, count = h.prepares()
  h.controller.setView('a', { ...view, separation: 13, hiddenLayerIds: ['utilities'] }); await settled()
  expect(h.prepares()).toBe(count); expect(h.entries()[0]!.asset).toBe(asset)
  expect(h.entries()[0]!.meshes.every(mesh => mesh.object.id === 'machine')).toBe(true)
  expect(h.entries()[0]!.meshes.find(mesh => mesh.levelId === 'upper')!.offset[2]).toBe(13)
  h.controller.setView('a', { ...view, hiddenLayerIds: [] }); h.controller.selectScope('a', 'a'); expect(h.entries()[0]!.meshes).toHaveLength(2); h.controller.fitAll(); expect(h.entries()[0]!.meshes).toHaveLength(4)
  h.controller.setPalette({ materials: {}, defaultMaterial: [.6, .6, .6], line: [0, 0, 0] }); expect(h.paletteUpdates()).toBe(1); expect(h.prepares()).toBe(count)
  h.controller.destroy()
})

test('authored Plan strokes replace the 3D stroke representation without drawing duplicate features', () => {
  const value = scene('a'); value.objects = [{ ...value.objects[0]!, edgePolicy: 'authored', featureLines: [{ positions: [0, 0, 1, 1, 0, 1] }], planLines: [{ positions: [0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1] }] }]
  expect(buildVisibleMeshes(value, { ...defaultPhysicalSceneView(value.levels), mode: '2d' })[0]!.lines.length).toBe(12)
  expect(buildVisibleMeshes(value, { ...defaultPhysicalSceneView(value.levels), mode: '3d' })[0]!.lines.length).toBe(6)
})

test('focused architectural context uses declared scope membership and never covers the inspected building', () => {
  const value = scene('a'), { objects: _, ...metadata } = value
  const descriptor = { ...metadata, scopes: [...value.scopes!, { ...value.scopes![0]!, id: 'room', kind: 'space' as const, parentId: 'a' }], locationValid: true, subjectIds: [], modelDigest: 'm', overviewFootprints: ['a', 'b'].map(scopeId => ({ id: `arbitrary-footprint-${scopeId}`, scopeId, label: scopeId, base: 0, height: 8, ring: [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]] as [number, number][] })) }
  const overview = createPhysicalOverviewScene(descriptor), meshes = buildVisibleMeshes(overview, { ...defaultPhysicalSceneView(value.levels), mode: '2d', levelId: 'all' })
  expect(physicalOverviewContextMeshes(descriptor, meshes, 'room').map(mesh => mesh.object.id)).toEqual(['arbitrary-footprint-b'])
  expect(physicalOverviewContextMeshes(descriptor, meshes, 'a').map(mesh => mesh.object.id)).toEqual(['arbitrary-footprint-b'])
  expect(overview.objects.every(object => object.subjectIds.length === 0)).toBe(true)
})

test('Home requests the same authored-relative oblique 3D view in either real host; Fit preserves pose', async () => {
  const h = harness(), value = { ...scene('a'), bearing: 40 }; h.controller.setSources([h.source(value)]); h.controller.setView('a', { ...defaultPhysicalSceneView(value.levels), mode: '3d' }); await settled()
  h.controller.home('a'); expect(h.fits.at(-1)).toMatchObject({ bearing: 15, preservePose: false, mode: '3d' })
  h.controller.fit('a'); expect(h.fits.at(-1)?.preservePose).toBe(true)
  h.controller.setView('a', defaultPhysicalSceneView(value.levels)); h.controller.home('a'); expect(h.fits.at(-1)).toMatchObject({ bearing: 40, preservePose: false, mode: '2d' }); h.controller.destroy()
})

test('cancelled or suspended hosts cannot apply a late deferred camera fit', async () => {
  for (const suspend of [false, true]) {
    const h = harness(), release = h.hold(), value = scene('a'); h.controller.setSources([h.source(value)]); h.controller.focus('a', { scopeId: 'a' }); const before = h.fits.length
    if (suspend) h.controller.setActive(false); else h.controller.cancelCamera()
    release(); await settled(); expect(h.fits).toHaveLength(before); if (suspend) expect(h.controller.presentations()[0]!.status).toBe('hidden'); h.controller.destroy()
  }
})
