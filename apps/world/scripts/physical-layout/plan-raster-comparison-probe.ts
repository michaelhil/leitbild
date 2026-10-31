import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, relative, resolve } from 'node:path'
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

const root = join(import.meta.dir, '../..'), output = process.env.LEITBILD_PLAN_RASTER_DIR ?? await mkdtemp(join(tmpdir(), 'leitbild-native-original-')), built = join(output, 'dist')
await mkdir(built, { recursive: true })
const definition = scenarioDefinitionSchema.parse(await Bun.file(join(root, 'src/scenarios/halden-normal-operation.scenario.json')).json())
const scenario = await compileScenarioDefinition(definition, [processPlantPack, electricGridPack, weatherPack, physicalLayoutPack], { routing: createDirectRoutingAdapter() })
const layout = scenario.initialObjects.find(object => object.id === 'layout:halden-1')!
const descriptor = describePhysicalLayoutScene(layout, scenario.initialObjects)!, scene = await loadPhysicalLayoutScene(layout)
if (!descriptor?.locationValid) throw Error('The admitted physical scene has no valid placement')
const painterFile = join(root, 'src/ui/physical-layout/plan-drawing.ts'), painterSource = await readFile(painterFile, 'utf8')
const batched = 'stream = compilePhysicalPlanPaint(primitives, objectRoster(scene), physicalPlanPath)', ordered = 'stream = primitives.flatMap(primitive => compilePhysicalPlanPaint([primitive], objectRoster(scene), physicalPlanPath))'
if (painterSource.split(batched).length !== 2) throw Error('The independent Plan stream reference no longer matches the unique production compilation boundary')
const bundle = await Bun.build({ entrypoints: [join(root, 'tests/browser/physical-scene/plan-raster-comparison-app.ts')], outdir: built, target: 'browser', format: 'esm', minify: true, naming: { entry: 'app.[ext]' }, plugins: [{ name: 'ordered-plan-reference', setup(build) { build.onLoad({ filter: /plan-ordered-reference\.ts$/ }, () => ({ contents: painterSource.replace(batched, ordered).replace(/from '([^']+)'/g, (statement, specifier) => specifier.startsWith('.') ? `from ${JSON.stringify(resolve(dirname(painterFile), specifier))}` : statement), loader: 'ts', resolveDir: dirname(painterFile) })) } }] })
if (!bundle.success) throw new AggregateError(bundle.logs, 'Plan raster comparison build failed')
const originalDirectory = process.env.LEITBILD_ORIGINAL_PLAN_DIR
if (!originalDirectory) throw Error('Set LEITBILD_ORIGINAL_PLAN_DIR to the retained original turbine-hall-trial directory')
const originals = new Map<string, string>()
for (const floor of ['operating', 'lower']) originals.set(`/original-${floor}.svg`, await readFile(join(originalDirectory, `halden-1-${floor}.svg`), 'utf8'))
const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/materials.css"><style>html,body{width:100%;height:100%;margin:0;background:#faf9f4;font:14px Arial;color:#475e4a}body{display:grid;grid-template-columns:1fr 1fr}section{min-width:0;display:grid;grid-template-rows:48px 1fr 48px}header,footer{padding:12px;box-sizing:border-box;background:#f8f9f4;border:1px solid #cad5c7}canvas,img{width:100%;height:100%;display:block;min-height:0}img{display:none}.original #reference{display:none}.original #original{display:block}</style></head><body><section><header>REFERENCE · ordered native Plan commands; original sheet in visual comparison</header><canvas id="reference"></canvas><img id="original" alt="Original authored plant Plan"><footer>Reference uses the same painter with one source primitive per command</footer></section><section><header>CURRENT · native architectural Plan · retained paint stream</header><canvas id="current"></canvas><footer id="caption"></footer></section><script type="module" src="/app.js"></script></body></html>'
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname
  if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } })
  if (path === '/fixture.json') return Response.json(scene)
  if (path === '/materials.css') return new Response(Bun.file(join(root, 'src/ui/physical-layout/materials.css')))
  if (path === '/app.js') return new Response(Bun.file(bundle.outputs[0]!.path))
  if (path === '/favicon.ico') return new Response(null, { status: 204 })
  if (originals.has(path)) return new Response(originals.get(path), { headers: { 'content-type': 'image/svg+xml' } })
  return new Response('Not found', { status: 404 })
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
  await call('Emulation.setDeviceMetricsOverride', { width: 2560, height: 1016, deviceScaleFactor: Number(process.env.LEITBILD_PHYSICAL_COMPARISON_DPR ?? 1), mobile: false })
  await call('Page.navigate', { url: `http://127.0.0.1:${server.port}/` })
  const phases: any[] = []
  const evaluate = async (expression: string) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 180_000 })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await evaluate("new Promise((resolve,reject)=>{const start=performance.now();const check=()=>{if(window.planRasterComparison)resolve(true);else if(performance.now()-start>30000)reject(Error('Plan fixture did not initialize'));else setTimeout(check,25)};check()})")
  await writeFile(join(output, 'batch-explanation.json'), JSON.stringify(await evaluate("window.planRasterComparison.explain('operating')"), null, 2))
  for (const floor of ['operating', 'lower']) for (const layers of ['all', 'without-utilities', 'without-allowances']) for (const alert of [false, true]) for (const camera of ['home', 'pan', 'rotate']) {
    const phase = await evaluate(`window.planRasterComparison.phase('${floor}','${layers}',${alert},'${camera}')`); phases.push(phase)
    if (!phase.passed) { const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, `${floor}-${layers}-${alert}-${camera}-difference.png`), Buffer.from(shot.data, 'base64')) }
  }
  await writeFile(join(output, 'phases.json'), JSON.stringify(phases, null, 2))
  const comparisons: unknown[] = []
  for (const floor of ['operating', 'lower']) {
    comparisons.push(await evaluate(`window.planRasterComparison.original('${floor}')`))
    const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, `${floor}-original-native.png`), Buffer.from(shot.data, 'base64'))
  }
  const hashes: Record<string, string> = {}
  for (const file of ['src/ui/physical-layout/plan-drawing.ts', 'src/ui/physical-layout/plan-paint-stream.ts', 'tests/browser/physical-scene/plan-raster-comparison-app.ts']) hashes[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex')
  for (const [path, content] of originals) hashes[path] = createHash('sha256').update(content).digest('hex')
  const receipt = { passed: phases.every(phase => phase.passed), phases, comparisons, source: { revision: scene.revision, objects: scene.objects.length, hash: createHash('sha256').update(JSON.stringify(scene)).digest('hex') }, provenance: { root, commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim(), dirty: Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: root }).stdout.toString(), hashes }, reference: { operation: 'Production native painter bundled independently with singleton primitive commands instead of batched streams', productionFlags: false, changedPixelsTolerance: 0, visualAcceptance: 'Original SVG comparisons require independent inspection; byte equality only certifies batching equivalence' } }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ output, passed: receipt.passed, phases: phases.length, differences: phases.filter(phase => !phase.passed) }, null, 2))
  if (!receipt.passed) process.exitCode = 1
} finally { socket?.close(); chrome.kill(); await chrome.exited; server.stop(true); await rm(profile, { recursive: true, force: true }) }
