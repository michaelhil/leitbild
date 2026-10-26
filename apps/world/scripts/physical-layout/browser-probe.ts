import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { scenarioDefinitionSchema } from '../../src/core/scenarios/definition.ts'
import { compileScenarioDefinition } from '../../src/core/scenarios/compiler.ts'
import { physicalLayoutPack } from '../../src/packs/physical-layout/pack.ts'
import { currentPwrPhysicalDesignRef, pwrFullUnitPhysicalDesignRef } from '../../src/packs/physical-layout/design.ts'
import { describePhysicalLayoutScene, loadPhysicalLayoutScene } from '../../src/packs/physical-layout/scene.ts'
import { processPlantPack } from '../../src/packs/process-plant/pack.ts'
import { processPlantPresentation } from '../../src/packs/process-plant/presentation.ts'
import { createDirectRoutingAdapter } from '../../src/routing/direct-adapter.ts'
import { createMapFeatureStore } from '../../src/ui/map-runtime/map-feature-store.ts'

const root = join(import.meta.dir, '../..')
const output = process.env.LEITBILD_PHYSICAL_SCENE_PROBE_DIR ?? await mkdtemp(join(tmpdir(), 'leitbild-physical-scene-proof-'))
await mkdir(output, { recursive: true })
const built = join(output, 'dist')
const require = createRequire(import.meta.url), maplibre = dirname(require.resolve('maplibre-gl/package.json'))
const designMode = process.env.LEITBILD_PHYSICAL_SCENE_PROBE_DESIGN ?? 'turbine-island'
if (designMode !== 'turbine-island' && designMode !== 'full-unit') throw new Error('Probe Design must be turbine-island or full-unit')
const design = designMode === 'full-unit' ? pwrFullUnitPhysicalDesignRef : currentPwrPhysicalDesignRef
const definition = scenarioDefinitionSchema.parse({
  id: 'physical-browser-proof', title: 'Physical browser proof',
  packs: [
    { id: 'process-plant', config: {}, items: [{ type: 'plant', id: 'plant:proof', label: 'PWR renderer proof', location: [11.47, 59.087], model: { ref: 'process-plant.pwr.reference', parameters: { loopCount: 4 } }, operatingPoint: { ref: 'process-plant.pwr.full-power' }, automation: { ref: 'process-plant.pwr.standard' } }] },
    { id: 'physical-layout', config: {}, items: [{ type: 'site-layout', id: 'layout:proof', label: designMode, members: { unit: 'plant:proof' }, design, bearing: 0 }] },
  ],
  world: { startsAt: '2026-10-24T00:00:00.000Z', environment: {} }, view: { map: { center: [11.47, 59.087], zoom: 19.3 } },
})
const scenario = await compileScenarioDefinition(definition, [processPlantPack, physicalLayoutPack], { routing: createDirectRoutingAdapter() })
const layout = scenario.initialObjects.find(object => object.id === 'layout:proof')!, owner = scenario.initialObjects.find(object => object.id === 'plant:proof')!
const descriptor = describePhysicalLayoutScene(layout, scenario.initialObjects)!, scene = await loadPhysicalLayoutScene(layout)
const operational = createMapFeatureStore().update({ objects: [owner], selectedControllerId: null, highlightedObjectIds: [], hiddenObjectCategoryIds: [], placementPoints: [], packFeatures: [], hasNewInfo: () => false, presentationFor: object => processPlantPresentation.presentObject(object, { objects: [owner] }), alertPalette: 'day' })
const hashes: Record<string, string> = {}
for (const file of ['src/ui/map/physical-scene/controller.ts', 'src/ui/map/physical-scene/map-viewport.ts', 'src/ui/map/physical-scene/scene-controller.ts', 'src/ui/map/physical-scene/preparation.ts', 'src/ui/map/physical-scene/preparation-worker.ts', 'src/ui/map/physical-scene/inspection-demand.ts', 'src/ui/map/physical-scene/render-pass.ts', 'src/ui/map/physical-scene/depth-projection.ts', 'src/ui/map/physical-scene/plan-projection.ts', 'src/ui/map/physical-scene/visibility.ts', 'src/ui/map/physical-scene/gl-state.ts', 'src/ui/map/physical-scene/canvas-viewport.ts', 'src/core/packs/scene.ts', 'src/core/packs/scene-transfer.ts', 'src/ui/map/physical-scene/surface-ownership.ts', 'src/ui/map/physical-scene/spatial-index.ts', 'src/ui/map/physical-scene/backend.ts', 'src/ui/map/physical-scene/geometry.ts', 'src/ui/map/physical-scene/inspection-cutaway.ts', 'tests/browser/physical-scene/app.ts', 'tests/browser/physical-scene/ordered-draw-probe.ts', 'tests/browser/physical-scene/gl-probes.ts', 'src/ui/map/physical-scene/overview.ts', 'src/ui/map-runtime/operational-deck-layers.ts', 'src/packs/physical-layout/native/compile-scene.ts', 'src/packs/physical-layout/native/campus/compile-scene.ts']) hashes[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex')
const bundle = await Bun.build({ entrypoints: [join(root, 'tests/browser/physical-scene/app.ts')], outdir: built, target: 'browser', format: 'esm', splitting: true, minify: true, naming: { entry: 'app.js', chunk: '[name]-[hash].[ext]' } })
if (!bundle.success) throw new AggregateError(bundle.logs, 'Physical browser proof build failed')
const workerBundle = await Bun.build({ entrypoints: [join(root, 'src/ui/map/physical-scene/preparation-worker.ts')], outdir: built, target: 'browser', format: 'esm', minify: true, naming: { entry: 'preparation-worker.js' } })
if (!workerBundle.success) throw new AggregateError(workerBundle.logs, 'Physical preparation worker build failed')
const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/maplibre.css"><style>html,body,#map{width:100%;height:100%;margin:0}#status{position:absolute;top:8px;left:8px;font:14px sans-serif;background:white;padding:8px;z-index:20}</style></head><body><div id="map"></div><div id="status">GPU test in progress · isolated test fixture</div><script type="module" src="/app.js"></script></body></html>'
const files = new Map<string, string>(bundle.outputs.map(file => [`/${relative(built, file.path)}`, file.path]))
// Bun's test bundler leaves new URL worker modules relative to the entry file; Vite handles this in the application build.
files.set('/preparation-worker.ts', workerBundle.outputs[0]!.path); files.set('/preparation-worker.js', workerBundle.outputs[0]!.path)
files.set('/worker.mjs', join(maplibre, 'dist/maplibre-gl-worker.mjs')); files.set('/maplibre.css', join(maplibre, 'dist/maplibre-gl.css'))
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname
  if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } })
  if (path === '/preparation-worker.ts' || path === '/preparation-worker.js') return new Response(Bun.file(workerBundle.outputs[0]!.path), { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } })
  if (path === '/scene.json') return Response.json(scene)
  if (path === '/descriptor.json') return Response.json(descriptor)
  if (path === '/operational.json') return Response.json(operational)
  const file = files.get(path)
  if (file) return new Response(Bun.file(file), { headers: { 'cache-control': 'no-store' } })
  if (path.startsWith('/assets/world/')) return new Response(Bun.file(join(root, 'src/ui/public', path)))
  return new Response('Not found', { status: 404 })
} })
const profile = await mkdtemp(join(tmpdir(), 'leitbild-physical-chrome-'))
const chrome = Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', '--force-device-scale-factor=1', 'about:blank'], { stdout: 'ignore', stderr: Bun.file(join(output, 'chrome.stderr.txt')) })
let socket: WebSocket | null = null
try {
  let port = 0
  for (let attempt = 0; attempt < 80; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (port) break
    await Bun.sleep(100)
  }
  if (!port) throw new Error('Isolated Chrome did not start')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string }
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject })
  let id = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>()
  const events = new Map<string, Set<() => void>>()
  socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.method) for (const listener of events.get(message.method) ?? []) listener(); const promise = pending.get(message.id); if (!promise) return; pending.delete(message.id); if (message.error) promise.reject(message.error); else promise.resolve(message.result) }
  const call = (method: string, params: unknown = {}): Promise<any> => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket!.send(JSON.stringify({ id: next, method, params })) })
  await call('Runtime.enable'); await call('Page.enable')
  const pageLoaded = new Promise<void>(resolve => events.set('Page.loadEventFired', new Set([resolve])))
  await call('Page.navigate', { url: `http://127.0.0.1:${server.port}/` }); await pageLoaded
  const evaluated = await call('Runtime.evaluate', { expression: `new Promise((resolve,reject)=>{let tries=0;const timer=setInterval(()=>{if(window.physicalProbe){clearInterval(timer);window.physicalProbe.ready.then(()=>window.physicalProbe.run()).then(resolve,reject)}else if(++tries>400){clearInterval(timer);reject(Error('Browser fixture did not initialize'))}},25)})`, awaitPromise: true, returnByValue: true, timeout: 180_000 })
  await writeFile(join(output, 'driver-evaluation.json'), JSON.stringify(evaluated, null, 2))
  const result = evaluated.result?.value
  if (!result || typeof result.passed !== 'boolean') { await writeFile(join(output, 'driver-failure.json'), JSON.stringify(evaluated, null, 2)); console.error(JSON.stringify(evaluated)); throw new Error(`Physical browser proof did not produce a receipt: ${output}`) }
  const evaluate = async (expression: string) => (await call('Runtime.evaluate', { expression, returnByValue: true })).result.value
  const gesture = async (tool: 'pan' | 'orbit', button: 'left' | 'right', moving: boolean, cancel = false) => {
    await evaluate(`window.physicalProbe.navigationTool('${tool}')`)
    const before = await evaluate('window.physicalProbe.gestureState()'), x = 388, y = 420, buttons = button === 'left' ? 1 : 2
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 })
    if (moving) for (let step = 1; step <= 120; step++) {
      const angle = step / 120 * Math.PI * 2
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + Math.sin(angle) * 65, y: y + Math.sin(angle * 2) * 22, buttons })
      if (cancel && step === 30) await evaluate('window.physicalProbe.cancelNavigation()')
    }
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 })
    const after = await evaluate('window.physicalProbe.gestureState()')
    return { tool, button, moving, cancel, clickDelta: after.clicks - before.clicks, cameraRevisions: after.pose.revision - before.pose.revision, nativePanEnabled: after.nativePanEnabled }
  }
  result.gestures = { closedLoopOrbit: await gesture('orbit', 'left', true), ordinaryOrbitClick: await gesture('orbit', 'left', false), nativePanLoop: await gesture('pan', 'left', true), nativeSecondaryLoop: await gesture('orbit', 'right', true), cancelledOrbit: await gesture('orbit', 'left', true, true), followingPanClick: await gesture('pan', 'left', false) }
  result.gesturesPassed = Object.values(result.gestures).every((value: any) => value.nativePanEnabled && value.clickDelta === (value.moving ? 0 : 1)) && result.gestures.closedLoopOrbit.cameraRevisions > 0
  result.passed &&= result.gesturesPassed
  // Gesture scenarios may change native camera pose; existing fit scenarios
  // begin from their own declared baseline rather than inheriting that state.
  await evaluate('window.physicalProbe.resetNavigationProbe()')
  result.rendererCommit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim(); result.sourceHashes = hashes; result.sceneSha256 = createHash('sha256').update(JSON.stringify(scene)).digest('hex'); result.designMode = designMode; result.design = design
  const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, 'final.png'), Buffer.from(shot.data, 'base64'))
  await call('Runtime.evaluate', { expression: `window.physicalProbe.view('2d','lower')`, awaitPromise: true });
  const lower = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, 'lower.png'), Buffer.from(lower.data, 'base64'))
  await call('Runtime.evaluate', { expression: `window.physicalProbe.view('3d','operating')`, awaitPromise: true });
  const upper = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, 'operating.png'), Buffer.from(upper.data, 'base64'))
  await call('Emulation.setDeviceMetricsOverride', { width: 638, height: 720, deviceScaleFactor: 1, mobile: false })
  const responsive = await call('Runtime.evaluate', { expression: 'window.physicalProbe.responsive()', awaitPromise: true, returnByValue: true, timeout: 10_000 })
  result.responsive = responsive.result?.value
  result.passed &&= result.responsive?.inside === true
  const narrow = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, 'narrow.png'), Buffer.from(narrow.data, 'base64'))
  const responsive3d = await call('Runtime.evaluate', { expression: 'window.physicalProbe.responsive3d()', awaitPromise: true, returnByValue: true, timeout: 10_000 })
  result.responsive3d = responsive3d.result?.value
  result.passed &&= result.responsive3d?.inside === true
  const narrow3d = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, 'narrow-3d.png'), Buffer.from(narrow3d.data, 'base64'))
  const separated = await call('Runtime.evaluate', { expression: 'window.physicalProbe.responsive3d(30)', awaitPromise: true, returnByValue: true, timeout: 10_000 })
  result.responsiveSeparated = separated.result?.value
  result.passed &&= result.responsiveSeparated?.inside === true
  const separateShot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, 'narrow-separated.png'), Buffer.from(separateShot.data, 'base64'))
  await writeFile(join(output, 'receipt.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ output, passed: result.passed, profile: result.profile, gestures: result.gestures, gesturesPassed: result.gesturesPassed, errors: result.errors, stateErrors: result.stateErrors, glErrors: result.glErrors, basic: result.basic, lifecycle: { mountCycles: result.cycles.length, styleCycles: result.styles.length, contextRestored: result.contextRestore.sentinel.passed }, idleFrames: result.idleFrames, unchangedStateRefreshes: result.unchangedStateRefreshes, responsive: result.responsive, responsive3d: result.responsive3d, responsiveSeparated: result.responsiveSeparated, negativeControlDetected: result.negativeControlDetected, deckPick: result.deckPick }, null, 2))
  if (!result.passed) process.exitCode = 1
} finally { socket?.close(); chrome.kill(); await chrome.exited; server.stop(true); await rm(profile, { recursive: true, force: true }) }
