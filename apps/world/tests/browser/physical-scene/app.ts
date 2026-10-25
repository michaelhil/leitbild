import { Map as MapLibreMap, MercatorCoordinate, setWorkerUrl, type CustomLayerInterface, type StyleSpecification } from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor } from '../../../src/core/packs/scene.ts'
import type { OperationalRenderSnapshot } from '../../../src/ui/map-runtime/types.ts'
import { createOperationalDeckLayerFactory } from '../../../src/ui/map-runtime/operational-deck-layers.ts'
import { emptyCatalogueSymbolAtlas } from '../../../src/ui/map-runtime/catalogue-symbol-atlas.ts'
import { createPhysicalSceneController } from '../../../src/ui/map/physical-scene/controller.ts'
import { physicalSceneLayerAnchorId, physicalSceneLayerId } from '../../../src/ui/map/physical-scene/order.ts'
import { defaultPhysicalSceneView, type PhysicalScenePalette, type PhysicalScenePresentation } from '../../../src/ui/map/physical-scene/types.ts'
import { fullGlState, sentinel, stateDifferences } from './gl-probes.ts'
import { boundsCorners, localMercatorMatrix, multiply, transform } from '../../../src/ui/map/physical-scene/math.ts'

declare global { interface Window { physicalProbe: { ready: Promise<void>; run: () => Promise<unknown>; view: (mode: '2d' | '3d', level: string) => Promise<void>; responsive: () => Promise<unknown>; responsive3d: () => Promise<unknown> } } }
setWorkerUrl('/worker.mjs')
const errors: string[] = [], stateErrors: string[][] = [], glErrors: number[] = []
const descriptor = await (await fetch('/descriptor.json')).json() as PackPhysicalSceneDescriptor
const ownerSnapshot = await (await fetch('/operational.json')).json() as OperationalRenderSnapshot
const style = (): StyleSpecification => ({ version: 8, metadata: { 'leitbild:baseSources': ['base'] }, sources: { base: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } }, layers: [{ id: 'ground', type: 'background', paint: { 'background-color': '#e6e9df' } }] })
const map = new MapLibreMap({ container: 'map', style: style(), center: descriptor.anchor, zoom: 19.3, pitch: 0, canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true }, attributionControl: false, fadeDuration: 0 })
const addLayer = map.addLayer.bind(map)
let context: WebGL2RenderingContext | null = null, sceneFrames = 0, forceClear = false
let lastProjection: Float64Array | null = null
let recordingRepaints = false
const repaintCalls: string[] = []
const triggerRepaint = map.triggerRepaint.bind(map)
map.triggerRepaint = () => { if (recordingRepaints) repaintCalls.push(new Error().stack?.split('\n').slice(2, 5).join(' ') ?? 'unknown'); return triggerRepaint() }
map.addLayer = (layer, before) => {
  if (layer.id === physicalSceneLayerId && layer.type === 'custom') {
    const custom = layer as CustomLayerInterface, render = custom.render
    custom.render = (gl, input) => {
      context = gl
      lastProjection = new Float64Array(input.defaultProjectionData.mainMatrix)
      const prior = fullGlState(gl)
      render.call(custom, gl, input)
      const differences = stateDifferences(prior, fullGlState(gl)); if (differences.length) stateErrors.push(differences)
      if (forceClear) { gl.depthMask(true); gl.stencilMask(0xff); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT) }
      const error = gl.getError(); if (error !== gl.NO_ERROR) glErrors.push(error)
      sceneFrames++
    }
  }
  return addLayer(layer, before)
}
map.on('error', event => errors.push(event.error.message))
const palette: PhysicalScenePalette = { materials: { wall: [.65, .67, .66], floor: [.85, .85, .82], metal: [.35, .42, .44], equipment: [.25, .42, .34], pipe: [.5, .58, .58], door: [.23, .45, .65], glass: [.75, .83, .85], context: [.7, .72, .67], line: [.2, .22, .22] }, defaultMaterial: [.5, .55, .55], line: [.2, .22, .22] }
let presentations: ReadonlyArray<PhysicalScenePresentation> = [], controller: ReturnType<typeof createPhysicalSceneController>
let loadCount = 0
let phase = 'initial'
const source = { descriptor, load: async () => { loadCount++; return await (await fetch('/scene.json')).json() as PackPhysicalScene } }
const createController = () => createPhysicalSceneController({ map, palette, beforeId: () => physicalSceneLayerAnchorId(map.getStyle()), onChange: value => { presentations = value }, reportError: error => errors.push(error.message), fitPadding: () => ({ top: 80, bottom: 110, left: 80, right: 80 }) })
const deckFactory = createOperationalDeckLayerFactory()
const overlay = new MapboxOverlay({ interleaved: false, pickAsync: 'sync', layers: [] })
let sentinels: CustomLayerInterface[] = []
const installOperational = () => {
  const anchor = descriptor.anchor
  map.addSource('operational-zone', { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[anchor[0] - .0007, anchor[1] - .0004], [anchor[0] + .0007, anchor[1] - .0004], [anchor[0] + .0007, anchor[1] + .0004], [anchor[0] - .0007, anchor[1] + .0004], [anchor[0] - .0007, anchor[1] - .0004]]] } }] } })
  map.addLayer({ id: 'operational-zone', type: 'line', source: 'operational-zone', paint: { 'line-color': '#2675d8', 'line-width': 3 } })
  sentinels = [sentinel('probe-before', false), sentinel('probe-after', true)]
  for (const layer of sentinels) map.addLayer(layer, 'operational-zone')
}
const reorderSentinels = () => {
  if (map.getLayer(physicalSceneLayerId)) { map.moveLayer('probe-before', physicalSceneLayerId); map.moveLayer('probe-after', 'operational-zone') }
}
const frame = () => new Promise<void>(resolve => { map.once('render', () => resolve()); map.triggerRepaint() })
const settle = async (count = 3) => { for (let index = 0; index < count; index++) await frame() }
const ready = async () => {
  for (let index = 0; index < 200; index++) { if (presentations[0]?.status === 'ready' && controller.metrics()?.geometryUploads) return; if (errors.length) throw new Error(errors.join('; ')); await settle(1) }
  throw new Error(`Physical controller did not become ready during ${phase}: ${JSON.stringify({ presentations, diagnostics: controller.diagnostics(), styleLoaded: map.isStyleLoaded(), layer: Boolean(map.getLayer(physicalSceneLayerId)) })}`)
}
const updateDeck = () => {
  overlay.setProps({ layers: [...deckFactory.createLayers({ snapshot: ownerSnapshot, visibleFamilies: new Set(['objects', 'routes', 'zones']), catalogueAtlas: emptyCatalogueSymbolAtlas, onObjectSelected() {}, onObjectSeen() {}, onObjectHover() {}, disksPick: true, diskClicks: () => true, zoom: map.getZoom() })] })
}
const pixel = (x: number, y: number) => {
  const gl = context!, result = new Uint8Array(4)
  const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.readPixels(Math.floor(x * gl.drawingBufferWidth), Math.floor(y * gl.drawingBufferHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, result); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous)
  return [...result]
}
const sentinelCheck = () => {
  const values = { colorDepth: pixel(.075, .075), stencil: pixel(.5, .075), after: pixel(.925, .075) }
  const near = (v: number[], expected: number[]) => expected.every((value, index) => Math.abs(value - v[index]!) <= 4)
  return { ...values, passed: near(values.colorDepth, [204, 26, 179]) && near(values.stencil, [230, 204, 26]) && near(values.after, [26, 204, 51]) }
}
const pixelHash = async () => {
  const gl = context!, pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4), previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))].map(value => value.toString(16).padStart(2, '0')).join('')
}
const loaded = new Promise<void>(resolve => map.on('load', async () => {
  map.addControl(overlay); updateDeck(); controller = createController(); controller.setSources([source]); controller.fit(descriptor.id)
  await ready(); reorderSentinels(); await settle(3); resolve()
}))
map.on('style.load', installOperational)
map.on('moveend', updateDeck)

