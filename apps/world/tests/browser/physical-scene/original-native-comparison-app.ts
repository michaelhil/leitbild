import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor } from '../../../src/core/packs/scene.ts'
import { createPhysicalSceneController } from '../../../src/ui/map/physical-scene/controller.ts'
import { physicalLayoutPalette } from '../../../src/ui/physical-layout/palette.ts'
import { defaultPhysicalSceneView } from '../../../src/ui/map/physical-scene/types.ts'
import { preparePhysicalGeometry } from '../../../src/ui/map/physical-scene/preparation.ts'
import { createPhysicalBackend } from '../../../src/ui/map/physical-scene/backend.ts'
import { buildScene } from '../../../../../experiments/physical-layout-trials/render/src/reference/scene.ts'
import { createRenderer as originalRenderer, homeCamera } from './original-reference-renderer.ts'

// A visual qualification fixture, not a second product host. The right panel
// uses the native MapLibre camera/controller. No reflected reference matrix is
// supplied to either renderer. Camera poses and viewport sizes are in receipts.
setWorkerUrl('/worker.mjs')
const { scene, descriptor } = await (await fetch('/fixtures.json')).json() as { scene: PackPhysicalScene; descriptor: PackPhysicalSceneDescriptor }
const originalCanvas = document.querySelector<HTMLCanvasElement>('#original')!, mapElement = document.querySelector<HTMLElement>('#map')!, errors: string[] = []
const original = originalRenderer(originalCanvas), reference = buildScene()
const map = new MapLibreMap({ container: mapElement, style: { version: 8, sources: {}, layers: [{ id: 'ground', type: 'background', paint: { 'background-color': '#ecefe7' } }] }, center: descriptor.anchor, zoom: 16, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true } })
const loaded = new Promise<void>(resolve => map.once('load', () => resolve()))
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
let ready = false
const controller = createPhysicalSceneController({ map, palette: physicalLayoutPalette(mapElement), beforeId: () => undefined, fitPadding: () => ({ top: 24, left: 24, right: 24, bottom: 24 }), onChange: values => { ready = values[0]?.status === 'ready' }, reportError: error => errors.push(error.message) })
controller.setSources([{ descriptor, load: async () => scene }])
type Mode = 'all' | 'operating' | 'lower'
const actualPixels = (): Uint8Array => {
  const gl = map.getCanvas().getContext('webgl2')!, pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  return pixels
}
const waitReady = async () => {
  const started = performance.now()
  while (!ready || !controller.metrics()?.geometryUploads) {
    if (errors.length || performance.now() - started > 30_000) throw Error(JSON.stringify({ ready, errors }))
    await frames()
  }
  await frames()
}
;(window as any).originalNativeComparison = {
  async phase(mode: Mode, status = false) {
    await loaded
    const camera = homeCamera()
    if (mode === 'operating') Object.assign(camera, { target: [44, 18, 18], distance: 120, azimuth: -.65, elevation: .65 })
    if (mode === 'lower') Object.assign(camera, { target: [44, 5, 25], distance: 121, azimuth: -.7, elevation: .7 })
    original.draw(reference, { mode, walls: 'cutaway', utilities: true, service: true, crane: true, explode: 0 }, camera, null)
    const view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const, levelId: mode, live: true, hiddenLayerIds: scene.layers?.filter(layer => !layer.defaultVisible && layer.id !== 'utility-routes' && layer.id !== 'plan-allowances').map(layer => layer.id) ?? [] }
    controller.setView(scene.id, view)
    controller.setStatus(scene.id, new Map())
    controller.home(scene.id, 'area/turbine-island')
    await waitReady()
    controller.home(scene.id, 'area/turbine-island'); await frames()
    const before = actualPixels(), uploads = controller.metrics()!.geometryUploads
    controller.setStatus(scene.id, new Map(descriptor.subjectIds.map(id => [id, { color: [.91, .17, .2] as const, emphasis: .65 }])))
    await frames()
    const after = actualPixels()
    let changedPixels = 0, unchangedPixels = 0
    for (let at = 0; at < before.length; at += 4) {
      if (before[at] !== after[at] || before[at + 1] !== after[at + 1] || before[at + 2] !== after[at + 2]) changedPixels++
      else unchangedPixels++
    }
    // Leave the requested visual state on screen after the controlled probe.
    controller.setStatus(scene.id, new Map(status ? descriptor.subjectIds.map(id => [id, { color: [.91, .17, .2] as const, emphasis: .65 }]) : [])); await frames()
    const pose = controller.cameraPose(), size = mapElement.getBoundingClientRect(), originalSize = originalCanvas.getBoundingClientRect()
    document.querySelector('#native-caption')!.textContent = `Native MapLibre camera · ${mode} · bearing ${pose.bearing.toFixed(2)}° · pitch ${pose.pitch.toFixed(2)}° · source ${scene.revision.slice(0, 12)}${status ? ' · controlled alarm contour input' : ''}`
    return { mode, status, errors, originalCamera: camera, nativeCamera: pose, originalViewport: { width: originalSize.width, height: originalSize.height }, nativeViewport: { width: size.width, height: size.height }, nativeMetrics: controller.metrics(), statusWitness: { changedPixels, unchangedPixels, geometryUploadsBefore: uploads, geometryUploadsAfter: controller.metrics()!.geometryUploads }, note: 'The original uses its actual per-level natural camera. Native uses the admitted scope Home and real MapLibre camera. Poses are recorded rather than assumed equal; no reflected comparison matrix is supplied. Status is controlled fixture input, never live plant evidence. The technical pass does not certify visual parity.' }
  },
  statusContours() {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })!
    const positions = [-.8, -.7, 0, .8, -.7, 0, 0, .8, 0]
    const source: PackPhysicalScene = { id: 'test', revision: 'test', targetObjectId: 'test-owner', anchor: [0, 0], bearing: 0, bounds: { min: [-.8, -.7, 0], max: [.8, .8, 0] }, levels: [{ id: 'floor', label: 'Floor', elevation: 0, cutHeight: 1 }], objects: [{ id: 'machine', label: 'Controlled contour witness', kind: 'equipment', levelId: 'floor', positions, subjectIds: ['test-subject'], materials: ['machine'], featureLines: [{ positions: [-.8, -.7, 0, .8, -.7, 0, .8, -.7, 0, 0, .8, 0, 0, .8, 0, -.8, -.7, 0], material: 'line' }], edgePolicy: 'authored' }] }
    const palette = { defaultMaterial: [.4, .65, .5] as const, materials: { machine: [.4, .65, .5] as const }, line: [.2, .3, .2] as const, lineOpacity: .26 }
    const results = []
    for (const mode of ['2d', '3d'] as const) {
      const backend = createPhysicalBackend(gl, palette), view = { ...defaultPhysicalSceneView(source.levels), mode }, asset = preparePhysicalGeometry(source, view, mode, mode), matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1])
      const draw = (alert: boolean) => {
        gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(1, 1, 1, 1); gl.clearDepth(0); gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
        backend.draw([{ asset, matrix, flat: mode === '2d', meshes: asset.meshes, styles: asset.meshes.map(() => alert ? { color: [.9, .1, .2], emphasis: .65 } : null) }])
        const pixels = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        return pixels
      }
      const before = draw(false), uploads = backend.metrics.geometryUploads, after = draw(true)
      let changedContours = 0, preservedInterior = 0, changedInterior = 0
      for (let at = 0; at < before.length; at += 4) {
        const changed = before[at] !== after[at] || before[at + 1] !== after[at + 1] || before[at + 2] !== after[at + 2]
        if (changed) changedContours++
        const pixel = at / 4, x = pixel % canvas.width, y = Math.floor(pixel / canvas.width)
        if (x >= 112 && x < 144 && y >= 112 && y < 144) changed ? changedInterior++ : preservedInterior++
      }
      const result = { mode, changedContours, preservedInterior, changedInterior, geometryUploadsBefore: uploads, geometryUploadsAfter: backend.metrics.geometryUploads, error: gl.getError() }
      gl.useProgram(null); backend.dispose(); results.push({ ...result, liveBuffers: backend.metrics.liveBuffersAfterDisposal, liveTextures: backend.metrics.liveTexturesAfterDisposal, livePrograms: backend.metrics.liveProgramsAfterDisposal })
    }
    return { results, passed: results.every(value => value.changedContours > 0 && value.preservedInterior === 1024 && value.changedInterior === 0 && value.geometryUploadsBefore === value.geometryUploadsAfter && value.error === 0 && value.liveBuffers === 0 && value.liveTextures === 0 && value.livePrograms === 0) }
  },
  finish() { controller.destroy(); map.remove(); return { errors } },
}
