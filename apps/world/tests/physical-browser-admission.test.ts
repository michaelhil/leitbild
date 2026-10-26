import { expect, test } from 'bun:test'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor } from '../src/core/packs/scene.ts'
import { createPhysicalSceneControllerForViewport } from '../src/ui/map/physical-scene/scene-controller.ts'
import { preparePhysicalGeometry } from '../src/ui/map/physical-scene/preparation.ts'
import type { PhysicalViewport } from '../src/ui/map/physical-scene/viewport.ts'

const source = (id: string): PackPhysicalScene => ({
  id, targetObjectId: `owner:${id}`, revision: 'retained', anchor: [0, 0], bearing: 0,
  bounds: { min: [0, 0, 0], max: [1, 1, 1] }, levels: [{ id: 'ground', label: 'Ground', elevation: 0, cutHeight: 2 }],
  objects: [{ id: 'equipment', label: 'Equipment', kind: 'equipment', levelId: 'ground', subjectIds: ['pump'], positions: [0, 0, 0, 1, 0, 0, 0, 1, 1] }],
})
const descriptor = (scene: PackPhysicalScene): PackPhysicalSceneDescriptor => ({ ...scene, locationValid: true, subjectIds: ['pump'], modelDigest: 'exact', inspectionFeatureMetres: 1, overviewGeometricErrorMetres: 1 })
/** Lifecycle-only viewport double. Real painting is qualified in the browser. */
const viewport = (kind: 'map' | 'canvas', visible = true): PhysicalViewport => ({
  surface: { kind, element: new EventTarget() as HTMLElement, getSize: () => ({ width: 1000, height: 700 }), getPadding: () => ({ top: 0, right: 0, bottom: 0, left: 0 }), on: () => () => {} },
  on: () => () => {}, ready: () => false, intersectsBounds: () => visible,
  // An inspection feature is deliberately below automatic legibility here.
  projectGeographic: point => ({ x: point.lng, y: point.lat }), requestRender() {},
  installRenderer() { throw Error('This lifecycle double must not install a renderer') },
  registered: () => false, orderRenderer() {}, removeRenderer() {},
  cameraPose: () => ({ center: [0, 0], pitch: 0, bearing: 0, zoom: 0, revision: 0 }), setPose() {}, fitWorld() {}, panBy() {}, setNavigationTool() {}, cancelCamera() {}, destroy() {},
})
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const create = (kind: 'map' | 'canvas', visible = true) => createPhysicalSceneControllerForViewport(viewport(kind, visible), {
  palette: { materials: {}, defaultMaterial: [.5, .5, .5], line: [.2, .2, .2] },
  prepare: async (scene, view, key, identity) => preparePhysicalGeometry(scene, view, key, identity),
  onChange() {}, reportError(error) { throw error },
})

test('site Plan in the dedicated browser acquires detailed layouts without an arbitrary zoom/count threshold', async () => {
  const scenes = [source('unit:a'), source('unit:b'), source('campus')], loaded: string[] = [], controller = create('canvas')
  controller.setSources(scenes.map(scene => ({ descriptor: descriptor(scene), load: async () => { loaded.push(scene.id); return scene } })))
  controller.fitAll(scenes.map(scene => scene.id)); await settle()
  expect(loaded).toEqual(scenes.map(scene => scene.id))
  expect(controller.presentations().map(scene => [scene.view.mode, scene.status])).toEqual(scenes.map(() => ['2d', 'ready']))
  controller.destroy()
})

test('regional map stays automatic while an explicit layout focus acquires detail', async () => {
  const scene = source('unit:a'), controller = create('map'); let loads = 0
  controller.setSources([{ descriptor: descriptor(scene), load: async () => { loads++; return scene } }]); await settle()
  expect(loads).toBe(0); expect(controller.presentations()[0]!.status).toBe('distant')
  controller.selectScope(scene.id); await settle()
  expect(loads).toBe(1); expect(controller.presentations()[0]!.status).toBe('ready')
  controller.destroy()
})

test('explicit browser purpose still respects visibility, hidden detail and inactive hosts', async () => {
  const scene = source('unit:a'), offscreen = create('canvas', false); let loads = 0
  const sources = [{ descriptor: descriptor(scene), load: async () => { loads++; return scene } }]
  offscreen.setSources(sources); await settle(); expect(loads).toBe(0); offscreen.destroy()
  const inactive = create('canvas'); inactive.setActive(false); inactive.setSources(sources); await settle(); expect(loads).toBe(0)
  inactive.setView(scene.id, { ...inactive.presentations()[0]!.view, detail: 'hidden' }); inactive.setActive(true); await settle()
  expect(loads).toBe(0); expect(inactive.presentations()[0]!.status).toBe('hidden'); inactive.destroy()
})
