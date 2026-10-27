// Actual single-native-map product qualification: public UI + published local Run capabilities.
import { nativeMapStartup } from '../../tests/browser/physical-scene/native-map-startup.ts'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
const input=process.argv[2],folder=resolve(process.argv[3]??'')
if(!input||!process.argv[3])throw Error('Usage: native-map-product-probe.ts qa-run.json evidence-directory')
const info=await Bun.file(resolve(input)).json(),repository=resolve(import.meta.dir,'../../../..'),testedRef=process.env.LEITBILD_LOADING_TESTED_COMMIT,dpr=Number(process.env.LEITBILD_PHYSICAL_PROBE_DPR??1)
if(!testedRef||!['127.0.0.1','localhost','[::1]'].includes(new URL(info.url).hostname)||!(dpr>0))throw Error('A frozen app commit, positive DPR and isolated local Run are required')
const testedAppCommit=Bun.spawnSync(['git','rev-parse',testedRef],{cwd:repository}).stdout.toString().trim()
await mkdir(folder,{recursive:true})
const built=await Bun.build({entrypoints:[resolve(import.meta.dir,'../../tests/browser/physical-scene/native-map-product-instrumentation.ts')],target:'browser',format:'iife',minify:false})
if(!built.success)throw new AggregateError(built.logs,'Native map observer build failed')
const runnerSha256=createHash('sha256').update(await Bun.file(import.meta.path).arrayBuffer().then(buffer=>new Uint8Array(buffer))).digest('hex')
const replayPath=process.env.LEITBILD_NATIVE_REPLAY_INPUT,replay=replayPath?await Bun.file(resolve(replayPath)).json():null
const gpuDiagnostic=process.env.LEITBILD_NATIVE_GPU_DIAGNOSTIC==='1'
const matchedCamera=process.env.LEITBILD_NATIVE_MATCHED_CAMERA==='1',resourceDiagnostic=process.env.LEITBILD_NATIVE_RESOURCE_DIAGNOSTIC==='1'
const allLayersOn=process.env.LEITBILD_NATIVE_ALL_LAYERS_ON==='1'
const layerSelections:any[]=[]
let gpuSource='';if(gpuDiagnostic){const gpu=await Bun.build({entrypoints:[resolve(import.meta.dir,'../../tests/browser/physical-scene/native-map-gpu-instrumentation.ts')],target:'browser',format:'iife',minify:false});if(!gpu.success)throw new AggregateError(gpu.logs,'GPU diagnostic observer build failed');gpuSource=await gpu.outputs[0]!.text()}
const instrumentation=await built.outputs[0]!.text()+'\n'+gpuSource,profile=await mkdtemp(join(tmpdir(),'leitbild-native-map-product-')),phases:any[]=[],events:any[]=[],collectionFloors:any[]=[]
const chrome=Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=1440,1000',`--force-device-scale-factor=${dpr}`,'about:blank'],{stdout:'ignore',stderr:Bun.file(join(folder,'chrome.stderr.log'))})
let socket:WebSocket|null=null,count=0
const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:unknown)=>void}>(),call=(method:string,params:any={}):Promise<any>=>new Promise((resolve,reject)=>{const id=++count;pending.set(id,{resolve,reject});socket!.send(JSON.stringify({id,method,params}))})
const evaluate=async(expression:string)=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,timeout:60000});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result?.value}
const inWorld=(body:string)=>evaluate(`(()=>{const w=document.querySelector('iframe[src*="/world/runs/"]').contentWindow,d=w.document,q=w.__nativeMapProductProof;${body}})()`)
const until=async(body:string,label:string)=>{const start=performance.now();while(performance.now()-start<45000){if(await inWorld(body))return;await Bun.sleep(50)}throw Error(`Timed out: ${label}: ${await inWorld('return w.document.body.innerText.slice(-1800)')}`)}
const settled=async(expectedCount?:number)=>{
  await inWorld('return new Promise(resolve=>w.requestAnimationFrame(()=>w.requestAnimationFrame(resolve)))')
  await until(`const text=d.querySelector('.explorer-controls .evidence')?.textContent??'';return q.pending===0&&!/\\b[1-9]\\d* loading\\b/.test(text)&&${expectedCount?`text.includes('${expectedCount} layouts ready')`:`/Paused · fresh|Live ·|layouts ready/.test(text)`}`,'matching physical view and owner evidence')
  await inWorld('return new Promise(resolve=>w.requestAnimationFrame(()=>w.requestAnimationFrame(resolve)))')
}
const button=async(label:string)=>{await inWorld(`const b=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&b.getBoundingClientRect().width>0);if(!b)throw Error(${JSON.stringify('Missing button '+label)});b.click()`);await settled()}
const home=async()=>{await inWorld(`const surface=d.querySelector('.maplibregl-canvas');if(!surface)throw Error('Missing physical keyboard surface');surface.focus()`);await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36});await settled()}
const floor=async(label:string)=>{await inWorld(`const input=d.querySelector('select[aria-label="Layout level"]'),option=[...input.options].find(o=>o.text.includes(${JSON.stringify(label)}));if(!option)throw Error('Missing authored floor');input.value=option.value;input.dispatchEvent(new w.Event('change',{bubbles:true}))`);await settled()}
const scope=async()=>{await inWorld(`d.querySelector('.explorer-controls .scope').click()`);await until(`return Boolean(d.querySelector('.scopes input[type=search]'))`,'rendered area search');await inWorld(`const input=d.querySelector('.scopes input[type=search]');input.value='Turbine hall';input.dispatchEvent(new w.Event('input',{bubbles:true}))`);await until(`return [...d.querySelectorAll('.scopes button[title]')].some(b=>b.title==='Halden Unit 1 full plant / PWR unit / Turbine hall and feedwater pump annex')`,'authored hall scope');await inWorld(`[...d.querySelectorAll('.scopes button[title]')].find(b=>b.title==='Halden Unit 1 full plant / PWR unit / Turbine hall and feedwater pump annex').click()`);await settled()}
const enableAllDeclaredLayers=async()=>{
  await inWorld(`d.querySelector('.explorer-controls .scope').click()`);await until(`return Boolean(d.querySelector('.scopes input[type=search]'))`,'layout hierarchy')
  await inWorld(`const input=d.querySelector('.scopes input[type=search]');input.value='layout';input.dispatchEvent(new w.Event('input',{bubbles:true}))`)
  await until(`return [...d.querySelectorAll('.choose-area')].filter(button=>button.querySelector('small')?.textContent==='layout').length===5`,'all five authored layout roots')
  const roots=await inWorld(`return [...d.querySelectorAll('.choose-area')].filter(button=>button.querySelector('small')?.textContent==='layout').map(button=>button.title)`)
  await inWorld(`d.querySelector('[aria-label="Close area chooser"]').click()`)
  for(const title of roots){
    const responseStart=await inWorld('return q.responses.length')
    await inWorld(`d.querySelector('.explorer-controls .scope').click()`);await until(`return Boolean(d.querySelector('.scopes input[type=search]'))`,'root chooser')
    await inWorld(`const input=d.querySelector('.scopes input[type=search]');input.value=${JSON.stringify(title)};input.dispatchEvent(new w.Event('input',{bubbles:true}))`);await until(`return [...d.querySelectorAll('.choose-area')].some(button=>button.title===${JSON.stringify(title)})`,'exact declared layout')
    await inWorld(`[...d.querySelectorAll('.choose-area')].find(button=>button.title===${JSON.stringify(title)}).click()`);await settled()
    await button('View')
    const labels=await inWorld(`const declared=new Set(q.declaredSources.flatMap(source=>source.layers.map(layer=>layer.label)));return [...d.querySelectorAll('.settings label')].filter(label=>declared.has(label.textContent.trim())).map(label=>({label:label.textContent.trim(),before:label.querySelector('input').checked}))`)
    for(const value of labels){if(!value.before){await inWorld(`const input=[...d.querySelectorAll('.settings label')].find(label=>label.textContent.trim()===${JSON.stringify(value.label)}).querySelector('input');input.click()`);await settled()}}
    const after=await inWorld(`const declared=new Set(q.declaredSources.flatMap(source=>source.layers.map(layer=>layer.label)));return [...d.querySelectorAll('.settings label')].filter(label=>declared.has(label.textContent.trim())).map(label=>({label:label.textContent.trim(),checked:label.querySelector('input').checked}))`)
    if(after.some((layer:any)=>!layer.checked))throw Error('Requested source layer did not remain enabled')
    layerSelections.push({title,labels,after,responses:await inWorld(`return q.responses.slice(${responseStart})`)});await button('View')
  }
  await inWorld(`d.querySelector('.explorer-controls .scope').click()`);await until(`return [...d.querySelectorAll('.scopes button')].some(b=>b.textContent.trim()==='All available layouts')`,'collection return');await inWorld(`[...d.querySelectorAll('.scopes button')].find(b=>b.textContent.trim()==='All available layouts').click()`);await settled(5)
}
const collectionFloorMenu = async () => { await inWorld(`if(!d.querySelector('.collection-floor'))d.querySelector('.floors-toggle')?.click()`);await until(`return Boolean(d.querySelector('.collection-floor'))`,'grouped floor choices') }
const collectionFloor = async (label:string,restore=false) => {
  await collectionFloorMenu()
  const before=await inWorld(`const rows=[...d.querySelectorAll('.collection-floor')];if(rows.length!==2)throw Error('The retained unit/campus fixture did not expose its two exact floor profiles');const row=rows.find(row=>row.querySelector('small')?.textContent.startsWith('4 layouts'));if(!row)throw Error('The repeated unit Design does not expose its complete four-placement floor control');const select=row.querySelector('select'),option=[...select.options].find(option=>${restore?'true':'false'}?option.value==='all':option.text.includes(${JSON.stringify(label)}));if(!option)throw Error('Missing authored grouped floor');const previous=rows.map(row=>({label:row.title,value:row.querySelector('select').value})),jobStart=q.workerMessages.length;select.value=option.value;select.dispatchEvent(new w.Event('change',{bubbles:true}));return {previous,chosen:option.value,jobStart}`)
  await settled(5)
  await collectionFloorMenu()
  const after=await inWorld(`const rows=[...d.querySelectorAll('.collection-floor')],row=rows.find(row=>row.querySelector('small')?.textContent.startsWith('4 layouts')),select=row.querySelector('select');if(select.value!==${JSON.stringify(before.chosen)}||select.querySelector('option[value=""]'))throw Error('Group floor did not reach every repeated unit, or became Mixed');const other=rows.find(value=>value!==row),previous=${JSON.stringify(before.previous)}.find(value=>value.label===other.title);if(other.querySelector('select').value!==previous.value)throw Error('Changing unit floors changed the unrelated campus profile');return{rows:rows.map(row=>({label:row.title,value:row.querySelector('select').value})),jobs:q.workerMessages.slice(${before.jobStart})}`)
  collectionFloors.push({label,restore,...before,...after});await inWorld(`d.querySelector('.floors-toggle[aria-expanded=true]')?.click()`)
}
const execution=async(playback:'paused'|'playing')=>{const response=await fetch(new URL(`/api/workspaces/${info.workspaceId}/capabilities/world.simulation-run.execution.set/invoke`,info.url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resource:info.resource,input:{playback}})});if(!response.ok)throw Error(await response.text());const value=await response.json();if(value.result.playback!==playback)throw Error('Execution capability did not apply the requested local state');return value.result}
const snapshot=()=>inWorld('return q.snapshot()')
const shot=async(name:string)=>{const value=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(folder,name),Buffer.from(value.data,'base64'))}
const resources=async()=>{
  if(!resourceDiagnostic)return null
  const heap=await call('Runtime.getHeapUsage'),performanceMetrics=await call('Performance.getMetrics'),processTable=Bun.spawnSync(['ps','-Ao','pid=,ppid=,rss=']).stdout.toString().trim().split('\n').map(line=>{const [pid,ppid,rssKiB]=line.trim().split(/\s+/).map(Number);return{pid:pid!,ppid:ppid!,rssKiB:rssKiB!}}),owned=new Set([chrome.pid]);let changed=true
  while(changed){changed=false;for(const row of processTable)if(owned.has(row.ppid)&&!owned.has(row.pid)){owned.add(row.pid);changed=true}}
  const processes=processTable.filter(row=>owned.has(row.pid))
  return{heap,performanceMetrics:performanceMetrics.metrics,isolatedChromeProcesses:processes,sumRssKiB:processes.reduce((sum,row)=>sum+row.rssKiB,0),limits:'RSS is a sum of own Chrome process mappings, not unique physical memory/PSS; page-isolate heap excludes worker isolates and does not equal prepared/driver bytes.'}
}
const movement=async(name:string,selector:string,orbit:boolean,playing:boolean)=>{
  if(orbit)await button('Orbit')
  if(playing){await execution('playing');if(name.includes('room'))await until(`return /Live ·/.test(d.querySelector('.explorer-controls .evidence')?.textContent??'')`,'live owner session')}else await execution('paused')
  await settled();if(matchedCamera)await home();const poseStart=(matchedCamera||replay)?{native:(await snapshot()).nativeCameraProjection,plan:(await snapshot()).firstActualPlanInkTransform}:null,resourcesStart=await resources();if(gpuDiagnostic)await inWorld('w.__nativePhysicalGpuProof.reset()');await inWorld('q.reset()')
  const point=await evaluate(`(()=>{const f=document.querySelector('iframe[src*="/world/runs/"]'),a=f.getBoundingClientRect(),b=f.contentDocument.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:a.x+b.x+b.width*.27,y:a.y+b.y+b.height*.46}})()`)
  const profileThis=process.env.LEITBILD_NATIVE_PROFILE_WINDOW===name
  if(profileThis){await call('Profiler.enable');await call('Profiler.start')}
  await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1})
  const start=performance.now(),replayWindow=replay?.phases?.find((phase:any)=>phase.name===name);if(replay&&!replayWindow)throw Error('Replay input lacks '+name);let moves=0
  while(replayWindow?moves<replayWindow.moves:performance.now()-start<4000){if(replayWindow){const remaining=start+moves*4000/replayWindow.moves-performance.now();if(remaining>0)await Bun.sleep(remaining)}await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+(matchedCamera?Math.sin((performance.now()-start)/4000*Math.PI*6):Math.sin(moves*.18))*65,y:point.y+(matchedCamera?Math.sin((performance.now()-start)/4000*Math.PI*4):Math.cos(moves*.15))*22,button:'left',buttons:1});moves++;if(!replayWindow)await Bun.sleep(16)}if(replayWindow&&performance.now()-start<4000)await Bun.sleep(4000-(performance.now()-start))
  if(matchedCamera)await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point,button:'left',buttons:1})
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1})
  if(profileThis){const profile=await call('Profiler.stop');await writeFile(join(folder,`${name}.cpuprofile`),JSON.stringify(profile.profile))}
  const value=await snapshot(),processWindows=await inWorld(`return w.document.querySelectorAll('.display-window').length`)
  if((matchedCamera||replay)&&!value.inputButtons.length)throw Error('Diagnostic captured no trusted DOM input evidence');if(!value.frames||!(value.rafMedianMs>0)||processWindows||value.pending||value.errors.length)throw Error(`Invalid actual native-map motion window ${name}`)
  if(allLayersOn&&!name.includes('plan')){if(!value.physicalDraws.length)throw Error('No current physical VBO draw witnessed');for(const draw of value.physicalDraws){const family=value.declaredSources.find((source:any)=>draw.key.startsWith(source.geometryKey+'/[')),parts=JSON.parse(draw.key.slice(draw.key.lastIndexOf('/[')+1)),coverage=parts.find((part:any)=>part&&typeof part==='object'&&!Array.isArray(part)&&Array.isArray(part.layers))?.layers;if(!family||!coverage||family.meshLayerIds.some((id:string)=>!coverage.includes(id)))throw Error(`Actual GPU draw ${draw.key} does not cover every requested source mesh layer`)}}
  if(name.includes('plan')&&!value.draftingCanvases.some((canvas:any)=>canvas.width>0&&canvas.height>0))throw Error(`Plan window ${name} did not allocate its applicable drafting surface`)
  if(name.includes('room-plan')||name.includes('return-plan')){
    const required=['HP','LP 1','GEN','TURBINE HALL']
    if(!value.fillTextCalls||required.some(text=>!value.drawnTexts.includes(text)))throw Error(`Room Plan ${name} did not draw the authored legible captions: ${required.filter(text=>!value.drawnTexts.includes(text)).join(', ')}`)
  }
  if(name.includes('plan')&&value.drawnTextAngles.some((text:any)=>text.min < -Math.PI/2||text.max > Math.PI/2))throw Error(`Plan ${name} painted upside-down text`)
  if(!name.includes('plan')&&(!value.ownedPhysicalTargets.length||value.ownedPhysicalTargets.some((target:any)=>target.depthBytes<=0)))throw Error(`${name} lacks the actual floating 3D target`)
  phases.push({name,playing,moves,processWindows,poseStart,poseEnd:(matchedCamera||replay)?{native:value.nativeCameraProjection,plan:value.firstActualPlanInkTransform}:null,resourcesStart,resourcesEnd:await resources(),gpu:gpuDiagnostic?await inWorld('return w.__nativePhysicalGpuProof.settle()'):null,...value});console.log(name,JSON.stringify({p95:value.rafP95Ms,frames:value.frames,longTasks:value.longTasks.length,texts:value.drawnTexts.length,targets:value.ownedPhysicalTargets,drafting:value.draftingCanvases}));await writeFile(join(folder,'partial.json'),JSON.stringify({phases},null,2))
  if(profileThis&&process.env.LEITBILD_NATIVE_PROFILE_ONLY==='1')throw Error('Requested diagnostic-only CPU profile completed; this run does not issue a qualification verdict')
}
try{
  let port=0;const chromeStarted=performance.now();while(performance.now()-chromeStarted<45000){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0])}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}if(port)break;if(chrome.exitCode!==null)throw Error(`Isolated Chrome exited before CDP was ready: ${chrome.exitCode}`);await Bun.sleep(50)}if(!port)throw Error('Isolated Chrome did not start within the test startup deadline')
  const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{socket!.onopen=()=>resolve();socket!.onerror=reject})
  socket.onmessage=event=>{const message=JSON.parse(String(event.data)),request=pending.get(message.id);if(request){pending.delete(message.id);message.error?request.reject(message.error):request.resolve(message.result)}else if(message.method==='Runtime.exceptionThrown')events.push(message.params.exceptionDetails)}
  await call('Runtime.enable');if(resourceDiagnostic)await call('Performance.enable');await call('Page.enable');await call('Target.setDiscoverTargets',{discover:true});await call('Emulation.setDeviceMetricsOverride',{width:1440,height:913,deviceScaleFactor:dpr,mobile:false});await call('Page.addScriptToEvaluateOnNewDocument',{source:`window.__nativeMapDiagnosticConfiguration={pose:${Boolean(matchedCamera||replay)}};\n${instrumentation}`} );await call('Page.navigate',{url:info.url})
  const startup=await evaluate(`(${nativeMapStartup.toString()})(true)`)
  await inWorld(`d.querySelector('button[aria-label="Close grid overview panel"]')?.click()`)
  const earlyPlanOnly=process.env.LEITBILD_NATIVE_EARLY_PLAN_ONLY==='1',sitePlanOnly=process.env.LEITBILD_NATIVE_SITE_PLAN_ONLY==='1',site3dOnly=process.env.LEITBILD_NATIVE_ONLY_SITE_3D==='1'
  if(earlyPlanOnly){
    await scope();await floor('Turbine and main control');await button('Plan');await home();await shot('room-plan.png')
    await movement('map-room-plan-paused','.maplibregl-canvas',false,false)
  }else{
  await until(`return !d.querySelector('.layout-browser,.layout-canvas')`,'one native map without an alternate viewport')
  await button('3D')
  await inWorld(`d.querySelector('.explorer-controls .scope').click()`)
  await until(`return [...d.querySelectorAll('.scopes button')].some(b=>b.textContent.trim()==='All available layouts')`,'native collection chooser')
  await inWorld(`[...d.querySelectorAll('.scopes button')].find(b=>b.textContent.trim()==='All available layouts').click()`)
  await settled(5)
  if(allLayersOn)await enableAllDeclaredLayers()
  if(!sitePlanOnly){await collectionFloor('Turbine and main control');await collectionFloor('Stack',true)
  await movement('map-site-3d-paused','.maplibregl-canvas',true,false)
  await movement('map-site-3d-playing','.maplibregl-canvas',true,true)}
  if(!site3dOnly){await execution('paused');await button('Plan');await settled(5);await shot('site-plan.png')
  await movement('map-site-plan-paused','.maplibregl-canvas',false,false)
  await movement('map-site-plan-playing','.maplibregl-canvas',false,true)
  if(!sitePlanOnly){await execution('paused');await scope();await floor('Turbine and main control');await button('3D');await home();await shot('room-3d.png')
  await movement('map-room-3d-paused','.maplibregl-canvas',true,false)
  await movement('map-room-3d-playing','.maplibregl-canvas',true,true)
  await execution('paused');await button('Plan');await home();await shot('room-plan.png')
  await movement('map-room-plan-paused','.maplibregl-canvas',false,false)
  await movement('map-room-plan-playing','.maplibregl-canvas',false,true)}
  await execution('paused')}
  }
  const beforeExit=await snapshot(),metadata=await inWorld('return {userAgent:w.navigator.userAgent,reportedLogicalCpus:w.navigator.hardwareConcurrency,dpr:w.devicePixelRatio}')
  await call('Page.navigate',{url:'about:blank'});let physicalWorkerTargets:any[]=[];const stopAt=performance.now()+10000
  do{physicalWorkerTargets=(await call('Target.getTargets')).targetInfos.filter((item:any)=>item.type==='worker'&&/preparation-worker|source-compile|architecture-bsp-worker/.test(item.url));if(!physicalWorkerTargets.length)break;await Bun.sleep(50)}while(performance.now()<stopAt)
  if(physicalWorkerTargets.length||events.length)throw Error('Native map page close left physical worker targets or exceptions')
  const result={testedAppCommit,runnerSha256,runnerCommit:Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:repository}).stdout.toString().trim(),instrumentationSha256:createHash('sha256').update(instrumentation).digest('hex'),earlyPlanOnly,sitePlanOnly,site3dOnly,matchedCamera,resourceDiagnostic,gpuDiagnostic,replayInput:replayPath?{path:resolve(replayPath),sha256:createHash('sha256').update(new Uint8Array(await Bun.file(resolve(replayPath)).arrayBuffer())).digest('hex'),method:'Original move counts and position formula; original event timestamps were not recorded, so commands are spaced uniformly over the original4second interval.'}:null,profiledWindow:process.env.LEITBILD_NATIVE_PROFILE_WINDOW??null,run:info,metadata,startup,allLayersOn,layerSelections,collectionFloors,phases,beforeExit,physicalWorkerTargetsAfterExit:physicalWorkerTargets,exceptions:events,limits:['Actual built Host/World on one native geographic map and one isolated local Run. No product browser or alternate camera; no production Run commands.','View/floor settlement follows actual loading/owner evidence and two painted scheduling frames; no fixed helper settlement sleeps. Motion windows use actual input and RAF, not GPU execution timers.','Canvas fillText records are actual drafting calls. Readable room Plan requires authored HP/LP1/GEN/room captions; whole-site fitting may legitimately reject text that exceeds actual building envelopes. Backing-store counters include observed float32/MSAA renderbuffers and resolve texture, plus Canvas2D RGBA lower bounds; they exclude driver/process overhead.','Resource observers retain primitive metadata and weak resource keys only. Instrumentation adds overhead; annotation spy time is recorded, other callback overhead is not separately attributed. Optional CPU profiling is a separate diagnostic run, not a clean performance sample.',...(gpuDiagnostic?['GPU elapsed queries and per-pass observers make this a diagnostic run, not a clean frame-budget qualification. Draw/resolve intervals are distinct; clear/composite are excluded and unsupported/disjoint/busy/aborted states are retained.']:[]),'DPR and hardware are recorded per run. This is not WAN, constrained-device or human usability qualification.']}
  await writeFile(join(folder,'receipt.json'),JSON.stringify(result,null,2));console.log('DONE',folder)
}catch(error){const failure:any={error:String(error),testedAppCommit,runnerSha256,instrumentationSha256:createHash('sha256').update(instrumentation).digest('hex'),phases,events};try{failure.snapshot=await snapshot()}catch(diagnosticError){failure.diagnosticError=String(diagnosticError)}await writeFile(join(folder,'failure.json'),JSON.stringify(failure,null,2));throw error}
finally{try{await execution('paused')}finally{socket?.close();chrome.kill();await chrome.exited;await rm(profile,{recursive:true,force:true})}}