window.physicalProbe = {
  ready: loaded,
  async view(mode, level) { controller.setView(descriptor.id, { ...defaultPhysicalSceneView(descriptor.levels), mode, levelId: level }); map.jumpTo({ pitch: mode === '2d' ? 0 : 50 }); await settle(4) },
  async responsive() {
    map.resize(); await this.view('2d', descriptor.levels[0]!.id)
    const moved = new Promise<void>(resolve => map.once('moveend', () => resolve()))
    controller.fit(descriptor.id); await moved; await settle(4)
    const matrix = localMercatorMatrix(descriptor.anchor, descriptor.bearing)
    const points = boundsCorners(descriptor.bounds).map(point => { const p = transform(matrix, point); return map.project(new MercatorCoordinate(p[0], p[1], p[2]).toLngLat()) })
    const bounds = { left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) }
    return { width: innerWidth, height: innerHeight, bounds, inside: bounds.left >= 24 && bounds.top >= 24 && bounds.right <= innerWidth - 24 && bounds.bottom <= innerHeight - 24 }
  },
  async responsive3d() {
    await this.view('3d', 'all')
    const moved = new Promise<void>(resolve => map.once('moveend', () => resolve()))
    controller.fit(descriptor.id); await moved; await settle(4)
    const matrix = multiply(lastProjection!, localMercatorMatrix(descriptor.anchor, descriptor.bearing))
    const points = boundsCorners(descriptor.bounds).map(point => transform(matrix, point)).map(point => ({ x: (point[0] + 1) * innerWidth / 2, y: (1 - point[1]) * innerHeight / 2 }))
    const bounds = { left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) }
    return { width: innerWidth, height: innerHeight, bounds, inside: bounds.left >= 24 && bounds.top >= 24 && bounds.right <= innerWidth - 24 && bounds.bottom <= innerHeight - 24 }
  },
  async run() {
    await loaded
    const gl = context!, extension = gl.getExtension('WEBGL_debug_renderer_info')
    const profile = { userAgent: navigator.userAgent, width: innerWidth, height: innerHeight, dpr: devicePixelRatio, renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), antialias: gl.getContextAttributes()?.antialias }
    const base = await pixelHash(), uploads = controller.metrics()!.geometryUploads
    controller.setStatus(descriptor.id, new Map(descriptor.subjectIds.map(id => [id, { color: [.85, .1, .05] as const, emphasis: .65 }])))
    await settle(3)
    const state = { uploadsBefore: uploads, uploadsAfter: controller.metrics()!.geometryUploads, changedPixels: base !== await pixelHash() }
    const lowerVisible = controller.scene(descriptor.id)!.objects.flatMap(object => { const p = controller.project(descriptor.id, object.id); return p?.visible ? [object.id] : [] })
    const firstHit = lowerVisible.map(id => ({ id, point: controller.project(descriptor.id, id)! })).find(({ point }) => controller.pick(point)?.subjectIds.length)
    const pick = firstHit ? controller.pick(firstHit.point) : null
    controller.setStatus(descriptor.id, new Map(descriptor.subjectIds.map(id => [id, { color: [.8, .1, .05] as const, emphasis: .65 }])))
    const statusKeepsPicks = firstHit ? controller.pick(firstHit.point)?.occurrenceId === firstHit.id : false
    controller.setView(descriptor.id, { ...defaultPhysicalSceneView(descriptor.levels), mode: '3d', levelId: descriptor.levels[1]!.id })
    const levelChangeClearsPicks = firstHit ? controller.pick(firstHit.point) === null && controller.project(descriptor.id, firstHit.id) === null : false
    const basic = { sentinel: sentinelCheck(), state, pick, statusKeepsPicks, levelChangeClearsPicks, lowerVisibleCount: lowerVisible.length, layers: map.getLayersOrder(), canvasCount: document.querySelectorAll('canvas').length }
    await this.view('3d', descriptor.levels[1]!.id)
    const upperVisible = controller.scene(descriptor.id)!.objects.flatMap(object => { const p = controller.project(descriptor.id, object.id); return p?.visible ? [object.id] : [] })
    const levels = { upperVisibleCount: upperVisible.length, lowerAndUpperDiffer: JSON.stringify(lowerVisible) !== JSON.stringify(upperVisible), pitch: map.getPitch() }
    const cycles = []
    for (let index = 0; index < 20; index++) {
      phase = `mount-${index}`
      controller.destroy(); const disposal = controller.diagnostics();
      controller = createController(); controller.setSources([source]); await ready(); reorderSentinels(); await settle(1)
      cycles.push({ index, disposal, current: controller.metrics() })
    }
    const styles = []
    for (let index = 0; index < 20; index++) {
      phase = `style-${index}`
      // Full replacement is deliberately stronger than a style diff.
      for (const probe of sentinels) if (map.getLayer(probe.id)) map.removeLayer(probe.id)
      const styled = new Promise<void>(resolve => map.once('style.load', () => resolve()))
      map.setStyle(style(), { diff: false }); await styled; await ready(); reorderSentinels(); await settle(3)
      styles.push({ index, diagnostics: controller.diagnostics(), sentinel: sentinelCheck() })
    }
    const contextExtension = gl.getExtension('WEBGL_lose_context')
    if (!contextExtension) throw new Error('Required context-loss extension missing')
    phase = 'context-restore'
    const restored = new Promise<void>(resolve => map.getCanvas().addEventListener('webglcontextrestored', () => resolve(), { once: true }))
    contextExtension.loseContext(); await new Promise(resolve => setTimeout(resolve, 100)); contextExtension.restoreContext(); await restored; await ready()
    for (const probe of sentinels) if (!map.getLayer(probe.id)) map.addLayer(probe, 'operational-zone')
    reorderSentinels(); updateDeck(); await settle(3)
    const contextRestore = { diagnostics: controller.diagnostics(), sentinel: sentinelCheck() }
    const sameStatus = () => new Map(descriptor.subjectIds.map(id => [id, { color: [.85, .1, .05] as const, emphasis: .65 }]))
    controller.setStatus(descriptor.id, sameStatus()); await settle(3)
    await new Promise(resolve => setTimeout(resolve, 500))
    let unchangedStateRefreshes = 0
    const refresh = setInterval(() => { unchangedStateRefreshes++; controller.setStatus(descriptor.id, sameStatus()) }, 60)
    const beforeIdle = sceneFrames; recordingRepaints = true; await new Promise(resolve => setTimeout(resolve, 350)); recordingRepaints = false; clearInterval(refresh); const idleFrames = sceneFrames - beforeIdle
    forceClear = true; await settle(2); const negative = sentinelCheck(); forceClear = false; await settle(2)
    const point = map.project(descriptor.anchor), deckPick = overlay.pickObject({ x: point.x, y: point.y, radius: 24 })
    const passed = errors.length === 0 && glErrors.length === 0 && stateErrors.length === 0 && basic.sentinel.passed && state.uploadsBefore === state.uploadsAfter && state.changedPixels && pick !== null && statusKeepsPicks && levelChangeClearsPicks && levels.lowerAndUpperDiffer && cycles.every(cycle => cycle.disposal.disposals.every(disposal => disposal.liveBuffersAfterDisposal === 0 && disposal.liveProgramsAfterDisposal === 0)) && styles.every(value => value.sentinel.passed) && contextRestore.sentinel.passed && !negative.passed && idleFrames === 0 && deckPick !== null
    document.getElementById('status')!.textContent = `${passed ? 'PASS' : 'FAIL'} · production physical renderer + operational Deck overlay · ${profile.width}×${profile.height}`
    return { passed, profile, source: { revision: descriptor.revision, modelDigest: descriptor.modelDigest, objects: controller.scene(descriptor.id)!.objects.length }, basic, levels, cycles, styles, contextRestore, idleFrames, unchangedStateRefreshes, idleMeasurement: '350ms after500ms recoveryquiescence, with repeated equalstyle refreshes', repaintCalls: [...new Set(repaintCalls)], negativeControlDetected: !negative.passed, deckPick: deckPick ? { id: deckPick.object?.id, layer: deckPick.layer?.id } : null, stateErrors, glErrors, errors, loadCount, limits: ['Isolated desktop Chrome, not constrained hardware or WAN.', 'Empty test ground style; full PMTiles/context and app input/card/Run flow require separate integrated checks.', 'Test-controlled shader state is not operational plant status.', 'Same production native scene/controller and operational Deck layer factory; no experiment renderer imported.'] }
  },
}
