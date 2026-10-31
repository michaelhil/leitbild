import { Map as MapLibreMap, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor } from '../../../src/core/packs/scene.ts'
import { createMapPhysicalViewport } from '../../../src/ui/map/physical-scene/map-viewport.ts'
import { createCanvasPhysicalViewport } from '../../../src/ui/map/physical-scene/canvas-viewport.ts'
import { createPhysicalSceneControllerForViewport } from '../../../src/ui/map/physical-scene/scene-controller.ts'
import { createPhysicalGeometryPreparer, type PhysicalGeometryPreparer, type PhysicalPreparedGeometry } from '../../../src/ui/map/physical-scene/preparation.ts'
import { visiblePhysicalInspectionBoundaries } from '../../../src/ui/map/physical-scene/inspection-cutaway.ts'
import { inverse, localMercatorMatrix, transform } from '../../../src/ui/map/physical-scene/math.ts'
import type { PhysicalViewport } from '../../../src/ui/map/physical-scene/viewport.ts'
import type { PhysicalScenePalette } from '../../../src/ui/map/physical-scene/types.ts'

setWorkerUrl('/worker.mjs')
const { scenes, descriptors } = await (await fetch('/fixtures.json')).json() as { scenes: PackPhysicalScene[]; descriptors: PackPhysicalSceneDescriptor[] }
const scene = scenes[0]!, descriptor = descriptors[0]!, errors: string[] = []
const mapElement = document.querySelector<HTMLElement>('#map')!, canvas = document.querySelector<HTMLCanvasElement>('#canvas')!
const map = new MapLibreMap({ container: mapElement, style: { version: 8, sources: {}, layers: [{ id: 'ground', type: 'background', paint: { 'background-color': '#cccccc' } }] }, center: descriptor.anchor, zoom: 16, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true } })
const loaded = new Promise<void>(resolve => map.once('load', () => resolve()))
const palette: PhysicalScenePalette = { materials: { wall: [.65, .67, .66], floor: [.85, .85, .82], steel: [.35, .42, .44], glass: [.75, .83, .85], background: [.8, .8, .8] }, defaultMaterial: [.3, .45, .35], line: [.2, .2, .2] }
const matrices = new WeakMap<WebGLBuffer, Float32Array>(), textures = new WeakMap<WebGLTexture, Float32Array>()
let drawMatrix: number[] | null = null, drawObjects: Float32Array | null = null, drawCount = 0, prepared: PhysicalPreparedGeometry | null = null
const proto = WebGL2RenderingContext.prototype, data = proto.bufferData, tex = proto.texImage2D, sub = proto.texSubImage2D, draw = proto.drawArraysInstanced
proto.bufferData = function(...args: any[]) { if (args[1] instanceof Float32Array && args[1].length === 17) matrices.set(this.getParameter(this.ARRAY_BUFFER_BINDING), new Float32Array(args[1])); return data.apply(this, args as never) }
proto.texImage2D = function(...args: any[]) { if (args[8] instanceof Float32Array) textures.set(this.getParameter(this.TEXTURE_BINDING_2D), new Float32Array(args[8])); return tex.apply(this, args as never) }
proto.texSubImage2D = function(...args: any[]) { if (args[8] instanceof Float32Array) textures.set(this.getParameter(this.TEXTURE_BINDING_2D), new Float32Array(args[8])); return sub.apply(this, args as never) }
proto.drawArraysInstanced = function(...args: any[]) {
  const matrix = matrices.get(this.getVertexAttrib(5, this.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING))
  const program = this.getParameter(this.CURRENT_PROGRAM), owned = program && this.getUniformLocation(program, 'uObjects')
  if (matrix && owned) {
    const active = this.getParameter(this.ACTIVE_TEXTURE); this.activeTexture(this.TEXTURE1); const table = textures.get(this.getParameter(this.TEXTURE_BINDING_2D)); this.activeTexture(active)
    if (table && prepared && table.length >= prepared.meshes.length * 12) { drawMatrix = [...matrix.slice(0, 16)]; drawObjects = table; drawCount++ }
  }
  return draw.apply(this, args as never)
}
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
let viewport: PhysicalViewport | null = null, controller: ReturnType<typeof createPhysicalSceneControllerForViewport> | null = null, state = ''
const walls = ['wall/hall-north', 'wall/hall-south', 'wall/hall-west', 'wall/hall-east']
const capture = () => {
  if (!drawMatrix || !drawObjects || !prepared || !viewport) throw Error('Actual physical draw did not provide its matrix/table')
  const matrix = drawMatrix, inv = inverse(matrix), eye = [inv[8]! / inv[11]!, inv[9]! / inv[11]!, inv[10]! / inv[11]!], selected = visiblePhysicalInspectionBoundaries(prepared.meshes, matrix), pose = viewport.cameraPose()
  const target = MercatorCoordinate.fromLngLat(pose.center as [number, number], pose.elevation), reference = transform(inverse(localMercatorMatrix(scene.anchor, scene.bearing)), [target.x, target.y, target.z])
  return { pose, matrix, eye, reference, walls: walls.map(id => {
    const object = scene.objects.find(object => object.id === id)!, n = object.inspectionBoundary!.outward, b = object.bounds!, center = b.min.map((value, axis) => (value + b.max[axis]!) / 2) as [number, number, number], p = reference
    // Independent facing oracle uses only forward projection of an oriented
    // wall tangent basis. It does not extract/invert a camera position.
    const a = transform(matrix, p), u = transform(matrix, [p[0] - n[1], p[1] + n[0], p[2]]), v = transform(matrix, [p[0], p[1], p[2] + 1])
    const area = (u[0] - a[0]) * (v[1] - a[1]) - (u[1] - a[1]) * (v[0] - a[0])
    const helper = [...new Set(selected.filter(mesh => mesh.object.id === id).map(mesh => mesh.inspectionPart))]
    const gpu = [...new Set(prepared!.meshes.filter((mesh, index) => mesh.object.id === id && drawObjects![index * 12 + 7]! > .5).map(mesh => mesh.inspectionPart))]
    return { id, outward: n, center, area, expected: area > 0 ? 'cut' : 'full', helper, gpu }
  }) }
}
;(window as any).cutawayCameraProbe = {
  debug() { return { state, errors, drawCount, hasMatrix: Boolean(drawMatrix), prepared: prepared?.meshes.length, objectWords: drawObjects?.length, pose: viewport?.cameraPose() } },
  async home() { controller!.home(scene.id, 'building/turbine-hall'); const before = drawCount; while (drawCount === before) { viewport!.requestRender(); await tick() }; return capture() },
  async phase(host: 'map' | 'canvas') {
    await loaded; controller?.destroy(); controller = null; mapElement.hidden = host !== 'map'; canvas.hidden = host !== 'canvas'; map.resize()
    viewport = host === 'map' ? createMapPhysicalViewport(map, () => undefined) : createCanvasPhysicalViewport(canvas)
    const base = createPhysicalGeometryPreparer(), prepare = Object.assign((...args: Parameters<PhysicalGeometryPreparer>) => base(...args).then(value => { if (args[4]?.endsWith('/detail')) prepared = value; return value }), { retainIdentities: base.retainIdentities, destroy: base.destroy, diagnostics: base.diagnostics }) as PhysicalGeometryPreparer
    controller = createPhysicalSceneControllerForViewport(viewport, { palette, prepare, onChange(value) { state = value[0]?.status ?? '' }, reportError(error) { errors.push(error.message) } })
    controller.setSources([{ descriptor, load: async () => scene }]); controller.setView(scene.id, { mode: '3d', levelId: 'all', cutaway: true, separation: 0, live: false, detail: 'auto' }); controller.home(scene.id, 'building/turbine-hall')
    const started = performance.now()
    while (state !== 'ready' || !prepared || !drawMatrix) { if (performance.now() - started > 30000 || errors.length) throw Error(JSON.stringify({ state, errors })); viewport.requestRender(); await tick() }
    controller.home(scene.id, 'building/turbine-hall'); for (let i = 0; i < 3; i++) { viewport.requestRender(); await tick() }
    const frames = [capture()]
    for (const bearing of [65, 155, 245]) { const before = drawCount, start = performance.now(); viewport.setPose({ bearing }); while (drawCount === before) { if (errors.length || performance.now() - start > 10000) throw Error(JSON.stringify({ stage: 'orbit', bearing, state, errors, drawCount })); viewport.requestRender(); await tick() }; frames.push(capture()) }
    return { host, frames, errors, metrics: controller.diagnostics() }
  },
  finish() { controller?.destroy(); map.remove(); return { errors } },
}
