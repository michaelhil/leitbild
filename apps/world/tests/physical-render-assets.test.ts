import { expect, test } from 'bun:test'
import type { PackPhysicalScene, PhysicalSceneBounds } from '../src/core/packs/scene.ts'
import { createPhysicalSceneControllerForViewport } from '../src/ui/map/physical-scene/scene-controller.ts'
import { preparePhysicalGeometry } from '../src/ui/map/physical-scene/preparation.ts'
import { pickPhysicalMesh } from '../src/ui/map/physical-scene/picking.ts'
import { buildVisibleMeshes } from '../src/ui/map/physical-scene/geometry.ts'
import { createPhysicalOverviewScene, physicalOverviewContextMeshes } from '../src/ui/map/physical-scene/overview-geometry.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'
import type { PhysicalViewport } from '../src/ui/map/physical-scene/viewport.ts'
import type { PhysicalLayerEntry } from '../src/ui/map/physical-scene/layer.ts'
import { localMercatorMatrix, transform } from '../src/ui/map/physical-scene/math.ts'

const scene = (id: string): PackPhysicalScene => ({ id, revision: 'r', targetObjectId: id, anchor: [0, 0], bearing: 0,
  bounds: { min: [0, 0, 0], max: [10, 10, 8] }, levels: [{ id: 'lower', label: 'Lower', elevation: 0, cutHeight: 2 }, { id: 'upper', label: 'Upper', elevation: 4, cutHeight: 6 }],
  scopes: [{ id: 'a', label: 'A', kind: 'building', bounds: { min: [0, 0, 0], max: [5, 10, 8] }, levelIds: ['lower', 'upper'] }, { id: 'b', label: 'B', kind: 'building', bounds: { min: [5, 0, 0], max: [10, 10, 8] }, levelIds: ['lower', 'upper'] }],
  layers: [{ id: 'utilities', label: 'Utilities', defaultVisible: true }],
  objects: ['machine', 'utility'].map((key, index) => ({ id: key, label: key, kind: 'equipment', levelId: 'lower', scopeIds: [index ? 'b' : 'a'], ...(index ? { layerId: 'utilities' } : {}), positions: [0, 0, 0, 5, 0, 8, 0, 5, 8], subjectIds: [`${id}:${key}`], material: 'metal' })) })
