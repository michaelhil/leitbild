import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor } from '../../../src/core/packs/scene.ts'
import { createPhysicalSceneController, type PhysicalSceneController } from '../../../src/ui/map/physical-scene/controller.ts'
import { createPhysicalCanvasController } from '../../../src/ui/map/physical-scene/canvas-controller.ts'
import type { Color, PhysicalScenePalette } from '../../../src/ui/map/physical-scene/types.ts'
import { fullGlState, stateDifferences } from './gl-probes.ts'

setWorkerUrl('/worker.mjs')
const fixtures = await (await fetch('/fixtures.json')).json() as { scenes: PackPhysicalScene[]; descriptors: PackPhysicalSceneDescriptor[] }
const scene = fixtures.scenes[0]!, descriptor = fixtures.descriptors[0]!, errors: string[] = [], stateErrors: string[][] = [], clears: { own: boolean; mask: number }[] = []
const mapElement = document.getElementById('map')!, canvas = document.getElementById('canvas') as HTMLCanvasElement
const map = new MapLibreMap({ container: mapElement, style: { version: 8, sources: {}, layers: [{ id: 'ground', type: 'background', paint: { 'background-color': '#e6e9df' } }] }, center: descriptor.anchor, zoom: 16, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true } })
const loaded = new Promise<void>(resolve => map.once('load', () => resolve()))
const addLayer = map.addLayer.bind(map)
map.addLayer = (layer, before) => {
  if (layer.type === 'custom' && layer.id === 'physical-scenes:solids') {
    const render = layer.render
    layer.render = (gl, input) => {
      const state = fullGlState(gl), target = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), clear = gl.clear
      gl.clear = mask => { clears.push({ own: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== target, mask }); clear.call(gl, mask) }
      try { render.call(layer, gl, input) } finally { gl.clear = clear; const difference = stateDifferences(state, fullGlState(gl)); if (difference.length) stateErrors.push(difference) }
    }
  }
  return addLayer(layer, before)
}
const palette = (): PhysicalScenePalette => {
  const probe = document.createElement('span'); probe.hidden = true; document.body.append(probe)
  const names = ['floor', 'wall', 'steel', 'dark', 'machine', 'hood', 'motor', 'light', 'plinth', 'pipe', 'steam', 'crane', 'access', 'outage', 'waterbox', 'ground', 'glass', 'line', 'pavement', 'marking']
  try {
    const roles = Object.fromEntries(names.map(name => { probe.style.color = `var(--physical-${name})`; const values = getComputedStyle(probe).color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255); return [name, values as unknown as Color] }))
    return { materials: { ...roles, metal: roles.steel!, equipment: roles.machine!, door: roles.crane!, context: roles.ground! }, defaultMaterial: roles.machine!, line: roles.line!, lineOpacity: .26, contextLineOpacity: .1 }
  } finally { probe.remove() }
}
const sources = [{ descriptor, load: async () => scene }], controllers = new globalThis.Map<string, PhysicalSceneController>()
let active: PhysicalSceneController | null = null
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const ready = async (controller: PhysicalSceneController) => {
  const started = performance.now()
  while (controller.presentations()[0]?.status !== 'ready') { if (errors.length) throw Error(errors.join('; ')); if (performance.now() - started > 30000) throw Error('Parking fixture did not prepare: '+JSON.stringify({presentations:controller.presentations().map(value=>({id:value.descriptor.id,status:value.status,reason:value.reason,view:value.view})),pose:controller.cameraPose(),diagnostics:controller.diagnostics()})); await tick() }
}
const rendered = (controller: PhysicalSceneController) => new Promise<void>(resolve => { const off = controller.surface.on('render', () => { off(); resolve() }); if (controller.surface.kind === 'map') map.triggerRepaint(); else controller.turnBy(0) })
declare global { interface Window { planParkingProbe: { paint: (host: string, mode: '2d' | '3d', theme: string) => Promise<unknown>; finish: () => unknown } } }
window.planParkingProbe = {
  async paint(host, mode, theme) {
    await loaded; active?.setActive(false); mapElement.hidden = host !== 'map'; canvas.hidden = host !== 'canvas'; document.documentElement.classList.toggle('dark', theme === 'dusk')
    let controller = controllers.get(host)
    if (!controller) {
      const options = { palette: palette(), onChange() {}, reportError: (error: Error) => errors.push(error.message), fitPadding: () => ({ top: 40, right: 40, bottom: 40, left: 40 }) }
      controller = host === 'map' ? createPhysicalSceneController({ ...options, map, beforeId: () => undefined }) : createPhysicalCanvasController({ ...options, canvas })
      controllers.set(host, controller); controller.setSources(sources)
    }
    active = controller; controller.setActive(true); if (host === 'map') map.resize(); controller.setPalette(palette())
    controller.setView(scene.id, { ...controller.presentations()[0]!.view, mode, levelId: 'all' }); controller.focus(scene.id, { occurrenceId: 'parking/pavement', preservePose: false }); await ready(controller)
    controller.focus(scene.id, { occurrenceId: 'parking/pavement', preservePose: false }); await rendered(controller)
    const surface = host === 'map' ? map.getCanvas() : canvas, gl = surface.getContext('webgl2')!, box = surface.getBoundingClientRect(), painted = []
    // These IDs select the current PWR regression fixture only; the engine has no parking/material rule.
    for (const object of scene.objects.filter(object => object.id.startsWith('parking/line-'))) {
      const point = controller.cheapProject(scene.id, object.id)
      if (!point?.visible) continue
      const pixel = new Uint8Array(4); gl.readPixels(Math.floor(point.x / box.width * gl.drawingBufferWidth), Math.floor((1 - point.y / box.height) * gl.drawingBufferHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      painted.push({ id: object.id, pixel: [...pixel], hit: controller.pick(point)?.occurrenceId })
    }
    const colors = palette(), average = (value: readonly number[]) => value.reduce((a, b) => a + b, 0) / value.length, threshold = (average(colors.materials.marking!) + average(colors.materials.pavement!)) / 2 * 255
    const correct = painted.filter(value => value.hit === value.id), bright = correct.filter(value => average(value.pixel.slice(0, 3)) > threshold)
    const error = gl.getError(); if (error !== gl.NO_ERROR) errors.push(`GL error ${error}`)
    const passed = painted.length > 0 && (mode === '3d' ? correct.length > 0 : correct.length === painted.length && bright.length === painted.length)
    document.getElementById('status')!.textContent = `${host} ${mode} ${theme} · ${correct.length}/${painted.length} exact targets · ${bright.length} bright painted pixels`
    return { host, mode, theme, passed, painted: painted.length, correct: correct.length, bright: bright.length, samples: painted, metrics: controller.diagnostics(), pose: controller.cameraPose(), glError: error }
  },
  finish() { for (const controller of controllers.values()) controller.destroy(); return { errors, stateErrors, clears, diagnostics: [...controllers].map(([host, controller]) => ({ host, diagnostics: controller.diagnostics() })) } },
}
