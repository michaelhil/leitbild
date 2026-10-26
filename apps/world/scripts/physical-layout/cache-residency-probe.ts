import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

// Admitted source and renderer may come from separate frozen team worktrees.
const rendererRoot = join(import.meta.dir, '../..'), sourceRoot = process.env.LEITBILD_PHYSICAL_PROBE_SOURCE_ROOT ?? rendererRoot
const output = await mkdtemp(join(tmpdir(), 'leitbild-cache-residency-proof-')), built = join(output, 'dist')
await mkdir(built, { recursive: true })
const sourceHashes: Record<string, string> = {}
for (const file of ['src/ui/map/physical-scene/surface-ownership.ts', 'src/ui/map/physical-scene/spatial-index.ts', 'src/ui/map/physical-scene/backend.ts', 'src/ui/map/physical-scene/scene-controller.ts', 'src/ui/map/physical-scene/preparation.ts', 'src/ui/map/physical-scene/renderer.ts', 'src/ui/map/physical-scene/geometry.ts', 'src/ui/map/physical-scene/canvas-viewport.ts', 'tests/browser/physical-scene/cache-residency-app.ts']) sourceHashes[file] = createHash('sha256').update(await readFile(join(rendererRoot, file))).digest('hex')
const commitAt = (cwd: string) => Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd }).stdout.toString().trim()
const rendererCommit = commitAt(rendererRoot), sourceCommit = commitAt(sourceRoot)
const load = (path: string) => import(join(sourceRoot, 'src', path))
const [{ compileScenarioDefinition }, { scenarioDefinitionSchema }, { processPlantPack }, { electricGridPack }, { weatherPack }, { physicalLayoutPack }, { createDirectRoutingAdapter }, { describePhysicalLayoutScene, loadPhysicalLayoutScene }] = await Promise.all([
  load('core/scenarios/compiler.ts'), load('core/scenarios/definition.ts'), load('packs/process-plant/pack.ts'), load('packs/electric-grid/pack.ts'), load('packs/weather/pack.ts'), load('packs/physical-layout/pack.ts'), load('routing/direct-adapter.ts'), load('packs/physical-layout/scene.ts'),
])
const definition = scenarioDefinitionSchema.parse(await Bun.file(join(sourceRoot, 'src/scenarios/halden-normal-operation.scenario.json')).json())
const scenario = await compileScenarioDefinition(definition, [processPlantPack, electricGridPack, weatherPack, physicalLayoutPack], { routing: createDirectRoutingAdapter() })
const layouts = scenario.initialObjects.filter((object: { packId: string }) => object.packId === 'physical-layout')
const descriptors = layouts.map((object: unknown) => describePhysicalLayoutScene(object, scenario.initialObjects)), scenes = await Promise.all(layouts.map((object: unknown) => loadPhysicalLayoutScene(object)))
if (descriptors.some((descriptor: { locationValid: boolean } | null) => !descriptor?.locationValid)) throw Error('Retained probe requires valid admitted placement bindings')
const bundle = await Bun.build({ entrypoints: [join(rendererRoot, 'tests/browser/physical-scene/cache-residency-app.ts')], outdir: built, target: 'browser', format: 'esm', minify: true, naming: { entry: 'app.js' } })
const worker = await Bun.build({ entrypoints: [join(rendererRoot, 'src/ui/map/physical-scene/preparation-worker.ts')], outdir: built, target: 'browser', format: 'esm', minify: true, naming: { entry: 'preparation-worker.js' } })
if (!bundle.success || !worker.success) throw new AggregateError([...bundle.logs, ...worker.logs], 'Retained host probe build failed')
const require = createRequire(import.meta.url), maplibre = dirname(require.resolve('maplibre-gl/package.json'))
const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/maplibre.css"><style>html,body,#map,#canvas{width:100%;height:100%;margin:0}#status{position:absolute;top:8px;left:8px;background:white;font:14px sans-serif;padding:8px;z-index:20}[hidden]{display:none!important}</style></head><body><div id="map"></div><canvas id="canvas" hidden></canvas><div id="status">Retained host diagnostic</div><script type="module" src="/app.js"></script></body></html>'
const files = new Map(bundle.outputs.map(file => [`/${relative(built, file.path)}`, file.path]))
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname
  if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } })
  if (path === '/fixtures.json') return Response.json({ scenes, descriptors })
  if (path === '/preparation-worker.ts') return new Response(Bun.file(worker.outputs[0]!.path), { headers: { 'content-type': 'text/javascript' } })
  if (path === '/worker.mjs') return new Response(Bun.file(join(maplibre, 'dist/maplibre-gl-worker.mjs')))
  if (path === '/maplibre.css') return new Response(Bun.file(join(maplibre, 'dist/maplibre-gl.css')))
  if (path === '/favicon.ico') return new Response(null, { status: 204 })
  const file = files.get(path); return file ? new Response(Bun.file(file)) : new Response('Not found', { status: 404 })
} })
const profile = await mkdtemp(join(tmpdir(), 'leitbild-retained-chrome-'))
const chrome = Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--js-flags=--expose-gc', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', '--force-device-scale-factor=1', 'about:blank'], { stdout: 'ignore', stderr: Bun.file(join(output, 'chrome.stderr.txt')) })
let socket: WebSocket | null = null
try {
  let port = 0
  for (let attempt = 0; attempt < 80; attempt++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }; if (port) break; await Bun.sleep(100) }
  if (!port) throw Error('Isolated retained-host Chrome did not start')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string }
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject })
  let id = 0; const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>(), events = new Map<string, Set<() => void>>()
  socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.method) for (const listener of events.get(message.method) ?? []) listener(); const task = pending.get(message.id); if (!task) return; pending.delete(message.id); message.error ? task.reject(message.error) : task.resolve(message.result) }
  const call = (method: string, params: unknown = {}): Promise<any> => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket!.send(JSON.stringify({ id: next, method, params })) })
  await call('Runtime.enable'); await call('Page.enable')
  const pageLoaded = new Promise<void>(resolve => events.set('Page.loadEventFired', new Set([resolve])))
  await call('Page.navigate', { url: `http://127.0.0.1:${server.port}/` }); await pageLoaded
  const evaluated = await call('Runtime.evaluate', { expression: 'new Promise((resolve,reject)=>{const started=performance.now();const check=()=>{if(window.cacheResidencyProbe)window.cacheResidencyProbe.run().then(resolve,reject);else if(performance.now()-started>30000)reject(Error("Retained host app did not initialize"));else setTimeout(check,25)};check()})', awaitPromise: true, returnByValue: true, timeout: 180_000 })
  if (evaluated.exceptionDetails) throw Error(JSON.stringify(evaluated.exceptionDetails))
  const result = evaluated.result.value
  result.provenance = { rendererRoot, sourceRoot, rendererCommit, sourceCommit, fixtureDeliveryBytes: JSON.stringify({ scenes, descriptors }).length, fixtureSha256: createHash('sha256').update(JSON.stringify({ scenes, descriptors })).digest('hex'), definitions: descriptors.map((descriptor: { id: string; revision: string; geometryKey?: string }) => ({ id: descriptor.id, revision: descriptor.revision, geometryKey: descriptor.geometryKey })), sources: sourceHashes }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(result, null, 2))
  const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, 'canvas-final.png'), Buffer.from(shot.data, 'base64'))
  console.log(JSON.stringify({ output, passed: result.passed, phases: result.phases, closed: result.closed, ownerHit: result.ownerHit, errors: result.errors }, null, 2))
  if (!result.passed) process.exitCode = 1

} finally { socket?.close(); chrome.kill(); await chrome.exited; server.stop(true); await rm(profile, { recursive: true, force: true }) }
