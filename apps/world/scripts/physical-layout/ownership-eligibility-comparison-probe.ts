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

const root = join(import.meta.dir, '../..'), output = process.env.LEITBILD_OWNERSHIP_COMPARISON_DIR ?? await mkdtemp(join(tmpdir(), 'leitbild-native-original-')), built = join(output, 'dist')
await mkdir(built, { recursive: true })
const definition = scenarioDefinitionSchema.parse(await Bun.file(join(root, 'src/scenarios/halden-normal-operation.scenario.json')).json())
const scenario = await compileScenarioDefinition(definition, [processPlantPack, electricGridPack, weatherPack, physicalLayoutPack], { routing: createDirectRoutingAdapter() })
const layout = scenario.initialObjects.find(object => object.id === 'layout:halden-1')!
const descriptor = describePhysicalLayoutScene(layout, scenario.initialObjects)!, scene = await loadPhysicalLayoutScene(layout)
if (!descriptor?.locationValid) throw Error('The admitted physical scene has no valid placement')
const require = createRequire(import.meta.url)
const reference = process.env.LEITBILD_OWNERSHIP_REFERENCE ?? '103fa9156'
const sceneDirectory = join(root, 'src/ui/map/physical-scene'), referenceModules = new Map<string, string>()
const bundle = await Bun.build({ entrypoints: [join(root, 'tests/browser/physical-scene/ownership-eligibility-comparison-app.ts')], outdir: built, target: 'browser', format: 'esm', minify: true, naming: { entry: 'app.[ext]' }, plugins: [{ name: 'committed-legacy-preparation', setup(build) {
  build.onResolve({ filter: /legacy-preparation-reference\.ts$/ }, () => ({ path: join(sceneDirectory, 'preparation.ts'), namespace: 'committed-reference' }))
  build.onResolve({ filter: /^\./, namespace: 'committed-reference' }, args => { const path = resolve(dirname(args.importer), args.path); return path.startsWith(sceneDirectory + '/') ? { path, namespace: 'committed-reference' } : { path } })
  build.onResolve({ filter: /^[^.\/]/, namespace: 'committed-reference' }, args => ({ path: require.resolve(args.path) }))
  build.onLoad({ filter: /.*/, namespace: 'committed-reference' }, args => {
    const file = 'apps/world/' + relative(root, args.path), result = Bun.spawnSync(['git', 'show', `${reference}:${file}`], { cwd: root })
    if (result.exitCode) throw Error(result.stderr.toString())
    const contents = result.stdout.toString(); referenceModules.set(file, createHash('sha256').update(contents).digest('hex'))
    return { contents, loader: 'ts' }
  })
} }] })
if (!bundle.success) throw new AggregateError(bundle.logs, 'Ownership eligibility comparison build failed')
const maplibre = dirname(require.resolve('maplibre-gl/package.json'))
const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/materials.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{width:100%;height:100%;margin:0;background:#ecefe7;font:14px system-ui;color:#475e4a}body{display:grid;grid-template-columns:1fr 1fr}section{min-width:0;display:grid;grid-template-rows:48px 1fr 48px}header,footer{padding:12px;box-sizing:border-box;background:#f8f9f4;border:1px solid #cad5c7}canvas,#map{width:100%;height:100%;display:block;min-height:0}#map{position:relative}</style></head><body><section><header>BEFORE · committed103fa ownership · same actual native map camera</header><canvas id="legacy"></canvas><footer>Full authored source; original ownership eligibility</footer></section><section><header>AFTER · spatially eligible ownership · actual native map</header><div id="map"></div><footer id="caption"></footer></section><script type="module" src="/app.js"></script></body></html>'
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname
  if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } })
  if (path === '/fixtures.json') return Response.json({scene,descriptor})
  if (path === '/materials.css') return new Response(Bun.file(join(root, 'src/ui/physical-layout/materials.css')))
  if (path === '/maplibre.css') return new Response(Bun.file(join(maplibre, 'dist/maplibre-gl.css')))
  if (path === '/worker.mjs') return new Response(Bun.file(join(maplibre, 'dist/maplibre-gl-worker.mjs')))
  if (path === '/app.js') return new Response(Bun.file(bundle.outputs[0]!.path))
  return new Response(null, {status:204})
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
  const cases = [['lower-whole','lower',undefined,0],['all-separated','all',undefined,1],['lower-turbine','lower','area/turbine-island',0],['operating-turbine','operating','area/turbine-island',0]] as const
  const selectedCases=cases.filter(row=>!process.env.LEITBILD_OWNERSHIP_ONLY_CASE||row[0]===process.env.LEITBILD_OWNERSHIP_ONLY_CASE)
  if(!selectedCases.length)throw Error('Requested ownership comparison case is unknown')
  for (const [id,levelId,scopeId,separation] of selectedCases) for (const alert of [false,true]) {
    const expression = `new Promise((resolve,reject)=>{const start=performance.now();const check=()=>{if(window.ownershipComparison)window.ownershipComparison.phase('${levelId}',${JSON.stringify(scopeId)},${separation},${alert}).then(resolve,reject);else if(performance.now()-start>60000)reject(Error('Fixture did not initialize'));else setTimeout(check,25)};check()})`
    const evaluation = await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,timeout:180000})
    if(evaluation.exceptionDetails)throw Error(JSON.stringify(evaluation.exceptionDetails))
    phases.push(evaluation.result.value)
    const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,`${id}${alert?'-status':''}.png`),Buffer.from(shot.data,'base64'))
  }
  const sourceHashes:Record<string,string>={}
  for(const name of ['geometry','scope-clipping','surface-ownership','spatial-index','picking','renderer','backend'])sourceHashes[name]=createHash('sha256').update(await readFile(join(sceneDirectory,name+'.ts'))).digest('hex')
  const receipt={reference,referenceModules:Object.fromEntries(referenceModules),commit:Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:root}).stdout.toString().trim(),sourceRevision:scene.revision,sourceHashes,phases,passed:phases.every(phase=>phase.passed),note:'Before/after rendering uses the SAME controlled GL context and one realized public MapLibre camera matrix with identical production shader/material/picking ports; the second panel remains the actual native map. Host framebuffer resolve differences are reported separately and were reproduced with identical geometry. Controlled status is test input. No physical microtriangle is dropped by a size threshold.'}
  await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({output,passed:receipt.passed,phases:phases.map(({levelId,scopeId,separation,alert,changedPixels,maxChannelDifference,picks,pickDifferences,materialDifferences})=>({levelId,scopeId,separation,alert,changedPixels,maxChannelDifference,picks,pickDifferences:pickDifferences.length,materialDifferences:materialDifferences.length}))},null,2))
  if(!receipt.passed)process.exitCode=1
} finally { socket?.close(); chrome.kill(); await chrome.exited; server.stop(true); await rm(profile,{recursive:true,force:true}) }
