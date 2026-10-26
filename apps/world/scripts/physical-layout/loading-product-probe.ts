// Precise isolated full-product action -> requested asset draw -> GPU completion.
// This runner never imports product internals or invokes a production Run.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const input = process.argv[2]
if (!input) throw Error('Usage: bun scripts/physical-layout/loading-product-probe.ts /path/to/qa-run.json evidence-directory')
const folder = process.argv[3] ? resolve(process.argv[3]) : await mkdtemp(join(tmpdir(), 'leitbild-loading-product-'))
await mkdir(folder, { recursive: true })
const repository = resolve(import.meta.dir, '../../../..'), info = await Bun.file(resolve(input)).json()
const testedRef = process.env.LEITBILD_LOADING_TESTED_COMMIT
if (!testedRef) throw Error('Set LEITBILD_LOADING_TESTED_COMMIT to the separately built app commit')
const testedAppCommit = Bun.spawnSync(['git', 'rev-parse', testedRef], { cwd: repository }).stdout.toString().trim()
if (!/^[0-9a-f]{40}$/.test(testedAppCommit)) throw Error('The tested app commit must resolve locally')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(info.url).hostname)) throw Error('Loading proof requires an isolated loopback Run')
const instrumentPath = resolve(import.meta.dir, '../../tests/browser/physical-scene/loading-product-instrumentation.ts')
const built = await Bun.build({ entrypoints: [instrumentPath], target: 'browser', format: 'iife', minify: false })
if (!built.success) throw new AggregateError(built.logs, 'Cannot build loading observer')
const instrumentation = await built.outputs[0]!.text(), profile = await mkdtemp(join(tmpdir(), 'leitbild-loading-chrome-'))
const chrome = Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--js-flags=--expose-gc', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', '--force-device-scale-factor=1', 'about:blank'], { stdout: 'ignore', stderr: Bun.file(join(folder, 'chrome.stderr.log')) })
let socket: WebSocket | null = null, sequence = 0
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>(), exceptions: unknown[] = [], network = new Map<string, any>()
const call = (method: string, params: any = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression: string) => { const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 90000 }); if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails)); return response.result?.value }
const W = `document.querySelector('iframe[src*="/world/runs/"]').contentWindow`
const world = (body: string) => evaluate(`(()=>{const w=${W},d=w.document.querySelector('.layout-browser')??w.document,q=w.__loadingProof;${body}})()`)
const until = async (body: string, label: string) => { const started = performance.now(); while (performance.now() - started < 45000) { if (await world(body)) return; await Bun.sleep(50) }; throw Error(`Timed out: ${label}`) }
const selected = `{mode:d.querySelector('.modes button[aria-pressed=true]')?.textContent.trim()==='3D'?'3d':'2d',levelId:d.querySelector('select[aria-label="Layout level"]')?.value}`
const actions: any[] = [], gc: any[] = []
const action = async (name: string, setup: string, dispatch: string, expected = selected, surface = 'layout-canvas') => {
  const value = await world(`${setup};q.begin(${JSON.stringify(name)},${expected},${JSON.stringify(surface)});${dispatch};return q.current.promise`)
  if (!value?.firstDraw || value.glError || value.pending || value.actionToGpuCompletedMs < value.actionToFirstDrawMs) throw Error(`Invalid measured action ${name}`)
  value.ownerFresh = await world(`return new Promise((resolve,reject)=>{const check=()=>{const root=w.document.querySelector('.layout-browser')??w.document,text=root.querySelector('.explorer-controls .evidence')?.textContent??'';if(text.includes('layouts ready')){resolve({applicable:false,evidence:text});return}if(/Paused · fresh|Live ·/.test(text)){resolve({applicable:true,at:w.performance.now(),actionToFreshMs:w.performance.now()-q.current.started,evidence:text});return}if(w.performance.now()-q.current.started>45000){reject(Error('Owner did not become fresh: '+text));return}w.requestAnimationFrame(check)};check()})`)
  actions.push(value); await writeFile(join(folder, 'partial.json'), JSON.stringify({ actions, gc }, null, 2)); console.log(name, JSON.stringify({ firstDrawMs: value.actionToFirstDrawMs, gpuCompleteMs: value.actionToGpuCompletedMs, preparedAfterAction: value.preparedAfterAction, prepares: value.jobs.filter((job: any) => job.kind === 'prepare').length, expected: value.expected, key: value.firstDraw.key }))
}
const button = async (label: string, name: string, expected = selected, surface = 'layout-canvas') => action(name, `const b=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&b.getBoundingClientRect().width>0);if(!b)throw Error('Missing button '+${JSON.stringify(label)})`, 'b.click()', expected, surface)
const floor = (label: string, name: string) => action(name, `const input=d.querySelector('select[aria-label="Layout level"]'),option=[...input.options].find(o=>o.text.toLowerCase().includes(${JSON.stringify(label.toLowerCase())}));if(!option)throw Error('Missing floor '+${JSON.stringify(label)})`, `input.value=option.value;input.dispatchEvent(new w.Event('change',{bubbles:true}))`, `{...${selected},levelId:option.value}`)
const collect = async (name: string) => { const before = await world('return {jobs:q.jobs.length,sources:q.sources.length,at:w.performance.now()}'); await call('HeapProfiler.collectGarbage'); await world('return new Promise(resolve=>w.requestAnimationFrame(resolve))'); gc.push({ name, before, after: await world('return {jobs:q.jobs.length,sources:q.sources.length,at:w.performance.now()}') }) }
const scope = async () => {
  await world(`d.querySelector('.explorer-controls .scope').click()`)
  await world(`const input=d.querySelector('.scopes input[type=search]');input.value='Turbine hall';input.dispatchEvent(new w.Event('input',{bubbles:true}))`)
  const path = 'Halden Unit 1 full plant / PWR unit / Turbine hall'
  await until(`return [...d.querySelectorAll('.scopes button[title]')].some(b=>b.title===${JSON.stringify(path)})`, path)
  await action('first-turbine-hall-focus', `const b=[...d.querySelectorAll('.scopes button[title]')].find(b=>b.title===${JSON.stringify(path)})`, 'b.click()')
}
const cutaway = async (enabled: boolean, name: string) => {
  await world(`const b=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==='View');b.click()`)
  await action(name, `const input=[...d.querySelectorAll('.settings label')].find(l=>l.textContent.includes('Inspection cutaway')).querySelector('input');if(input.checked===${enabled})throw Error('Cutaway action would be a no-op')`, 'input.click()', `{...${selected},cutaway:${enabled}}`)
  await world(`const b=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==='View');b.click()`)
}
try {
  let port = 0
  for (let attempt = 0; attempt < 80; attempt++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }; if (port) break; await Bun.sleep(100) }
  if (!port) throw Error('Isolated Chrome did not start')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject })
  socket.onmessage = event => { const value = JSON.parse(String(event.data)), task = pending.get(value.id); if (task) { pending.delete(value.id); value.error ? task.reject(value.error) : task.resolve(value.result) } else if (value.method === 'Runtime.exceptionThrown') exceptions.push(value.params.exceptionDetails); else if (value.method === 'Network.requestWillBeSent' && /\/simulation-runs\/.*\/(presence|displays\/layout)(?:\?|$)/.test(value.params.request.url)) { const p=value.params; network.set(p.requestId,{id:p.requestId,url:p.request.url,method:p.request.method,postData:p.request.postData,start:p.timestamp,wallTime:p.wallTime}) } else if (value.method === 'Network.responseReceived' && network.has(value.params.requestId)) Object.assign(network.get(value.params.requestId),{response:value.params.timestamp,status:value.params.response.status}); else if (value.method === 'Network.loadingFinished' && network.has(value.params.requestId)) Object.assign(network.get(value.params.requestId),{finished:value.params.timestamp}); else if (value.method === 'Network.loadingFailed' && network.has(value.params.requestId)) Object.assign(network.get(value.params.requestId),{failed:value.params.timestamp,error:value.params.errorText,canceled:value.params.canceled}) }
  await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable'); await call('HeapProfiler.enable'); await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 913, deviceScaleFactor: 1, mobile: false })
  await call('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation })
  const navigationStarted = performance.now(); await call('Page.navigate', { url: info.url })
  while (!await evaluate(`Boolean(document.querySelector('iframe[src*="/world/runs/"]')?.contentDocument?.querySelector('.explorer-controls'))`)) { if (performance.now() - navigationStarted > 45000) throw Error('World controls did not mount'); await Bun.sleep(50) }
  const mounted = { navigationToControlsMs: performance.now() - navigationStarted, world: await world('return {at:w.performance.now(),pending:q.pending,jobs:q.jobs.length,sources:q.sources.length}') }
  await world(`d.querySelector('button[aria-label="Close grid overview panel"]')?.click()`)
  await button('Open layout browser', 'open-browser-cold', `{mode:'3d',levelId:'all',readyCount:5}`)
  await button('3D', 'site-3d', `{mode:'3d',readyCount:5}`)
  await scope()
  await floor('Turbine and main control', 'first-operating-3d')
  await floor('Stack', 'first-stack-3d')
  await collect('before-operating-return'); await floor('Turbine and main control', 'gc-return-operating-3d')
  await collect('before-stack-return'); await floor('Stack', 'gc-return-stack-3d')
  await cutaway(false, 'first-uncut-stack'); await collect('before-cutaway-return'); await cutaway(true, 'gc-return-cutaway-stack')
  await button('Plan', 'first-plan', `{mode:'2d'}`)
  await floor('Turbine and main control', 'first-plan-operating')
  await floor('Lower', 'first-plan-lower')
  await collect('before-plan-return'); await floor('Turbine and main control', 'gc-return-plan-operating')
  await button('3D', 'return-3d-operating', `{mode:'3d',levelId:'operating'}`)
  await world(`const b=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==='Back to map');b.click()`); await until(`return !w.document.querySelector('.layout-browser') && !!d.querySelector('button')`, 'browser owner closed onto map'); const ownerBoundary = await world(`return {at:w.performance.now(),evidence:d.querySelector('.explorer-controls .evidence')?.textContent,pending:q.pending}`)
  await collect('before-fresh-browser-owner'); await button('Open layout browser', 'gc-fresh-browser-owner', `{mode:'3d',levelId:'all',readyCount:5}`)
  const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(folder, 'final-browser.png'), Buffer.from(shot.data, 'base64'))
  const observer = await world('return {sources:q.sources,jobs:q.jobs,draws:q.draws,errors:q.errors,pending:q.pending,overheadMs:q.overheadMs,userAgent:w.navigator.userAgent,timeOrigin:w.performance.timeOrigin}'), source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repository }).stdout.toString().trim()
  for (const item of network.values()) { item.startedWorldMs=item.wallTime*1000-observer.timeOrigin; item.phase=actions.findLast(action=>item.startedWorldMs>=action.started)?.name??'navigation'; item.responseMs=item.response===undefined?null:(item.response-item.start)*1000 }
  const result = { runnerCommit: source, testedAppCommit, testedApp: info, mounted, actions, gc, ownerBoundary, observer, ownerRequests:[...network.values()], exceptions, instrumentationSha256: createHash('sha256').update(instrumentation).digest('hex'), limits: ['Real built loopback Host/World, paused isolated Run, production workers/viewports; no production instrumentation or model changes.', 'Dispatch and milestones use World performance.now. Exact prepared typed-array -> VBO/VAO -> requested semantic view draw is observed, then a microtask fence includes Plan composition. GPU completion is not a physical-monitor presentation timestamp.', 'Prepared response includes queue/worker/transfer; no controller-ready timestamp is claimed without a product hook. First matching draw proves admission occurred by that point.', 'WeakMap tags and primitive-only logs do not retain prepared arrays across forced GC. Instrumentation adds overhead; draw-wrapper diagnostic cost is reported separately and does not include every wrapper.', 'No fixed settlement sleeps. Initial controls mount is separate from layout completion. One GPU/profile/device and local services; full-product and isolated-engine timings are not interchangeable.'] }
  if (observer.errors.length || observer.pending || exceptions.length || observer.sources.some((item: any) => !item.ok || !item.responseAt || !item.terminatedAt)) throw Error('Loading observer found unfinished/failed product work')
  await writeFile(join(folder, 'receipt.json'), JSON.stringify(result, null, 2)); console.log('DONE', folder)
} catch (error) {
  const failure: any = { error: String(error), actions, gc, exceptions }; try { failure.observer = await world('return {sources:q?.sources,jobs:q?.jobs,draws:q?.draws?.slice(-20),errors:q?.errors,pending:q?.pending,current:q?.current}'); } catch (diagnosticError) { failure.diagnosticError = String(diagnosticError) }; await writeFile(join(folder, 'failure.json'), JSON.stringify(failure, null, 2)); throw error
} finally { socket?.close(); chrome.kill(); await chrome.exited; await rm(profile, { recursive: true, force: true }) }