const harness = (kind: 'map' | 'canvas' = 'canvas') => {
  let projectScale = 1_000_000
  let getEntries: () => ReadonlyArray<PhysicalLayerEntry> = () => [], prepares = 0, paletteUpdates = 0
  const tools: string[] = [], poses: Parameters<PhysicalViewport['setPose']>[0][] = [], signals: Array<AbortSignal | undefined> = []
  const listeners = new Map<string, Set<() => void>>(), fits: Parameters<PhysicalViewport['fitWorld']>[1][] = [], fitBounds: PhysicalSceneBounds[] = []
  const viewport: PhysicalViewport = {
    surface: { kind, element: {} as HTMLElement, getSize: () => ({ width: 800, height: 600 }), getPadding: () => ({ top: 0, right: 0, bottom: 0, left: 0 }), on: () => () => {} },
    ready: () => true, on(event, fn) { const list = listeners.get(event) ?? new Set(); list.add(fn); listeners.set(event, list); return () => { list.delete(fn) } },
    intersectsBounds: () => true,
    projectGeographic: point => ({ x: 400 + point.lng * projectScale, y: 300 + point.lat * projectScale }), requestRender() {}, registered: () => true, orderRenderer() {}, removeRenderer() {},
    installRenderer(entries, _palette, reportError) { rendererError = reportError; getEntries = entries; return { setPalette() { paletteUpdates++ }, retainGeometryIdentities() {}, dispose() {}, invalidatePicks() {}, metrics: () => null, pick: () => null, cheapProject: () => null, visibleAt: () => false, project: () => null } },
    cameraPose: () => ({ center: [0, 0], pitch: 0, bearing: 0, zoom: 1, revision: 0 }), setPose(patch) { poses.push(patch) }, fitWorld(bounds, options) { fitBounds.push(bounds); fits.push(options) }, panBy() {}, setNavigationTool(value) { tools.push(value) }, cancelCamera() {}, destroy() {},
  }
  let failPreparation = false, rendererError: ((error: Error) => void) | null = null
  const errors: Error[] = []
  let waitForPreparation: Promise<void> | null = null
  const hold = () => { let release!: () => void; waitForPreparation = new Promise<void>(resolve => { release = resolve }); return () => { waitForPreparation = null; release() } }
  const cache = new Map<string, ReturnType<typeof preparePhysicalGeometry>>()
  const controller = createPhysicalSceneControllerForViewport(viewport, { palette: { materials: {}, defaultMaterial: [.5, .5, .5], line: [0, 0, 0] }, onChange() {}, reportError(error) { errors.push(error) },
    prepare: async (value, view, key, identity, _sourceKey, signal) => { signals.push(signal); if (failPreparation) { failPreparation = false; throw Error('Preparation rejected') }; const prior = cache.get(key); if (prior) return prior; prepares++; if (waitForPreparation) await waitForPreparation; const asset = preparePhysicalGeometry(value, view, key, identity); cache.set(key, asset); return asset } })
  const source = (value: PackPhysicalScene) => { const { objects: _, ...metadata } = value; return { descriptor: { ...metadata, geometryKey: 'same-template', inspectionFeatureMetres: 1, locationValid: true, subjectIds: value.objects.flatMap(o => o.subjectIds), modelDigest: 'm' }, load: async () => value } }
  return { controller, source, fits, fitBounds, tools, poses, signals, hold, scale: (value: number) => { projectScale = value }, errors, failPreparation: () => { failPreparation = true }, failRenderer: () => rendererError?.(Error('Renderer rejected')), entries: () => getEntries(), prepares: () => prepares, paletteUpdates: () => paletteUpdates }
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

test('focused inspection isolates its geometry and surrounding buildings are an explicit reusable view choice', async () => {
  const h = harness(), first = scene('a'), second = scene('b')
  const view = { ...defaultPhysicalSceneView(first.levels), mode: '3d' as const, levelId: 'all' }
  h.controller.setSources([h.source(first), h.source(second)]); h.controller.setView('a', view); await settled()
  expect(h.entries().map(entry => entry.scene.id)).toEqual(['a', 'b'])
  h.controller.selectScope('a', 'a'); await settled()
  expect(h.entries().map(entry => entry.scene.id)).toEqual(['a'])
  const count = h.prepares()
  h.controller.setView('a', { ...view, surroundings: true }); await settled()
  expect(h.entries().map(entry => entry.scene.id)).toEqual(['a', 'b'])
  expect(h.prepares()).toBe(count)
  h.controller.setView('a', view); await settled(); expect(h.entries().map(entry => entry.scene.id)).toEqual(['a'])
  h.controller.fitAll(); await settled(); expect(h.entries().map(entry => entry.scene.id)).toEqual(['a', 'b'])
  h.controller.destroy()
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

test('collection Home adopts whole 3D context and refits after all requested assets are ready; Fit preserves pose', async () => {
  const h = harness('map'), release = h.hold(), a = scene('a'), b = scene('b')
  h.scale(1); h.controller.setSources([h.source(a), h.source(b)])
  h.controller.setView('a', { ...defaultPhysicalSceneView(a.levels), mode: '3d' })
  h.controller.fitAll(undefined, { preservePose: false })
  expect(h.controller.presentations().map(scene => scene.view.levelId)).toEqual(['all', 'all'])
  expect(h.fits).toHaveLength(1); expect(h.fits[0]).toMatchObject({ preservePose: false, bearing: 0, pitch: 50, mode: '3d' })
  release(); await settled(); expect(h.fits).toHaveLength(2)
  h.controller.fitAll(); expect(h.fits.at(-1)?.preservePose).toBe(true)
  h.controller.destroy()
})

test('a cancelled collection camera intent cannot reframe the map after late source preparation', async () => {
  const h = harness('map'), release = h.hold(), a = scene('a')
  h.scale(1); h.controller.setSources([h.source(a)]); h.controller.fitAll()
  const before = h.fits.length; h.controller.cancelCamera(); release(); await settled()
  expect(h.fits).toHaveLength(before); h.controller.destroy()
})

test('Plan painting reads the existing presentation styles without acquiring separate truth', async () => {
  const h = harness(), value = scene('a'); h.controller.setSources([h.source(value)]); await settled()
  const status = new Map([['a:machine', { color: [.1, .2, .3] as const, emphasis: .5 }]])
  h.controller.setStatus('a', status); expect(h.controller.subjectStyles('a')).toBe(status)
  expect(h.controller.subjectStyles('missing').size).toBe(0); h.controller.destroy()
})

test('Plan camera fitting includes selected drafting extents without changing physical bounds or occurrence focus', async () => {
  const h = harness('map'), value = scene('a'), physicalBounds = structuredClone(value.bounds)
  value.planDrawing = { views: [{ levelId: 'lower', bounds: { min: [-3, -4], max: [150, 150] }, primitives: [
    { id: 'room-dimension', kind: 'path', scopeIds: ['a'], depiction: 'annotation', bounds: { min: [-3, -4], max: [8, 12] }, commands: [['M', -3, -4], ['L', 8, 12]], stroke: 'line' },
    { id: 'other-room-dimension', kind: 'path', scopeIds: ['b'], depiction: 'annotation', bounds: { min: [100, 100], max: [150, 150] }, commands: [['M', 100, 100], ['L', 150, 150]], stroke: 'line' },
  ] }] }
  h.controller.setSources([h.source(value)]); await settled(); h.controller.home('a', 'a')
  const matrix = localMercatorMatrix(value.anchor, value.bearing), min = transform(matrix, [-3, 12, 0]), max = transform(matrix, [8, -4, 0])
  const expected: PhysicalSceneBounds = { min: [...min], max: [...max] }
  expect(h.fitBounds.at(-1)).toEqual(expected)
  expect(value.bounds).toEqual(physicalBounds)
  h.controller.focus('a', { occurrenceId: 'machine' })
  expect(h.fitBounds.at(-1)!.min[0]).toBeGreaterThan(min[0])
  expect(h.fitBounds.at(-1)!.max[0]).toBeLessThan(max[0]); h.controller.destroy()
})

test('rapid floor choices cancel obsolete demand and stale completions cannot replace the selected floor', async () => {
  const h = harness(), release = h.hold(), value = scene('a'), base = defaultPhysicalSceneView(value.levels)
  h.controller.setSources([h.source(value)]); h.controller.selectScope('a'); await settled()
  h.controller.setView('a', { ...base, levelId: 'upper' }); await settled()
  h.controller.setView('a', { ...base, levelId: 'lower' }); await settled()
  expect(h.signals.length).toBeGreaterThanOrEqual(3)
  expect(h.signals.slice(0, -1).every(signal => signal?.aborted)).toBe(true)
  expect(h.signals.at(-1)?.aborted).toBe(false)
  release(); await settled()
  expect(h.controller.presentations()[0]?.view.levelId).toBe('lower'); expect(h.controller.presentations()[0]?.status).toBe('ready')
  expect(h.entries()[0]?.meshes.every(mesh => mesh.levelId === 'lower')).toBe(true); expect(h.errors).toEqual([])
  h.controller.destroy!(); expect(h.signals.every(signal => signal?.aborted || signal === h.signals.at(-1))).toBe(true)
})

test('failed preparation and GPU admission remain unavailable until an explicit retry can recover', async () => {
  const h = harness(), value = scene('a'); h.failPreparation(); h.controller.setSources([h.source(value)]); h.controller.selectScope('a'); await settled(); expect(h.controller.presentations()[0]!.status).toBe('unavailable')
  h.controller.retry('a'); await settled(); expect(h.controller.presentations()[0]!.status).toBe('ready')
  h.failRenderer(); await settled(); expect(h.controller.presentations()[0]!.status).toBe('unavailable')
  h.controller.retry('a'); await settled(); expect(h.controller.presentations()[0]!.status).toBe('ready'); expect(h.errors.map(error => error.message)).toEqual(['Preparation rejected', 'Renderer rejected']); h.controller.destroy()
})

test('Map Plan reveals legible layouts and an explicit Canvas collection shares detailed Plan geometry', async () => {
  const values = Array.from({ length: 17 }, (_, index) => ({ ...scene(`unit:${index}`), anchor: [index * .00001, 0] as [number, number] }))
  const map = harness('map'); map.controller.setSources(values.map(map.source)); await settled(); expect(map.entries()).toHaveLength(17); expect(map.entries().every(entry => entry.view.mode === '2d' && entry.view.levelId === 'lower')).toBe(true)
  map.controller.selectScope('unit:8', 'a'); expect(map.entries().map(entry => entry.scene.id)).toEqual(['unit:8']); map.controller.fitAll(); expect(map.entries()).toHaveLength(17); map.controller.destroy()
  const canvas = harness('canvas'); canvas.controller.setSources(values.map(canvas.source)); await settled(); expect(canvas.prepares()).toBe(1); expect(canvas.entries()).toHaveLength(17)
  canvas.controller.selectScope('unit:8', 'a'); await settled(); expect(canvas.entries().map(entry => entry.scene.id)).toEqual(['unit:8']); canvas.controller.destroy()
})

test('regional overview error alone cannot load interiors; access-scale legibility restores zoom reveal and missing scale remains manual', async () => {
  const h = harness('map'), value = { ...scene('a'), bounds: { min: [0, 0, 0] as [number, number, number], max: [1000, 1000, 8] as [number, number, number] } }; h.scale(1_000); h.controller.setSources([h.source(value)]); await settled(); expect(h.controller.scene('a')).toBeNull(); expect(h.prepares()).toBe(0)
  h.scale(200_000); h.controller.fitAll(); await settled(); expect(h.controller.presentations()[0]!.status).toBe('ready'); h.controller.destroy()
  const manual = harness('map'), source = manual.source(scene('a')); const { inspectionFeatureMetres: _, ...descriptor } = source.descriptor; manual.controller.setSources([{ ...source, descriptor }]); await settled(); expect(manual.prepares()).toBe(0)
  manual.controller.selectScope('a'); await settled(); expect(manual.controller.presentations()[0]!.status).toBe('ready'); manual.controller.destroy()
})

test('sources without an explicit reusable geometry key remain private to each host controller', async () => {
  const a = harness('map'), b = harness('map'), value = scene('a')
  for (const h of [a, b]) { const source = h.source(value), { geometryKey: _, ...descriptor } = source.descriptor; h.controller.setSources([{ ...source, descriptor }]) }; await settled()
  expect(a.entries()[0]!.asset!.identity).not.toBe(b.entries()[0]!.asset!.identity); a.controller.destroy(); b.controller.destroy()
})

test('the core Plan transition cancels Orbit and restores ground-level top view for non-UI callers', async () => {
  const h = harness(), value = scene('a'); h.controller.setSources([h.source(value)]); h.controller.setView('a', { ...defaultPhysicalSceneView(value.levels), mode: '3d' }); await settled()
  h.controller.setNavigationTool('orbit'); h.controller.setView('a', defaultPhysicalSceneView(value.levels)); expect(h.tools.at(-1)).toBe('pan'); expect(h.poses.at(-1)).toEqual({ pitch: 0, elevation: 0, bearing: 0 }); h.controller.destroy()
})

test('Plan entry aligns the selected drawing to its authored placement rather than inheriting an oblique Home bearing', async () => {
  const h = harness(), value = { ...scene('a'), bearing: 37 }
  h.controller.setSources([h.source(value)]); h.controller.setView('a', { ...defaultPhysicalSceneView(value.levels), mode: '3d' }); await settled()
  h.controller.selectScope('a', 'a'); h.controller.setView('a', defaultPhysicalSceneView(value.levels))
  expect(h.poses.at(-1)).toEqual({ pitch: 0, elevation: 0, bearing: 37 }); h.controller.destroy()
})

test('hiding a first coplanar owner reveals the retained alternative for exact picking without re-preparing buffers', async () => {
  const h = harness(), value = scene('a'), positions = [-.8,-.8,0,.8,-.8,0,.8,.8,0,-.8,-.8,0,.8,.8,0,-.8,.8,0]
  value.objects = value.objects.map((object, index) => ({ ...object, positions, levelId: 'site', ...(index === 0 ? { layerId: 'utilities' } : { layerId: undefined }) }))
  h.controller.setSources([h.source(value)]); const view = { ...defaultPhysicalSceneView(value.levels), mode: '3d' as const, levelId: 'all' }; h.controller.setView('a', view); await settled()
  const matrix = new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]), target = () => pickPhysicalMesh([{ sceneId: 'a', meshes: h.entries()[0]!.meshes, matrix }], {x:400,y:300}, 800,600)?.mesh.object.id
  expect(target()).toBe('machine'); const before = h.prepares(), buffers = h.entries()[0]!.asset!.buffers
  h.controller.setView('a', { ...view, hiddenLayerIds: ['utilities'] }); expect(target()).toBe('utility'); expect(h.prepares()).toBe(before); expect(h.entries()[0]!.asset!.buffers).toBe(buffers)
  h.controller.setView('a', view); expect(target()).toBe('machine'); h.controller.selectScope('a','b'); expect(target()).toBe('utility'); h.controller.destroy()
})
