// Isolated full-product QA: real built Host + World + map assets + Run observations.
// No production source instrumentation, fixture geometry, or observation bypass.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const input = process.argv[2]
if (!input) throw Error('Usage: bun scripts/physical-layout/product-browser-probe.ts /path/to/isolated-qa-run.json [evidence-directory]')
const folder = process.argv[3] ? resolve(process.argv[3]) : await mkdtemp(join(tmpdir(), 'leitbild-product-evidence-'))
await mkdir(folder, { recursive: true })
const repository = resolve(import.meta.dir, '../../../..')
const info = await Bun.file(resolve(input)).json()
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(info.url).hostname)) throw Error('This playback-changing proof requires an isolated loopback Run, never production')
const profile = await mkdtemp(join(tmpdir(), 'leitbild-product-proof-'))
const chrome = Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', '--force-device-scale-factor=1', 'about:blank'], { stdout: 'ignore', stderr: Bun.file(join(folder, 'product-chrome.stderr.log')) })
let socket: WebSocket | null = null
let count = 0
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>()
const events: Array<{ method: string; params: any }> = []
const phases: any[] = []
const traceMap = process.env.QA_TRACE_MAP === '1'
const call = (method: string, params: any = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++count; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression: string) => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 60000 }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result?.value }
const W = `document.querySelector('iframe[src*="/world/runs/"]').contentWindow`
const inWorld = (body: string) => evaluate(`(()=>{const w=${W},d=w.document.querySelector('.layout-browser')??w.document;${body}})()`)
const until = async (body: string, label: string) => { const start = Date.now(); while (Date.now() - start < 45000) { if (await inWorld(body)) return; await Bun.sleep(100) } throw Error(`Timed out: ${label}: ${await inWorld('return w.document.body.innerText.slice(-2500)')}`) }
const button = (label: string) => inWorld(`const b=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)} && b.getBoundingClientRect().width>0);if(!b)throw Error(${JSON.stringify('Missing button '+label)});b.click()`)
const scope = async (path: string, search: string) => {
  await inWorld(`d.querySelector('.explorer-controls .scope').click()`)
  await inWorld(`const input=d.querySelector('.scopes input[type=search]');input.value=${JSON.stringify(search)};input.dispatchEvent(new w.Event('input',{bubbles:true}))`)
  await until(`return [...d.querySelectorAll('.scopes button[title]')].some(b=>b.title===${JSON.stringify(path)})`, path)
  await inWorld(`[...d.querySelectorAll('.scopes button[title]')].find(b=>b.title===${JSON.stringify(path)}).click()`)
  await Bun.sleep(500)
}
const floor = async (label: string) => { await inWorld(`const input=d.querySelector('select[aria-label="Layout level"]'),option=[...input.options].find(o=>o.text.includes(${JSON.stringify(label)}));if(!option)throw Error('Missing floor');input.value=option.value;input.dispatchEvent(new w.Event('change',{bubbles:true}))`); await Bun.sleep(700) }
const screenshot = async (name: string) => { const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(folder,name),Buffer.from(shot.data,'base64')) }
const reset = () => inWorld(`const q=w.__productProof;q.frames=[];q.tasks=[];q.previous=0;q.started=w.performance.now();const token=q.token=(q.token??0)+1;const step=t=>{if(q.token!==token)return;if(q.previous)q.frames.push(t-q.previous);q.previous=t;w.requestAnimationFrame(step)};w.requestAnimationFrame(step)`)
const stats = () => inWorld(`const q=w.__productProof, sorted=[...q.frames].sort((a,b)=>a-b);return {durationMs:w.performance.now()-q.started,frames:sorted.length,rafMedianMs:sorted[Math.floor(sorted.length*.5)],rafP95Ms:sorted[Math.floor(sorted.length*.95)],rafMaxMs:sorted.at(-1),longTasks:q.tasks,viewport:{width:w.innerWidth,height:w.innerHeight,dpr:w.devicePixelRatio},status:d.querySelector('.explorer-controls .evidence')?.textContent}`)
const movement = async (name: string, canvasSelector: string, tool: string | null = 'Orbit') => {
  if (tool !== null) await button(tool)
  await reset()
  const box = await evaluate(`(()=>{const iframe=document.querySelector('iframe[src*="/world/runs/"]'),a=iframe.getBoundingClientRect(),b=iframe.contentDocument.querySelector(${JSON.stringify(canvasSelector)}).getBoundingClientRect();return{x:a.x+b.x+b.width*.27,y:a.y+b.y+b.height*.46}})()`)
  await call('Input.dispatchMouseEvent',{type:'mousePressed',x:box.x,y:box.y,button:'left',clickCount:1})
  const start=Date.now();let step=0
  while(Date.now()-start<4000){await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x+Math.sin(step*.18)*65,y:box.y+Math.cos(step*.15)*22,button:'left',buttons:1});step++;await Bun.sleep(16)}
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:box.x,y:box.y,button:'left',clickCount:1})
  const displays=await inWorld(`return w.document.querySelectorAll('.display-window').length`)
  if(displays!==0)throw Error(`${name}: Orbit activated ${displays} process windows`)
  const sample=await stats();if(sample.frames<150 || !(sample.rafMedianMs>0))throw Error(`${name}: invalid RAF observer`)
  phases.push({name,...sample,inputMoves:step,processWindows:displays});console.log(name,JSON.stringify(phases.at(-1)));await writeFile(join(folder,'product-browser-partial.json'),JSON.stringify({phases},null,2))
}
const execution = async (playback: 'playing'|'paused') => { const base=new URL(info.url).origin+'/api/workspaces/'+info.workspaceId;const r=await fetch(base+'/capabilities/world.simulation-run.execution.set/invoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resource:info.resource,input:{playback}})});if(!r.ok)throw Error(await r.text()) }
try {
  let port=0;for(let i=0;i<80;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0])}catch(e){if((e as any).code!=='ENOENT')throw e}if(port)break;await Bun.sleep(100)}if(!port)throw Error('Chrome did not start')
  const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{socket!.onopen=()=>resolve();socket!.onerror=reject})
  socket.onmessage=event=>{const message=JSON.parse(String(event.data)),request=pending.get(message.id);if(request){pending.delete(message.id);message.error?request.reject(message.error):request.resolve(message.result)}else if(['Runtime.exceptionThrown','Network.responseReceived','Network.loadingFinished','Tracing.tracingComplete'].includes(message.method))events.push(message)}
  await call('Runtime.enable');await call('Page.enable');await call('Page.bringToFront');await call('Network.enable');await call('Emulation.setDeviceMetricsOverride',{width:1440,height:913,deviceScaleFactor:1,mobile:false})
  await call('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{window.__productProof={frames:[],tasks:[],messages:[],previous:0,started:performance.now()};new PerformanceObserver(list=>{for(const e of list.getEntries())window.__productProof.tasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true});const post=Worker.prototype.postMessage;Worker.prototype.postMessage=function(message,transfer){const physical=message?.kind==='register'||message?.kind==='prepare'||message?.design?.id;const started=performance.now();const bytes=physical&&Array.isArray(transfer)?transfer.reduce((s,b)=>s+(b.byteLength??0),0):0;const result=post.call(this,message,transfer);if(physical)window.__productProof.messages.push({kind:message.kind??'physical-source',sourceKey:message.sourceKey??message.design?.id,key:message.key,bytes,ms:performance.now()-started});return result}})()`})
  const started=Date.now();await call('Page.navigate',{url:info.url})
  // Wait for the real World iframe before reading its controls.
  while(!await evaluate(`Boolean(document.querySelector('iframe[src*="/world/runs/"]')?.contentDocument?.querySelector('.explorer-controls'))`)){if(Date.now()-started>45000)throw Error('World did not mount');await Bun.sleep(100)}
  const cold={wallMs:Date.now()-started,world:await stats(),host:await evaluate('window.__productProof.tasks'),userAgent:await evaluate('navigator.userAgent')}
  // The scenario initially opens its normal Grid panel; close it without altering Run truth.
  await inWorld(`d.querySelector('button[aria-label="Close grid overview panel"]')?.click()`)
  await button('Open layout browser');await until(`return d.querySelector('.explorer-controls .evidence')?.textContent.includes('5 layouts ready')`,'five real layouts ready')
  phases.push({name:'browser-initial-ready',...await stats()});await screenshot('product-browser-site.png')
  await movement('browser-site-paused','.layout-canvas');await execution('playing');await Bun.sleep(1000);await movement('browser-site-playing','.layout-canvas');await execution('paused')
  await scope('Halden Unit 1 full plant / PWR unit / Turbine hall','Turbine hall');await floor('Turbine and main control');await button('Home');await Bun.sleep(800)
  await screenshot('product-browser-turbine.png');await movement('browser-room-paused','.layout-canvas')
  await execution('playing');await Bun.sleep(1500);await movement('browser-room-playing','.layout-canvas');await execution('paused')
  await button('Plan');await Bun.sleep(800);await screenshot('product-browser-plan.png');await movement('browser-plan-paused','.layout-canvas',null)
  await execution('playing');await Bun.sleep(1000);await movement('browser-plan-playing','.layout-canvas',null);await execution('paused')
  await button('Back to map');await scope('Halden Unit 1 full plant / PWR unit / Turbine hall','Turbine hall');await button('3D');await floor('Turbine and main control');await button('Home');await Bun.sleep(1000)
  await screenshot('product-map-turbine.png');if(traceMap)await call('Tracing.start',{categories:'devtools.timeline,v8,disabled-by-default-v8.cpu_profiler',transferMode:'ReturnAsStream'});await movement('map-room-paused','.maplibregl-canvas')
  if(traceMap){await call('Tracing.end');while(!events.some(e=>e.method==='Tracing.tracingComplete'))await Bun.sleep(50);const stream=events.find(e=>e.method==='Tracing.tracingComplete')!.params.stream;let data='';for(;;){const chunk=await call('IO.read',{handle:stream});data+=chunk.data;if(chunk.eof)break}await call('IO.close',{handle:stream});await writeFile(join(folder,'product-map-trace.json'),data)}
  await execution('playing');await Bun.sleep(1500);await movement('map-room-playing','.maplibregl-canvas');await execution('paused')
  await button('Plan');await Bun.sleep(800);await screenshot('product-map-plan.png');await movement('map-plan-paused','.maplibregl-canvas',null);await button('3D');await Bun.sleep(500)
  await button('Open layout browser');await until(`return d.querySelector('select[aria-label="Layout level"]')?.selectedOptions[0]?.text.includes('Turbine and main control')`,'entry preserves floor')
  await screenshot('product-browser-entry-preserves.png')
  await call('Emulation.setDeviceMetricsOverride',{width:319,height:827,deviceScaleFactor:1,mobile:false});await Bun.sleep(800);await button('Home');await Bun.sleep(500);await screenshot('product-browser-narrow.png')
  const narrow=await inWorld(`return{width:w.innerWidth,height:w.innerHeight,scrollWidth:w.document.documentElement.scrollWidth,buttons:[...d.querySelectorAll('.explorer-controls button,.camera-controls button')].filter(b=>b.getBoundingClientRect().width>0).map(b=>{const r=b.getBoundingClientRect();return{text:b.textContent.trim(),x:r.x,y:r.y,width:r.width,height:r.height}}),title:d.querySelector('.explorer-controls .scope')?.textContent}`)
  const git=Bun.spawn(['git','rev-parse','HEAD'],{cwd:repository,stdout:'pipe'});const source=(await new Response(git.stdout).text()).trim();if(await git.exited!==0)throw Error('Cannot identify tested source')
  const result={source,run:info,cold,phases,narrow,messages:await inWorld('return w.__productProof.messages'),exceptions:events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails),network:events.filter(e=>e.method==='Network.responseReceived').map(e=>({url:e.params.response.url,status:e.params.response.status,encodedDataLength:e.params.response.encodedDataLength})),limits:['Real full built Host/World/MapLibre/PMTiles/ProcessPlant+Grid observations. Read-only production vector/reference asset proxy; isolated local Run/state.','One Apple M2 / headless Chrome / DPR1 desktop and narrow CSS viewport; not WAN, constrained-device or human-usability qualification.','RAF intervals include browser scheduling; not GPU execution time. Root observer does not attribute cold long tasks to a specific component. Source transport duplication remains.']}
  await writeFile(join(folder,traceMap?'product-browser-traced.json':'product-browser-proof.json'),JSON.stringify(result,null,2));console.log('DONE',traceMap?'product-browser-traced.json':'product-browser-proof.json')
} finally { await execution('paused');socket?.close();chrome.kill();await chrome.exited;await rm(profile,{recursive:true,force:true}) }
