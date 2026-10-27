import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { compileScenarioDefinition } from '../../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../../src/core/scenarios/definition.ts'
import { processPlantPack } from '../../src/packs/process-plant/pack.ts'
import { electricGridPack } from '../../src/packs/electric-grid/pack.ts'
import { weatherPack } from '../../src/packs/weather/pack.ts'
import { physicalLayoutPack } from '../../src/packs/physical-layout/pack.ts'
import { createDirectRoutingAdapter } from '../../src/routing/direct-adapter.ts'
import { describePhysicalLayoutScene, loadPhysicalLayoutScene } from '../../src/packs/physical-layout/scene.ts'

const root = join(import.meta.dir, '../..'), output = process.env.LEITBILD_PHYSICAL_COMPARISON_DIR ?? await mkdtemp(join(tmpdir(), 'leitbild-native-original-')), built = join(output, 'dist')
await mkdir(built, { recursive: true })
const definition = scenarioDefinitionSchema.parse(await Bun.file(join(root, 'src/scenarios/halden-normal-operation.scenario.json')).json())
const scenario = await compileScenarioDefinition(definition, [processPlantPack, electricGridPack, weatherPack, physicalLayoutPack], { routing: createDirectRoutingAdapter() })
const layout = scenario.initialObjects.find(object => object.id === 'layout:halden-1')!
const descriptor = describePhysicalLayoutScene(layout, scenario.initialObjects)!, scene = await loadPhysicalLayoutScene(layout)
if (!descriptor?.locationValid) throw Error('The admitted physical scene has no valid placement')
const bundle = await Bun.build({ entrypoints: [join(root, 'tests/browser/physical-scene/original-native-comparison-app.ts')], outdir: built, target: 'browser', format: 'esm', minify: true, naming: { entry: 'app.[ext]' } })
const worker = await Bun.build({ entrypoints: [join(root, 'src/ui/map/physical-scene/preparation-worker.ts')], outdir: built, target: 'browser', format: 'esm', minify: true, naming: { entry: 'preparation-worker.js' } })
if (!bundle.success || !worker.success) throw new AggregateError([...bundle.logs, ...worker.logs], 'Native/original comparison build failed')
const require = createRequire(import.meta.url), maplibre = dirname(require.resolve('maplibre-gl/package.json'))
const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/materials.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{width:100%;height:100%;margin:0;background:#ecefe7;font:14px system-ui;color:#475e4a}body{display:grid;grid-template-columns:1fr 1fr}section{min-width:0;display:grid;grid-template-rows:48px 1fr 48px}header,footer{padding:12px;box-sizing:border-box;background:#f8f9f4;border:1px solid #cad5c7}canvas,#map{width:100%;height:100%;display:block;min-height:0}#map{position:relative}</style></head><body><section><header>ORIGINAL · 23 October browser test · frozen source and renderer</header><canvas id="original"></canvas><footer>Original natural camera · utilities, illustrative access and crane enabled</footer></section><section><header>CURRENT · native map renderer and real MapLibre camera · identical viewport size</header><div id="map"></div><footer id="native-caption"></footer></section><script type="module" src="/app.js"></script></body></html>'
const files = new Map(bundle.outputs.map(file => [`/${relative(built, file.path)}`, file.path]))
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname
  if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } })
  if (path === '/fixtures.json') return Response.json({ scene, descriptor })
  if (path === '/materials.css') return new Response(Bun.file(join(root, 'src/ui/physical-layout/materials.css')))
  if (path === '/maplibre.css') return new Response(Bun.file(join(maplibre, 'dist/maplibre-gl.css')))
  if (path === '/worker.mjs') return new Response(Bun.file(join(maplibre, 'dist/maplibre-gl-worker.mjs')))
  if (path === '/preparation-worker.ts') return new Response(Bun.file(worker.outputs[0]!.path), { headers: { 'content-type': 'text/javascript' } })
  if (path === '/favicon.ico') return new Response(null, { status: 204 })
  const file = files.get(path); return file ? new Response(Bun.file(file)) : new Response('Not found', { status: 404 })
} })
const profile = await mkdtemp(join(tmpdir(), 'leitbild-original-native-chrome-'))
const chrome = Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'ignore', stderr: Bun.file(join(output, 'chrome.stderr.txt')) })
let socket: WebSocket | null = null
try {
  let port = 0
  const start = performance.now()
  while (!port && performance.now() - start < 10_000) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!port) await Bun.sleep(100)
  }
  if (!port) throw Error('The isolated comparison browser did not start')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string }
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject })
  let id = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>()
  socket.onmessage = event => { const message = JSON.parse(String(event.data)), task = pending.get(message.id); if (!task) return; pending.delete(message.id); message.error ? task.reject(message.error) : task.resolve(message.result) }
  const call = (method: string, params: unknown = {}): Promise<any> => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket!.send(JSON.stringify({ id: next, method, params })) })
  await call('Runtime.enable'); await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', { width: 2560, height: 1040, deviceScaleFactor: Number(process.env.LEITBILD_PHYSICAL_COMPARISON_DPR ?? 1), mobile: false })
  await call('Page.navigate', { url: `http://127.0.0.1:${server.port}/` })
  const phases: any[] = []
  for (const mode of ['all', 'operating', 'lower']) for (const status of [false, true]) {
    const evaluation = await call('Runtime.evaluate', { expression: `new Promise((resolve,reject)=>{const started=performance.now();const check=()=>{if(window.originalNativeComparison)window.originalNativeComparison.phase('${mode}',${status}).then(resolve,reject);else if(performance.now()-started>30000)reject(Error('Fixture did not initialize'));else setTimeout(check,25)};check()})`, awaitPromise: true, returnByValue: true, timeout: 180_000 })
    if (evaluation.exceptionDetails) throw Error(JSON.stringify(evaluation.exceptionDetails))
    phases.push(evaluation.result.value)
    const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, `${mode}${status ? '-status' : ''}.png`), Buffer.from(shot.data, 'base64'))
  }
  const sourceFiles = ['src/ui/map/physical-scene/backend.ts', 'src/ui/map/physical-scene/geometry.ts', 'src/ui/map/physical-scene/scope-regions.ts', 'src/ui/map/physical-scene/scope-clipping.ts', 'src/ui/map/physical-scene/surface-annotations.ts', 'src/ui/map/physical-scene/render-buffers.ts', 'src/ui/map/physical-scene/preparation.ts', 'src/ui/map/physical-scene/surface-ownership.ts', 'src/ui/map/physical-scene/scene-controller.ts', 'src/ui/map/physical-scene/map-viewport.ts', 'tests/fixtures/physical-scope-route.ts', 'tests/browser/physical-scene/original-native-comparison-app.ts', 'tests/browser/physical-scene/original-reference-renderer.ts']
  const hashes: Record<string, string> = {}
  for (const file of sourceFiles) hashes[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex')
  const contours = await call('Runtime.evaluate', { expression: 'window.originalNativeComparison.statusContours()', returnByValue: true })
  if (contours.exceptionDetails) throw Error(JSON.stringify(contours.exceptionDetails))
  const statusContours = contours.result.value
  const capEvaluation = await call('Runtime.evaluate', { expression: 'window.originalNativeComparison.scopeCaps()', returnByValue: true })
  if (capEvaluation.exceptionDetails) throw Error(JSON.stringify(capEvaluation.exceptionDetails))
  const { image, ...scopeCaps } = capEvaluation.result.value
  await writeFile(join(output, 'scope-cap.png'), Buffer.from(image.split(',')[1], 'base64'))
  const receipt = { phases, statusContours, scopeCaps, source: { revision: scene.revision, geometryKey: descriptor.geometryKey, objects: scene.objects.length, hash: createHash('sha256').update(JSON.stringify(scene)).digest('hex') }, provenance: { root, commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim(), dirty: Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: root }).stdout.toString(), hashes }, passed: statusContours.passed && scopeCaps.passed && phases.every(phase => !phase.errors.length && phase.originalViewport.width === phase.nativeViewport.width && phase.originalViewport.height === phase.nativeViewport.height && phase.statusWitness.changedPixels > 0 && phase.statusWitness.geometryUploadsBefore === phase.statusWitness.geometryUploadsAfter) }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ output, passed: receipt.passed, phases: phases.map(({ mode, status, nativeCamera, statusWitness }) => ({ mode, status, nativeCamera, statusWitness })) }, null, 2))
  if (!receipt.passed) process.exitCode = 1
} finally { socket?.close(); chrome.kill(); await chrome.exited; server.stop(true); await rm(profile, { recursive: true, force: true }) }
