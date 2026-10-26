// Actual R3 product qualification: public UI + published local Run capabilities.
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
const input=process.argv[2],folder=resolve(process.argv[3]??'')
if(!input||!process.argv[3])throw Error('Usage: r3-product-probe.ts qa-run.json evidence-directory')
const info=await Bun.file(resolve(input)).json(),repository=resolve(import.meta.dir,'../../../..'),testedRef=process.env.LEITBILD_LOADING_TESTED_COMMIT,dpr=Number(process.env.LEITBILD_PHYSICAL_PROBE_DPR??1)
if(!testedRef||!['127.0.0.1','localhost','[::1]'].includes(new URL(info.url).hostname)||!(dpr>0))throw Error('A frozen app commit, positive DPR and isolated local Run are required')
const testedAppCommit=Bun.spawnSync(['git','rev-parse',testedRef],{cwd:repository}).stdout.toString().trim()
await mkdir(folder,{recursive:true})
const built=await Bun.build({entrypoints:[resolve(import.meta.dir,'../../tests/browser/physical-scene/r3-product-instrumentation.ts')],target:'browser',format:'iife',minify:false})
if(!built.success)throw new AggregateError(built.logs,'R3 test observer build failed')
const instrumentation=await built.outputs[0]!.text(),profile=await mkdtemp(join(tmpdir(),'leitbild-r3-product-')),phases:any[]=[],events:any[]=[]
const chrome=Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=1440,1000',`--force-device-scale-factor=${dpr}`,'about:blank'],{stdout:'ignore',stderr:Bun.file(join(folder,'chrome.stderr.log'))})
let socket:WebSocket|null=null,count=0
const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:unknown)=>void}>(),call=(method:string,params:any={}):Promise<any>=>new Promise((resolve,reject)=>{const id=++count;pending.set(id,{resolve,reject});socket!.send(JSON.stringify({id,method,params}))})
const evaluate=async(expression:string)=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,timeout:60000});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result?.value}
const inWorld=(body:string)=>evaluate(`(()=>{const w=document.querySelector('iframe[src*="/world/runs/"]').contentWindow,d=w.document.querySelector('.layout-browser')??w.document,q=w.__r3ProductProof;${body}})()`)
const until=async(body:string,label:string)=>{const start=performance.now();while(performance.now()-start<45000){if(await inWorld(body))return;await Bun.sleep(50)}throw Error(`Timed out: ${label}: ${await inWorld('return w.document.body.innerText.slice(-1800)')}`)}
const settled=async(expectedCount?:number)=>{
  await inWorld('return new Promise(resolve=>w.requestAnimationFrame(()=>w.requestAnimationFrame(resolve)))')
  await until(`const text=d.querySelector('.explorer-controls .evidence')?.textContent??'';return q.pending===0&&!/\\b[1-9]\\d* loading\\b/.test(text)&&${expectedCount?`text.includes('${expectedCount} layouts ready')`:`/Paused · fresh|Live ·|layouts ready/.test(text)`}`,'matching physical view and owner evidence')
  await inWorld('return new Promise(resolve=>w.requestAnimationFrame(()=>w.requestAnimationFrame(resolve)))')
}
const button=async(label:string)=>{await inWorld(`const b=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&b.getBoundingClientRect().width>0);if(!b)throw Error(${JSON.stringify('Missing button '+label)});b.click()`);await settled()}
const floor=async(label:string)=>{await inWorld(`const input=d.querySelector('select[aria-label="Layout level"]'),option=[...input.options].find(o=>o.text.includes(${JSON.stringify(label)}));if(!option)throw Error('Missing authored floor');input.value=option.value;input.dispatchEvent(new w.Event('change',{bubbles:true}))`);await settled()}
const scope=async()=>{await inWorld(`d.querySelector('.explorer-controls .scope').click();const input=d.querySelector('.scopes input[type=search]');input.value='Turbine hall';input.dispatchEvent(new w.Event('input',{bubbles:true}))`);await until(`return [...d.querySelectorAll('.scopes button[title]')].some(b=>b.title==='Halden Unit 1 full plant / PWR unit / Turbine hall')`,'authored hall scope');await inWorld(`[...d.querySelectorAll('.scopes button[title]')].find(b=>b.title==='Halden Unit 1 full plant / PWR unit / Turbine hall').click()`);await settled()}
const execution=async(playback:'paused'|'playing')=>{const response=await fetch(new URL(`/api/workspaces/${info.workspaceId}/capabilities/world.simulation-run.execution.set/invoke`,info.url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resource:info.resource,input:{playback}})});if(!response.ok)throw Error(await response.text());const value=await response.json();if(value.result.playback!==playback)throw Error('Execution capability did not apply the requested local state');return value.result}
const snapshot=()=>inWorld('return q.snapshot()')
const shot=async(name:string)=>{const value=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(folder,name),Buffer.from(value.data,'base64'))}
const movement=async(name:string,selector:string,orbit:boolean,playing:boolean)=>{
  if(orbit)await button('Orbit')
  if(playing){await execution('playing');if(name.includes('room')||name.includes('map-'))await until(`return /Live ·/.test(d.querySelector('.explorer-controls .evidence')?.textContent??'')`,'live owner session')}else await execution('paused')
  await settled();await inWorld('q.reset()')
  const point=await evaluate(`(()=>{const f=document.querySelector('iframe[src*="/world/runs/"]'),a=f.getBoundingClientRect(),b=f.contentDocument.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:a.x+b.x+b.width*.27,y:a.y+b.y+b.height*.46}})()`)
  await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1})
  const start=performance.now();let moves=0
  while(performance.now()-start<4000){await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+Math.sin(moves*.18)*65,y:point.y+Math.cos(moves*.15)*22,button:'left',buttons:1});moves++;await Bun.sleep(16)}
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1})
  const value=await snapshot(),processWindows=await inWorld(`return w.document.querySelectorAll('.display-window').length`)
  if(!value.frames||!(value.rafMedianMs>0)||processWindows||value.pending||value.errors.length)throw Error(`Invalid actual R3 motion window ${name}`)
  if(name.includes('plan')&&(!value.fillTextCalls||!value.drawnTexts.length||!value.draftingCanvases.some((canvas:any)=>canvas.width>0&&canvas.height>0)))throw Error(`Plan window ${name} did not draw actual source annotations`)
  if(!value.ownedPhysicalTargets.length||value.ownedPhysicalTargets.some((target:any)=>target.depthBytes<=0))throw Error(`${name} lacks the actual floating physical target`)
  phases.push({name,playing,moves,processWindows,...value});console.log(name,JSON.stringify({p95:value.rafP95Ms,frames:value.frames,longTasks:value.longTasks.length,texts:value.drawnTexts.length,targets:value.ownedPhysicalTargets,drafting:value.draftingCanvases}));await writeFile(join(folder,'partial.json'),JSON.stringify({phases},null,2))
}
try{
  let port=0;for(let i=0;i<80;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0])}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}if(port)break;await Bun.sleep(50)}if(!port)throw Error('Isolated Chrome did not start')
  const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{socket!.onopen=()=>resolve();socket!.onerror=reject})
  socket.onmessage=event=>{const message=JSON.parse(String(event.data)),request=pending.get(message.id);if(request){pending.delete(message.id);message.error?request.reject(message.error):request.resolve(message.result)}else if(message.method==='Runtime.exceptionThrown')events.push(message.params.exceptionDetails)}
  await call('Runtime.enable');await call('Page.enable');await call('Target.setDiscoverTargets',{discover:true});await call('Emulation.setDeviceMetricsOverride',{width:1440,height:913,deviceScaleFactor:dpr,mobile:false});await call('Page.addScriptToEvaluateOnNewDocument',{source:instrumentation});await call('Page.navigate',{url:info.url})
  const mounted=performance.now();while(!await evaluate(`Boolean(document.querySelector('iframe[src*="/world/runs/"]')?.contentDocument?.querySelector('.explorer-controls'))`)){if(performance.now()-mounted>45000)throw Error('World did not mount');await Bun.sleep(50)}
  await inWorld(`d.querySelector('button[aria-label="Close grid overview panel"]')?.click()`)
  await button('Open layout browser');await settled(5)
  await movement('browser-site-3d-paused','.layout-canvas',true,false)
  await movement('browser-site-3d-playing','.layout-canvas',true,true)
  await execution('paused');await button('Plan');await settled(5);await shot('site-plan.png')
  await movement('browser-site-plan-paused','.layout-canvas',false,false)
  await movement('browser-site-plan-playing','.layout-canvas',false,true)
  await execution('paused');await scope();await floor('Turbine and main control');await button('3D');await button('Home')
  await movement('browser-room-3d-paused','.layout-canvas',true,false)
  await movement('browser-room-3d-playing','.layout-canvas',true,true)
  await execution('paused');await button('Plan');await button('Home');await shot('room-plan.png')
  await movement('browser-room-plan-paused','.layout-canvas',false,false)
  await movement('browser-room-plan-playing','.layout-canvas',false,true)
  await execution('paused');await button('Back to map');const browserClosed=await snapshot()
  if(browserClosed.ownedPhysicalTargets.some((target:any)=>target.surface?.includes('layout-canvas')))throw Error('Closed dedicated host retained its physical targets')
  await scope();await button('3D');await floor('Turbine and main control');await button('Home')
  await movement('map-room-3d-paused','.maplibregl-canvas',true,false)
  await movement('map-room-3d-playing','.maplibregl-canvas',true,true)
  await execution('paused');await button('Plan');await button('Home')
  await movement('map-room-plan-paused','.maplibregl-canvas',false,false)
  await movement('map-room-plan-playing','.maplibregl-canvas',false,true)
  await execution('paused');await button('Open layout browser');await settled();const reopened=await snapshot()
  if(reopened.ownedPhysicalTargets.some((target:any)=>target.surface?.includes('maplibregl-canvas')))throw Error('Inactive map retained owned physical targets')
  await button('Plan');await button('Home');await movement('browser-return-plan-paused','.layout-canvas',false,false);await shot('returned-room-plan.png')
  const beforeExit=await snapshot(),metadata=await inWorld('return {userAgent:w.navigator.userAgent,reportedLogicalCpus:w.navigator.hardwareConcurrency,dpr:w.devicePixelRatio}')
  await call('Page.navigate',{url:'about:blank'});let physicalWorkerTargets:any[]=[];const stopAt=performance.now()+10000
  do{physicalWorkerTargets=(await call('Target.getTargets')).targetInfos.filter((item:any)=>item.type==='worker'&&/preparation-worker|source-compile/.test(item.url));if(!physicalWorkerTargets.length)break;await Bun.sleep(50)}while(performance.now()<stopAt)
  if(physicalWorkerTargets.length||events.length)throw Error('R3 page close left physical worker targets or exceptions')
  const result={testedAppCommit,runnerCommit:Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:repository}).stdout.toString().trim(),instrumentationSha256:createHash('sha256').update(instrumentation).digest('hex'),run:info,metadata,phases,browserClosed,reopened,beforeExit,physicalWorkerTargetsAfterExit:physicalWorkerTargets,exceptions:events,limits:['Actual built Host/World UI and published capabilities on one isolated local R3 Run. No production Run commands or geometry fixtures.','View/floor settlement follows actual loading/owner evidence and two painted scheduling frames; no fixed helper settlement sleeps. Motion windows use actual input and RAF, not GPU execution timers.','Canvas fillText records are actual drafting calls. Backing-store counters include observed float32/MSAA renderbuffers and resolve texture, plus Canvas2D RGBA lower bounds; they exclude driver/process overhead.','Resource observers retain primitive metadata and weak resource keys only. Instrumentation adds overhead; annotation spy time is recorded, other callback overhead is not separately attributed.','DPR and hardware are recorded per run. This is not WAN, constrained-device or human usability qualification.']}
  await writeFile(join(folder,'receipt.json'),JSON.stringify(result,null,2));console.log('DONE',folder)
}catch(error){const failure:any={error:String(error),phases,events};try{failure.snapshot=await snapshot()}catch(diagnosticError){failure.diagnosticError=String(diagnosticError)}await writeFile(join(folder,'failure.json'),JSON.stringify(failure,null,2));throw error}
finally{try{await execution('paused')}finally{socket?.close();chrome.kill();await chrome.exited;await rm(profile,{recursive:true,force:true})}}
