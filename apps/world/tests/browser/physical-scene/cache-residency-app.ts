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
declare global { interface Window { cacheResidencyProbe: { run: () => Promise<unknown> } } }
window.cacheResidencyProbe = { async run() {
  await loaded; mapElement.hidden = true; canvas.hidden = false
  const controller = createPhysicalCanvasController({ canvas, palette, onChange() {}, reportError: error => errors.push(error.message) })
  const phases: any[] = []
  const record = (name: string, value: Controller) => { const result = { name, inventory: inventory(value), metrics: nowMetrics(value) }; phases.push(result); return result }
  const forceGc = async () => { await tick(); if (typeof (globalThis as any).gc !== 'function') throw Error('Forced GC is unavailable'); (globalThis as any).gc(); await tick() }
  const unit = sources.find(source => source.descriptor.id === 'layout:halden-1')!, owner2 = sources.find(source => source.descriptor.id === 'layout:halden-2')!
  controller.setSources(sources); initialView(controller); await ready(controller); record('site-five-ready', controller)
  controller.focus(unit.descriptor.id, { scopeId: 'building/turbine-hall', preservePose: false }); await ready(controller)
  const change = async (mode: '2d' | '3d', levelId: string) => { const view = controller.presentations().find(value => value.descriptor.id === unit.descriptor.id)!.view; controller.setView(unit.descriptor.id, { ...view, mode, levelId }); await ready(controller) }
  await change('3d', 'operating'); record('first-operating3d', controller)
  await change('3d', 'all'); record('stack-before-gc', controller); await forceGc(); record('stack-after-gc', controller)
  const before3d = nowMetrics(controller); await change('3d', 'operating'); const after3d = record('return-operating3d', controller)
  await change('2d', 'operating'); record('first-operating-plan', controller)
  await change('2d', 'lower'); record('lower-plan-before-gc', controller); await forceGc(); record('lower-plan-after-gc', controller)
  const beforePlan = nowMetrics(controller); await change('2d', 'operating'); const afterPlan = record('return-operating-plan', controller)
  // Explicitly inspect the second actual owner; shared geometry must never reuse
  // the first owner's target or binding when its CPU asset is rebound.
  controller.setActive(false); mapElement.hidden = false; canvas.hidden = true; map.resize()
  const mapController = createPhysicalSceneController({ map, palette, beforeId: () => undefined, onChange() {}, reportError: error => errors.push(error.message) })
  mapController.setSources([owner2]); const entry = mapController.presentations()[0]!; mapController.setView(owner2.descriptor.id, { ...entry.view, mode: '2d', levelId: 'operating', cutaway: true }); mapController.focus(owner2.descriptor.id, { scopeId: 'building/turbine-hall', preservePose: false }); await ready(mapController); record('second-owner', mapController)
  const point = mapController.cheapProject(owner2.descriptor.id, 'tg-hp', 'operating'), ownerHit = point ? mapController.pick(point) : null
  const expected = data.scenes.find(scene => scene.id === owner2.descriptor.id)!.objects.find(object => object.id === 'tg-hp')!
  const ownerCorrect = ownerHit?.sceneId === owner2.descriptor.id && ownerHit.targetObjectId === owner2.descriptor.targetObjectId && ownerHit.occurrenceId === expected.id && JSON.stringify(ownerHit.subjectIds) === JSON.stringify(expected.subjectIds)
  controller.destroy(); await forceGc(); record('first-owner-closed', mapController)
  mapController.destroy(); await forceGc(); const closed = { canvas: nowMetrics(controller), map: nowMetrics(mapController) }
  cancelAnimationFrame(raf)
  const pool = closed.map.preparation!, disposed = [...closed.canvas.disposals, ...closed.map.disposals]
  const reuse = [{ name: '3d', before: before3d, after: after3d.metrics }, { name: 'plan', before: beforePlan, after: afterPlan.metrics }].map(value => ({ name: value.name, geometryUploadsDelta: value.after.current!.geometryUploads - value.before.current!.geometryUploads, viewRequestsDelta: value.after.preparation!.viewRequests - value.before.preparation!.viewRequests }))
  const reuseCorrect = reuse.every(value => value.geometryUploadsDelta > 0 || value.viewRequestsDelta === 0)
  const passed = reuseCorrect && errors.length === 0 && ownerCorrect && pool.clients === 0 && pool.registeredSources === 0 && pool.leases === 0 && pool.inFlightJobs === 0 && pool.queuedViews === 0 && !pool.workerAlive && pool.retainedViews === 0 && disposed.every(value => value.geometryBytes === 0 && value.residentCpuBytes === 0 && value.liveBuffersAfterDisposal === 0 && value.liveProgramsAfterDisposal === 0 && value.liveTexturesAfterDisposal === 0)
  return { passed, reuse, phases, ownerHit, ownerCorrect, return3d: { before: before3d, after: after3d.metrics }, returnPlan: { before: beforePlan, after: afterPlan.metrics }, closed, errors, limits: ['Actual admitted five-layout fixture and real canvas/map ports with module worker. This is a bounded lifetime test, not a new product timing claim.', 'Two real frame boundaries bracket forced GC so diagnostics cannot pin WeakRef referents during the collection.', 'Typed CPU byte figures exclude source arrays and JS metadata. Shared per-host assets must not be summed as distinct physical memory.', 'A returned variant may legitimately prepare/upload again after measured GPU eviction; only surviving resident variants promise CPU reuse.'] }
} }
