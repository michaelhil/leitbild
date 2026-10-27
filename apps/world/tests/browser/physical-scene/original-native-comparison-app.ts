import { Map as MapLibreMap, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor } from '../../../src/core/packs/scene.ts'
import { createPhysicalSceneController } from '../../../src/ui/map/physical-scene/controller.ts'
import { physicalLayoutPalette } from '../../../src/ui/physical-layout/palette.ts'
import { defaultPhysicalSceneView } from '../../../src/ui/map/physical-scene/types.ts'
import { preparePhysicalGeometry } from '../../../src/ui/map/physical-scene/preparation.ts'
import { createPhysicalBackend } from '../../../src/ui/map/physical-scene/backend.ts'
import { createPhysicalSceneRenderer } from '../../../src/ui/map/physical-scene/renderer.ts'
import { inverse, localMercatorMatrix, multiply, transform } from '../../../src/ui/map/physical-scene/math.ts'
import { scopeRouteFixture } from '../../fixtures/physical-scope-route.ts'
import { lookAt, perspective } from '../../../../../experiments/physical-layout-trials/render/src/reference/math.ts'
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
  async capDetail(kind: 'scope' | 'floor') {
    await loaded
    const view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const, levelId: kind === 'floor' ? 'lower' : 'all', live: false, hiddenLayerIds: [] }
    controller.setView(scene.id, view); controller.setStatus(scene.id, new Map()); controller.home(scene.id, 'area/turbine-island'); await waitReady()
    const prepared = preparePhysicalGeometry(scene, { ...view, scopeId: 'area/turbine-island' }, 'actual-cap-detail', 'actual-cap-detail')
    const candidates = prepared.meshes.filter(mesh => mesh.object.clipToScope && mesh.materials?.some(role => role.startsWith('continuation/'))).flatMap(mesh => {
      const groups = new Map<string, { points: number[][]; normal: readonly [number, number, number] }>()
      for (let at = 0; at < mesh.vertices.length; at += 21) {
        const role = mesh.materials![mesh.vertices[at + 6]!]!
        if (!role.startsWith('continuation/')) continue
        const normal = [mesh.vertices[at + 3]!, mesh.vertices[at + 4]!, mesh.vertices[at + 5]!] as const
        if ((kind === 'floor') !== (Math.abs(normal[2]) === 1)) continue
        const axis = normal.findIndex(v => v !== 0), coordinate = mesh.vertices[at + axis]!, key = `${normal.join(',')}/${coordinate}`
        let group = groups.get(key); if (!group) { group = { points: [], normal }; groups.set(key, group) }
        for (const offset of [0, 7, 14]) group.points.push([mesh.vertices[at + offset]!, mesh.vertices[at + offset + 1]!, mesh.vertices[at + offset + 2]!])
      }
      return [...groups.values()].map(group => ({ object: mesh.object, normal: group.normal, center: [0, 1, 2].map(axis => (Math.min(...group.points.map(p => p[axis]!)) + Math.max(...group.points.map(p => p[axis]!))) / 2) as [number, number, number] }))
    }).sort((a, b) => b.object.spatialPath!.radius - a.object.spatialPath!.radius)
    const cap = candidates[0]; if (!cap) throw Error(`The admitted source has no actual ${kind} cap to inspect`)
    const world = transform(localMercatorMatrix(scene.anchor, scene.bearing), cap.center), mercator = new MercatorCoordinate(world[0], world[1], world[2]), radius = cap.object.spatialPath!.radius
    const zoom = Math.log2(128 / (radius * 2 * mercator.meterInMercatorCoordinateUnits() * 512)), bearing = Math.abs(cap.normal[2]) === 1 ? 0 : Math.atan2(-cap.normal[0], -cap.normal[1]) * 180 / Math.PI + scene.bearing
    map.setCenterClampedToGround(false); map.setCenterElevation(cap.center[2]); map.jumpTo({ center: mercator.toLngLat(), zoom, bearing, pitch: kind === 'floor' ? 0 : 55 }); await frames()
    document.querySelector('#native-caption')!.textContent = `Actual source ${kind} cut · ${cap.object.id} · graph ${cap.object.subjectIds.join(', ')}`
    return { kind, occurrenceId: cap.object.id, subjects: cap.object.subjectIds, sourceRevision: scene.revision, radius, center: cap.center, normal: cap.normal, camera: controller.cameraPose(), errors }
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
  scopeCaps() {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512
    const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true })!, route = scopeRouteFixture(), source: PackPhysicalScene = { id: 'controlled-layout', revision: 'controlled-fixture', targetObjectId: 'test-owner', anchor: [0, 0], bearing: 0, bounds: { min: [-5, -2, 0], max: [5, 2, 3] }, levels: [{ id: 'floor', label: 'Floor', elevation: 0, cutHeight: 1.2 }], objects: [route], scopes: [{ id: 'unit', label: 'Unit', kind: 'unit', levelIds: ['floor'], bounds: { min: [-5, -2, 0], max: [5, 2, 3] } }, { id: 'room', label: 'Room', kind: 'space', parentId: 'unit', levelIds: ['floor'], bounds: { min: [-1, -1, 0], max: [1, 1, 3] } }] }
    const view = { ...defaultPhysicalSceneView(source.levels), mode: '3d' as const, levelId: 'all', scopeId: 'room' }, asset = preparePhysicalGeometry(source, view, 'scope-cap', 'scope-cap'), errors: string[] = []
    const entry = { scene: source, view, asset, meshes: asset.meshes, status: new Map() }, renderer = createPhysicalSceneRenderer(gl, () => [entry], physicalLayoutPalette(mapElement), () => ({ width: 512, height: 512 }), error => errors.push(error.message)), placement = inverse(localMercatorMatrix(source.anchor, source.bearing))
    const pixel = (x: number, y: number) => { const data = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data); return [...data] }
    const observations: Array<{ plain: number[]; stripe: number[]; pick: string | undefined }> = []
    for (let phase = 0; phase < 16; phase++) {
      const dx = Math.sin(phase / 16 * Math.PI * 2) * .001, dy = Math.cos(phase / 16 * Math.PI * 2) * .001, matrix = multiply(perspective(Math.PI / 3, 1, .1, 100), lookAt([-5, dy, 1 + dx], [0, dy, 1 + dx], [0, 0, 1]))
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, 512, 512); gl.clearColor(1, 1, 1, 1); gl.clearDepth(1); gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      renderer.render(multiply(matrix, placement))
      const plain = transform(matrix, [-1, .125, 1]), stripe = transform(matrix, [-1, 0, 1]), plainX = Math.floor((plain[0] + 1) * 256), plainY = Math.floor((plain[1] + 1) * 256), stripeX = Math.floor((stripe[0] + 1) * 256), stripeY = Math.floor((stripe[1] + 1) * 256)
      observations.push({ plain: pixel(plainX, plainY), stripe: pixel(stripeX, stripeY), pick: renderer.pick({ x: plainX, y: 512 - plainY })?.subjectIds[0] })
    }
    const error = gl.getError(), image = canvas.toDataURL('image/png')
    renderer.dispose(); const metrics = renderer.metrics()
    return { image, observations, errors, metrics, error, materials: asset.buffers.roles, passed: errors.length === 0 && error === 0 && asset.buffers.roles.some(role => role.startsWith('continuation/pipe/')) && observations.every(value => value.pick === 'supply-edge' && value.plain.join(',') === observations[0]!.plain.join(',') && value.plain.join(',') !== value.stripe.join(',')) && metrics.liveBuffersAfterDisposal === 0 && metrics.liveProgramsAfterDisposal === 0 && metrics.liveTexturesAfterDisposal === 0 }
  },
  finish() { controller.destroy(); map.remove(); return { errors } },
}
