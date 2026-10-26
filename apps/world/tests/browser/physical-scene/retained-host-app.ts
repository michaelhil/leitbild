import { Map, setWorkerUrl } from 'maplibre-gl'
import { createPhysicalSceneController } from '../../../src/ui/map/physical-scene/controller.ts'
import { createPhysicalCanvasController } from '../../../src/ui/map/physical-scene/canvas-controller.ts'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor } from '../../../src/core/packs/scene.ts'
import type { PhysicalScenePalette } from '../../../src/ui/map/physical-scene/types.ts'
import { createPhysicalAnnotationScheduler } from '../../../src/ui/physical-layout/annotation-scheduler.ts'

setWorkerUrl('/worker.mjs')
const data = await (await fetch('/fixtures.json')).json() as { scenes: PackPhysicalScene[]; descriptors: PackPhysicalSceneDescriptor[] }
const workerJobs: { key: string; ms: number }[] = []
const workerPost = Worker.prototype.postMessage
Worker.prototype.postMessage = function (...args: any[]) { const start = performance.now(); const result = Reflect.apply(workerPost, this, args); if (args[0]?.scene && typeof args[0]?.key === 'string') workerJobs.push({ key: args[0].key, ms: performance.now() - start }); return result }
const errors: string[] = [], longTasks: number[] = [], frameTimes: number[] = [], taskEntries: { start: number; duration: number }[] = [], glCalls: { method: string; start: number; ms: number; bytes: number }[] = []
for (const method of ['bufferData', 'texImage2D', 'texSubImage2D', 'drawArraysInstanced'] as const) {
  const original = WebGL2RenderingContext.prototype[method]
  ;(WebGL2RenderingContext.prototype as any)[method] = function (...args: any[]) { const start = performance.now(); try { return Reflect.apply(original, this, args) } finally { const value = method === 'bufferData' ? args[1] : args.at(-1); glCalls.push({ method, start, ms: performance.now() - start, bytes: ArrayBuffer.isView(value) ? value.byteLength : 0 }) } }
}
new PerformanceObserver(list => { for (const entry of list.getEntries()) { longTasks.push(entry.duration); taskEntries.push({ start: entry.startTime, duration: entry.duration }) } }).observe({ type: 'longtask', buffered: true })
let raf = 0, previous = 0, recording = false
const monitor = (time: number) => { if (recording && previous) frameTimes.push(time - previous); previous = time; raf = requestAnimationFrame(monitor) }; raf = requestAnimationFrame(monitor)
const palette: PhysicalScenePalette = { materials: { background: [.9, .92, .9], wall: [.65, .67, .66], floor: [.85, .85, .82], metal: [.35, .42, .44], equipment: [.25, .42, .34], pipe: [.5, .58, .58], door: [.23, .45, .65], glass: [.75, .83, .85], context: [.7, .72, .67] }, defaultMaterial: [.5, .55, .55], line: [.2, .22, .22], lineOpacity: .26, contextLineOpacity: .1 }
const mapElement = document.getElementById('map')!, canvas = document.getElementById('canvas') as HTMLCanvasElement
const map = new Map({ container: mapElement, style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e6e9df' } }] }, center: data.descriptors[0]!.anchor, zoom: 16.7, pitch: 50, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true } })
const loaded = new Promise<void>(resolve => map.once('load', () => resolve()))
type Controller = ReturnType<typeof createPhysicalSceneController>
const sources = data.descriptors.map(descriptor => ({ descriptor, load: async () => data.scenes.find(scene => scene.id === descriptor.id)! }))
const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { n: values.length, median: sorted[Math.floor(sorted.length / 2)] ?? null, p95: sorted[Math.floor(sorted.length * .95)] ?? null, max: sorted.at(-1) ?? null } }
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const wait = async (test: () => boolean) => { const start = performance.now(); while (!test()) { if (errors.length) throw Error(errors.join('; ')); if (performance.now() - start > 90_000) throw Error('Host probe did not become ready'); await tick() } }
const inventory = (controller: Controller) => controller.presentations().map(value => ({ id:value.descriptor.id,status:value.status,view:value.view,occurrences:value.occurrenceCount }))
const ready = async (controller: Controller) => { await wait(() => { const values=controller.presentations(); if(values.some(value=>value.status==='unavailable'))throw Error('Unavailable source: '+JSON.stringify(inventory(controller))); return values.every(value=>value.status==='ready'||value.status==='distant'||value.status==='hidden')&&values.some(value=>value.status==='ready')&&controller.diagnostics().loadingScenes===0&&Boolean(controller.metrics()?.geometryUploads) }); await new Promise<void>(resolve => { const remove=controller.surface.on('render',()=>{remove();resolve()});if(controller.surface.kind==='map')map.triggerRepaint();else controller.turnBy(0) }) }
const initialView = (controller: Controller) => { for (const source of sources) { const p = controller.presentations().find(value => value.descriptor.id === source.descriptor.id)!; controller.setView(source.descriptor.id, { ...p.view, mode: '3d', levelId: 'all', cutaway: true }) }; controller.fitAll() }
const nowMetrics = (controller: Controller) => structuredClone(controller.diagnostics())
const phase = async (controller: Controller, name: string, moving: boolean, status: boolean) => {
  frameTimes.length = 0; longTasks.length = 0; recording = true; previous = 0; const started = performance.now(), before = nowMetrics(controller), beforeInventory=inventory(controller), exact: number[] = [], cheap: number[] = []
  for (let frame = 0; frame < 100; frame++) {
    if (moving) controller.turnBy(.15)
    if (status) for (const source of sources) controller.setStatus(source.descriptor.id, new globalThis.Map(source.descriptor.subjectIds.map(id => [id, { color: frame % 2 ? [.8, .1, .05] as const : [.1, .5, .3] as const, emphasis: .5 }])))
    if (moving || status) {
      const candidates: { sceneId: string; id: string; point: { x: number; y: number } }[] = [], start = performance.now()
      for (const scene of data.scenes) for (const object of scene.objects) if (object.subjectIds.length) { const point = controller.cheapProject(scene.id, object.id); if (point?.visible) candidates.push({ sceneId: scene.id, id: object.id, point }) }
      cheap.push(performance.now() - start)
      // Actual screen-space packing is a geometric admission rule, never a candidate cap.
      const packed: typeof candidates = []
      for (const candidate of candidates) if (!packed.some(prior => Math.abs(prior.point.x - candidate.point.x) < 44 && Math.abs(prior.point.y - candidate.point.y) < 44)) packed.push(candidate)
      const at = performance.now(); for (const candidate of packed) controller.visibleAt(candidate.sceneId, candidate.id, candidate.point); exact.push(performance.now() - at)
    }
    await tick()
  }
  recording = false; return { name, beforeInventory, afterInventory:inventory(controller), ms: performance.now() - started, before, after: nowMetrics(controller), raf: stats(frameTimes), longTasks: taskEntries.filter(entry => entry.start >= started).map(entry => entry.duration), cheapRosterMs: stats(cheap), packedOcclusionMs: stats(exact) }
}
declare global { interface Window { retainedProbe: { run: () => Promise<unknown> } } }
window.retainedProbe = { async run() {
  await loaded; const dimensions = () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })
  const mapController = createPhysicalSceneController({ map, palette, beforeId: () => undefined, onChange() {}, reportError: error => errors.push(error.message) })
  const started = performance.now(); mapController.setSources(sources); initialView(mapController); mapController.focus(sources[0]!.descriptor.id,{preservePose:false}); await ready(mapController); const cold = { workload:inventory(mapController),intent:'Explicit unit inspection through the same focus port as UI',ms: performance.now() - started, diagnostics: nowMetrics(mapController), glCalls: glCalls.filter(call => call.start >= started), longTasks: taskEntries.filter(entry => entry.start >= started).map(entry => entry.duration) }
  const phases = [await phase(mapController, 'map-idle', false, false), await phase(mapController, 'map-moving-paused', true, false), await phase(mapController, 'map-moving-status', true, true)]
  const beforePalette = nowMetrics(mapController); mapController.setPalette({ ...palette, lineOpacity: .24 }); await tick(); const afterPalette = nowMetrics(mapController)
  mapController.setActive(false); if (typeof (globalThis as any).gc !== 'function') throw Error('Probe GC control unavailable'); (globalThis as any).gc(); const sharedCompileBeforeCanvas = [...workerJobs]; const suspended = nowMetrics(mapController); mapElement.hidden = true; canvas.hidden = false
  const canvasController = createPhysicalCanvasController({ canvas, palette, onChange() {}, reportError: error => errors.push(error.message) })
  const canvasStart = performance.now(); canvasController.setSources(sources); initialView(canvasController); await ready(canvasController); const canvasCold = { workload:inventory(canvasController),intent:'Explicit full-site3D collection',workerJobsAfter: [...workerJobs], ms: performance.now() - canvasStart, diagnostics: nowMetrics(canvasController), glCalls: glCalls.filter(call => call.start >= canvasStart), longTasks: taskEntries.filter(entry => entry.start >= canvasStart).map(entry => entry.duration) }
  phases.push(await phase(canvasController, 'canvas-idle', false, false), await phase(canvasController, 'canvas-moving-paused', true, false), await phase(canvasController, 'canvas-moving-status', true, true))
  const viewCycles = []
  for (const level of data.descriptors[0]!.levels) { const first = canvasController.presentations()[0]!; canvasController.setView(first.descriptor.id, { ...first.view, levelId: level.id }); await ready(canvasController); viewCycles.push({ level: level.id, diagnostics: nowMetrics(canvasController), glCalls: glCalls.filter(call => call.start >= canvasStart), longTasks: taskEntries.filter(entry => entry.start >= canvasStart).map(entry => entry.duration) }) }
  const first = canvasController.presentations()[0]!; canvasController.setView(first.descriptor.id, { ...first.view, levelId: 'all', separation: 4 }); await ready(canvasController); const separateBase = nowMetrics(canvasController)
  for (let value = 1; value <= 50; value++) { canvasController.setView(first.descriptor.id, { ...canvasController.presentations()[0]!.view, separation: value }); await tick() }
  const separateEnd = nowMetrics(canvasController)
  const statusRoster = data.scenes.flatMap(scene => scene.objects.filter(object => object.subjectIds.length).flatMap(object => { const point = canvasController.cheapProject(scene.id, object.id); return point?.visible ? [{ key: `${scene.id}/${object.id}`, priority: 0, value: { sceneId: scene.id, occurrenceId: object.id, point } }] : [] }))
  let scheduling: { total: number; pending: number; visible: readonly unknown[] } = { total: 0, pending: 1, visible: [] }
  const schedulerStart = performance.now(), scheduler = createPhysicalAnnotationScheduler<{ sceneId: string; occurrenceId: string; point: { x: number; y: number } }>({ test: value => canvasController.visibleAt(value.sceneId, value.occurrenceId, value.point), onChange: value => { scheduling = value } })
  scheduler.update('fixed-camera', statusRoster); await wait(() => scheduling.pending === 0); const schedulerReceipt = { ms: performance.now() - schedulerStart, total: scheduling.total, visible: scheduling.visible.length }; scheduler.destroy()
  canvasController.destroy(); mapController.destroy(); cancelAnimationFrame(raf)
  const gl = canvas.getContext('webgl2')!, debug = gl.getExtension('WEBGL_debug_renderer_info')
  const profile = { userAgent: navigator.userAgent, renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), hardwareConcurrency: navigator.hardwareConcurrency }
  const result = { profile, workerJobs, sharedCompileBeforeCanvas, gcBeforeCanvas: true, diagnosticGlInstrumentation: true, dimensions: dimensions(), sources: data.scenes.map(scene => ({ id: scene.id, occurrences: scene.objects.length })), cold, canvasCold, phases, palette: { before: beforePalette, after: afterPalette }, suspended, viewCycles, separation: { before: separateBase, after: separateEnd }, scheduler: schedulerReceipt, disposals: { map: nowMetrics(mapController), canvas: nowMetrics(canvasController) }, errors, limits: ['Engine ports and real module worker, MapLibre GL and dedicated canvas, cached admitted delivery fixtures. Full Svelte/OperationalMap and transport/playing runtime are separate qualification.', 'Status phase changes presentation values for draw invalidation; it does not claim actual Run playback.', 'Cold timers begin after cached admitted fixture delivery JSON is parsed; source worker/network lifecycle is not measured here.', 'Map workload is explicit unit inspection with other sources allowed to remain policy-distant; Canvas is explicit full-site3D. Inventories accompany every phase.', 'All in-frustum bound candidates enter deadline scheduling; 44 CSS pixels is target geometry in the packing diagnostic, not a count cap.'] }
  document.getElementById('status')!.textContent = 'Retained host probe complete'; return result
} }
