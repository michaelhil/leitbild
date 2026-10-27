// Precise isolated full-product action -> requested asset draw -> GPU completion.
// This runner never imports product internals or invokes a production Run.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const input = process.argv[2]
if (!input) throw Error('Usage: bun scripts/physical-layout/native-map-loading-probe.ts /path/to/qa-run.json evidence-directory')
const folder = process.argv[3] ? resolve(process.argv[3]) : await mkdtemp(join(tmpdir(), 'leitbild-loading-product-'))
await mkdir(folder, { recursive: true })
const repository = resolve(import.meta.dir, '../../../..'), info = await Bun.file(resolve(input)).json()
const testedRef = process.env.LEITBILD_LOADING_TESTED_COMMIT
if (!testedRef) throw Error('Set LEITBILD_LOADING_TESTED_COMMIT to the separately built app commit')
const testedAppCommit = Bun.spawnSync(['git', 'rev-parse', testedRef], { cwd: repository }).stdout.toString().trim()
if (!/^[0-9a-f]{40}$/.test(testedAppCommit)) throw Error('The tested app commit must resolve locally')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(info.url).hostname)) throw Error('Loading proof requires an isolated loopback Run')
const instrumentPath = resolve(import.meta.dir, '../../tests/browser/physical-scene/native-map-loading-instrumentation.ts')
const built = await Bun.build({ entrypoints: [instrumentPath], target: 'browser', format: 'iife', minify: false })
if (!built.success) throw new AggregateError(built.logs, 'Cannot build loading observer')
const instrumentation = await built.outputs[0]!.text(), profile = await mkdtemp(join(tmpdir(), 'leitbild-loading-chrome-'))
const chrome = Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--js-flags=--expose-gc', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', '--force-device-scale-factor=1', 'about:blank'], { stdout: 'ignore', stderr: Bun.file(join(folder, 'chrome.stderr.log')) })
let socket: WebSocket | null = null, sequence = 0
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>(), exceptions: unknown[] = [], network = new Map<string, any>(), sockets = new Map<string, string>(), socketFrames: Array<{ id: string; url: string | undefined; at: number; bytes: number }> = []
const call = (method: string, params: any = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression: string) => { const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 90000 }); if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails)); return response.result?.value }
const W = `document.querySelector('iframe[src*="/world/runs/"]').contentWindow`
const world = (body: string) => evaluate(`(()=>{const w=${W},d=w.document,q=w.__nativeMapLoadingProof;${body}})()`)
const until = async (body: string, label: string) => { const started = performance.now(); while (performance.now() - started < 45000) { if (await world(body)) return; await Bun.sleep(50) }; throw Error(`Timed out: ${label}`) }
const selected = `{mode:d.querySelector('.modes button[aria-pressed=true]')?.textContent.trim()==='3D'?'3d':'2d',levelId:d.querySelector('select[aria-label="Layout level"]')?.value}`
const actions: any[] = [], gc: any[] = []
const action = async (name: string, setup: string, dispatch: string, expected = selected, surface = 'maplibregl-canvas') => {
  const value = await world(`${setup};q.begin(${JSON.stringify(name)},${expected},${JSON.stringify(surface)});${dispatch};return q.current.promise`)
  if (!value || value.pending || (value.milestone.includes('3d') ? !value.firstDraw || value.glError || value.actionToGpuCompletedMs < value.actionToAllRequiredSourcesFirstDrawMs : !value.firstInk || !(value.actionToPaintOpportunityMs >= value.actionToFirstInkMs))) throw Error(`Invalid measured action ${name}`)
  value.ownerFresh = await world(`return new Promise((resolve,reject)=>{const check=()=>{const root=w.document,text=root.querySelector('.explorer-controls .evidence')?.textContent??'';if(text.includes('layouts ready')){resolve({applicable:false,evidence:text});return}if(/Paused · fresh|Live ·/.test(text)){resolve({applicable:true,at:w.performance.now(),actionToFreshMs:w.performance.now()-q.current.started,evidence:text});return}if(w.performance.now()-q.current.started>45000){reject(Error('Owner did not become fresh: '+text));return}w.requestAnimationFrame(check)};check()})`)
  actions.push(value); await writeFile(join(folder, 'partial.json'), JSON.stringify({ actions, gc }, null, 2)); console.log(name, JSON.stringify({ milestone:value.milestone, firstDrawMs:value.actionToFirstDrawMs, allSourceDrawMs:value.actionToAllRequiredSourcesFirstDrawMs, gpuCompleteMs:value.actionToGpuCompletedMs, firstInkMs:value.actionToFirstInkMs, paintOpportunityMs:value.actionToPaintOpportunityMs, prepares:value.jobs.filter((job:any)=>job.kind==='prepare').length, expected:value.expected }))
}
const button = async (label: string, name: string, expected = selected, surface = 'maplibregl-canvas') => action(name, `const b=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&b.getBoundingClientRect().width>0);if(!b)throw Error('Missing button '+${JSON.stringify(label)})`, 'b.click()', expected, surface)
const floor = (label: string, name: string) => action(name, `const input=d.querySelector('select[aria-label="Layout level"]'),option=[...input.options].find(o=>o.text.toLowerCase().includes(${JSON.stringify(label.toLowerCase())}));if(!option)throw Error('Missing floor '+${JSON.stringify(label)})`, `input.value=option.value;input.dispatchEvent(new w.Event('change',{bubbles:true}))`, `{...${selected},levelId:option.value}`)
const collect = async (name: string) => { const before = await world('return {jobs:q.jobs.length,sources:q.sources.length,at:w.performance.now()}'); await call('HeapProfiler.collectGarbage'); await world('return new Promise(resolve=>w.requestAnimationFrame(resolve))'); gc.push({ name, before, after: await world('return {jobs:q.jobs.length,sources:q.sources.length,at:w.performance.now()}') }) }
const scope = async () => {
  await world(`d.querySelector('.explorer-controls .scope').click()`)
  await until(`return Boolean(d.querySelector('.scopes input[type=search]'))`,'rendered area search'); await world(`const input=d.querySelector('.scopes input[type=search]');input.value='Turbine hall';input.dispatchEvent(new w.Event('input',{bubbles:true}))`)
  const path = 'Halden Unit 1 full plant / PWR unit / Turbine hall and feedwater pump annex'
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
  const chromeStarted=performance.now(); while(performance.now()-chromeStarted<45000) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }; if (port) break; if(chrome.exitCode!==null)throw Error(`Chrome exited before CDP: ${chrome.exitCode}`); await Bun.sleep(100) }
  if (!port) throw Error('Isolated Chrome did not start')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject })
  socket.onmessage = event => { const value = JSON.parse(String(event.data)), task = pending.get(value.id); if (task) { pending.delete(value.id); value.error ? task.reject(value.error) : task.resolve(value.result) } else if (value.method === 'Runtime.exceptionThrown') exceptions.push(value.params.exceptionDetails); else if (value.method === 'Network.requestWillBeSent' && /\/api\//.test(value.params.request.url)) { const p=value.params; network.set(p.requestId,{id:p.requestId,url:p.request.url,method:p.request.method,requestBodyBytes:p.request.postData?Buffer.byteLength(p.request.postData):0,start:p.timestamp,wallTime:p.wallTime}) } else if (value.method === 'Network.responseReceived' && network.has(value.params.requestId)) Object.assign(network.get(value.params.requestId),{response:value.params.timestamp,status:value.params.response.status}); else if (value.method === 'Network.loadingFinished' && network.has(value.params.requestId)) Object.assign(network.get(value.params.requestId),{finished:value.params.timestamp,encodedBytes:value.params.encodedDataLength}); else if (value.method === 'Network.loadingFailed' && network.has(value.params.requestId)) Object.assign(network.get(value.params.requestId),{failed:value.params.timestamp,error:value.params.errorText,canceled:value.params.canceled}); else if(value.method==='Network.webSocketCreated')sockets.set(value.params.requestId,value.params.url); else if(value.method==='Network.webSocketFrameReceived'){const p=value.params;socketFrames.push({id:p.requestId,url:sockets.get(p.requestId),at:p.timestamp,bytes:p.response.opcode===2?Buffer.from(p.response.payloadData,'base64').byteLength:Buffer.byteLength(p.response.payloadData)})} }
  await call('Runtime.enable'); await call('Page.enable'); await call('Target.setDiscoverTargets',{discover:true}); await call('Network.enable'); await call('HeapProfiler.enable'); await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 913, deviceScaleFactor: 1, mobile: false })
  await call('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation })
  const navigationStarted = performance.now(), navigationStartedUnixMs=Date.now(); await call('Page.navigate', { url: info.url })
  while (!await evaluate(`Boolean(document.querySelector('iframe[src*="/world/runs/"]')?.contentDocument?.querySelector('.explorer-controls'))`)) { if (performance.now() - navigationStarted > 45000) throw Error('World controls did not mount'); await Bun.sleep(50) }
  const mounted = { navigationToControlsMs: performance.now() - navigationStarted, world: await world('return {at:w.performance.now(),pending:q.pending,jobs:q.jobs.length,sources:q.sources.length}') }
  await world(`d.querySelector('button[aria-label="Close grid overview panel"]')?.click()`)
  await world(`q.begin('cold-native-full-site-3d',{mode:'3d',levelId:'all',readyCount:5,sourceInstances:[1,4]},'maplibregl-canvas');const b=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==='3D');b.click();d.querySelector('.explorer-controls .scope').click()`)
  await until(`return [...d.querySelectorAll('.scopes button')].some(b=>b.textContent.trim()==='All available layouts')`,'native full-site action')
  await world(`[...d.querySelectorAll('.scopes button')].find(b=>b.textContent.trim()==='All available layouts').click()`)
  const cold=await world('return q.current.promise');if(cold.pending||cold.glError||cold.sourceDraws.length!==2||cold.actionToGpuCompletedMs<cold.actionToAllRequiredSourcesFirstDrawMs)throw Error('Invalid all-family cold completion');actions.push(cold)
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
  const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(folder, 'final-native-map.png'), Buffer.from(shot.data, 'base64'))
  const observer = await world('return {sources:q.sources,jobs:q.jobs,draws:q.draws,uploads:q.uploads,errors:q.errors,pending:q.pending,overheadMs:q.overheadMs,userAgent:w.navigator.userAgent,timeOrigin:w.performance.timeOrigin}'), source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repository }).stdout.toString().trim()
  for (const item of network.values()) { item.startedWorldMs=item.wallTime*1000-observer.timeOrigin; item.phase=[...actions].reverse().find((action:any)=>item.startedWorldMs>=action.started)?.name??'navigation'; item.responseMs=item.response===undefined?null:(item.response-item.start)*1000 }
  await call('Page.navigate',{url:'about:blank'}); let physicalWorkerTargets:any[]=[]; const closeStarted=performance.now(); do { physicalWorkerTargets=(await call('Target.getTargets')).targetInfos.filter((value:any)=>value.type==='worker'&&/preparation-worker|source-compile/.test(value.url));if(!physicalWorkerTargets.length)break;await Bun.sleep(50) }while(performance.now()-closeStarted<10000); if(physicalWorkerTargets.length)throw Error('Closed native map retained physical worker targets')
  const result = { navigationStartedUnixMs, worldNavigationToFirst3dDrawMs:cold.firstDraw.at, hostNavigationToFirst3dDrawMs:observer.timeOrigin+cold.firstDraw.at-navigationStartedUnixMs, hostNavigationToAllSources3dDrawMs:observer.timeOrigin+cold.allRequiredSourcesFirstDrawAt-navigationStartedUnixMs, hostNavigationToAllSourcesGpuCompletionMs:observer.timeOrigin+cold.gpuCompletedAt-navigationStartedUnixMs, physicalWorkerTargetsAfterExit:physicalWorkerTargets, runnerCommit: source, testedAppCommit, testedApp: info, mounted, actions, gc, observer, apiRequests:[...network.values()], socketFrames, exceptions, instrumentationSha256: createHash('sha256').update(instrumentation).digest('hex'), limits: ['Real built loopback Host/World, paused isolated Run, production workers/viewports; no production instrumentation or model changes.', 'Dispatch and milestones use World performance.now. A matching prepared-array/VBO draw is observed. Full-site cold completion requires both actual source-family cohorts (four unit instances and one campus) BEFORE a new microtask GPU fence; pending0/DOMready alone cannot satisfy it. Fence completion is not a physical-monitor timestamp.' , 'Vector Plan is a separate Canvas2D milestone: actual matching-level ink after prepared-view evidence, then two RAF scheduling frames with no pending jobs. No WebGL fence or GPU-completion claim is attached to Canvas2D paint.', 'Prepared response includes queue/worker/transfer; no controller-ready timestamp is claimed without a product hook. First matching draw proves admission occurred by that point.', 'WeakMap tags and primitive-only logs do not retain prepared arrays across forced GC. Instrumentation adds overhead; draw-wrapper diagnostic cost is reported separately and does not include every wrapper.', 'No fixed settlement sleeps. Initial controls mount is separate from layout completion. One GPU/profile/device and local services; full-product and isolated-engine timings are not interchangeable.'] }
  if (observer.errors.length || observer.pending || exceptions.length || observer.sources.some((item: any) => !item.ok || !item.responseAt || !item.terminatedAt)) throw Error('Loading observer found unfinished/failed product work')
  await writeFile(join(folder, 'receipt.json'), JSON.stringify(result, null, 2)); console.log('DONE', folder)
} catch (error) {
  const failure: any = { error: String(error), actions, gc, exceptions }; try { failure.observer = await world('return {sources:q?.sources,jobs:q?.jobs,draws:q?.draws?.slice(-20),errors:q?.errors,pending:q?.pending,current:q?.current}'); } catch (diagnosticError) { failure.diagnosticError = String(diagnosticError) }; await writeFile(join(folder, 'failure.json'), JSON.stringify(failure, null, 2)); throw error
} finally { socket?.close(); chrome.kill(); await chrome.exited; await rm(profile, { recursive: true, force: true }) }
