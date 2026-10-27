// Actual one-map routed-edge pick -> hosted card -> process detail, local Run only.
import { nativeMapStartup } from '../../tests/browser/physical-scene/native-map-startup.ts'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { parseEmbeddedViewFragment } from '@leitbild/contracts'
const input=process.argv[2],folder=resolve(process.argv[3]??'');if(!input||!process.argv[3])throw Error('Usage: native-map-route-product-probe.ts qa-run.json evidence-directory')
const info=await Bun.file(resolve(input)).json(),testedRef=process.env.LEITBILD_LOADING_TESTED_COMMIT
const tested=testedRef?Bun.spawnSync(['git','rev-parse',testedRef],{cwd:resolve(import.meta.dir,'../../../..')}).stdout.toString().trim():''
if(!/^[a-f0-9]{40}$/.test(tested)||!['127.0.0.1','localhost','[::1]'].includes(new URL(info.url).hostname))throw Error('Explicit built commit and local Run required')
const source=await Bun.file(resolve(import.meta.dir,'../../src/packs/physical-layout/pwr-full-unit-connected.source.json')).json(),bindings=await Bun.file(resolve(import.meta.dir,'../../src/packs/physical-layout/pwr-full-unit-connected.bindings.json')).json()
const edge=source.routing.connections.find((edge:any)=>edge.graphConnectionId==='main-steam-header-to-turbine-stop-valve')
if(!edge||!bindings.some((binding:any)=>binding.elementId===edge.graphConnectionId&&binding.physicalElementId===edge.id))throw Error('Expected exact retained graph edge correspondence missing')
const design=(await Bun.file(resolve(import.meta.dir,'../../src/packs/physical-layout/pwr-full-unit-connected.design.json')).json()).design
const expected={design,sourceFrame:{origin:source.origin,northAxis:source.northAxis},elementId:edge.graphConnectionId,physicalId:edge.id,from:source.routing.terminals.find((port:any)=>port.id===edge.from),to:source.routing.terminals.find((port:any)=>port.id===edge.to)}
await mkdir(folder,{recursive:true});const built=await Bun.build({entrypoints:[resolve(import.meta.dir,'../../tests/browser/physical-scene/native-map-operation-instrumentation.ts')],target:'browser',format:'iife',minify:false});if(!built.success)throw new AggregateError(built.logs)
const instrumentation=`window.__nativeRouteTarget=${JSON.stringify({elementId:expected.elementId})};\n${await built.outputs[0]!.text()}`,profile=await mkdtemp(join(tmpdir(),'leitbild-route-ui-'))
const chrome=Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=1440,1000','about:blank'],{stdout:'ignore',stderr:Bun.file(join(folder,'chrome.stderr.log'))})
const deviceOnly=process.env.LEITBILD_OPERATION_DEVICE_ONLY==='1';const trials:any[]=[];let socket:WebSocket|null=null,sequence=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:unknown)=>void}>(),errors:any[]=[]
const call=(method:string,params:any={}):Promise<any>=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket!.send(JSON.stringify({id,method,params}))})
const evaluate=async(expression:string)=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,timeout:90000});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result?.value}
const W=`document.querySelector('iframe[src*="/world/runs/"]').contentWindow`,world=(body:string)=>evaluate(`(()=>{const w=${W},d=w.document,q=w.__nativeRouteProof;${body}})()`)
const until=async(body:string,label:string)=>{const start=performance.now();while(performance.now()-start<45000){if(await world(body))return;await Bun.sleep(50)}throw Error(`Timed out ${label}`)}
const settled=async()=>{await until(`const text=d.querySelector('.explorer-controls .evidence')?.textContent??'';return /Paused · fresh|Live ·/.test(text)`,'fresh focused owner');await world('return new Promise(resolve=>w.requestAnimationFrame(()=>w.requestAnimationFrame(resolve)))')}
const button=async(label:string)=>world(`const button=[...d.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(label)}&&button.getBoundingClientRect().width);if(!button)throw Error('Missing '+${JSON.stringify(label)});button.click()`)
const shot=async(name:string)=>{const value=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(folder,name),Buffer.from(value.data,'base64'))}
const click=async(point:{x:number;y:number})=>{await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1})}
try{
 let port=0;const start=performance.now();while(performance.now()-start<45000){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0])}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}if(port)break;if(chrome.exitCode!==null)throw Error('Chrome exited');await Bun.sleep(50)}if(!port)throw Error('No isolated CDP')
 const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{socket!.onopen=()=>resolve();socket!.onerror=reject});socket.onmessage=event=>{const result=JSON.parse(String(event.data)),request=pending.get(result.id);if(request){pending.delete(result.id);result.error?request.reject(result.error):request.resolve(result.result)}else if(result.method==='Runtime.exceptionThrown')errors.push(result.params.exceptionDetails)}
 await call('Runtime.enable');await call('Page.enable');await call('Target.setDiscoverTargets',{discover:true});await call('Emulation.setDeviceMetricsOverride',{width:1440,height:913,deviceScaleFactor:1,mobile:false});await call('Page.addScriptToEvaluateOnNewDocument',{source:instrumentation});await call('Page.navigate',{url:info.url})
 const startup=await evaluate(`(${nativeMapStartup.toString()})(true)`)

 const focusSubject=async(elementId:string,label?:string)=>{
  await button('Find');await until(`return Boolean(d.querySelector('.layout-components input[type=search]'))`,'component search')
  await world(`const input=d.querySelector('.layout-components input[type=search]');input.value=${JSON.stringify(elementId)};input.dispatchEvent(new w.Event('input',{bubbles:true}))`)
  await until(`return ${label?"[...d.querySelectorAll('.component-row')].some(row=>row.querySelector('strong')?.textContent.trim()==="+JSON.stringify(label)+")":"d.querySelectorAll('.component-row').length===1"}`,'exact subject search')
  await world(`const rows=[...d.querySelectorAll('.component-row')];const row=${label?"rows.find(row=>row.querySelector('strong')?.textContent.trim()==="+JSON.stringify(label)+")":"rows[0]"};row.querySelector('button').click()`)
  await world(`const option=d.querySelector('[aria-label="Choose physical focus floor"] button:not([aria-label])');option?.click()`)
  await settled()
 }
 const pointOnTarget=async(mode:string,physicalId=expected.physicalId)=>{
  await until(`return q.object?.id===${JSON.stringify(physicalId)}&&q.projectedFor(${JSON.stringify(mode)}).length>0`,'prepared actual target projection')
  const points=await evaluate(`(()=>{const f=document.querySelector('iframe[src*="/world/runs/"]'),offset=f.getBoundingClientRect(),w=f.contentWindow,d=w.document,covers=[...d.querySelectorAll('.layout-tools,.camera-controls,.layout-status')].map(e=>e.getBoundingClientRect());return w.__nativeRouteProof.projectedFor(${JSON.stringify(mode)}).filter(p=>!covers.some(b=>p.x>=b.left&&p.x<=b.right&&p.y>=b.top&&p.y<=b.bottom)).map(p=>({x:offset.x+p.x,y:offset.y+p.y}))})()`)
  const at=performance.now()
  for(const point of points){
   if(performance.now()-at>45000)break
   await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point,button:'none',buttons:0})
   const hit=await world(`return new Promise(resolve=>{const start=w.performance.now();const check=()=>{const label=d.querySelector('.layout-hover-label');if(label?.querySelector('strong')?.textContent.trim()===q.object.label){resolve({text:label.textContent,selection:q.selectionTables.at(-1)});return}if(w.performance.now()-start>190){resolve(null);return}w.requestAnimationFrame(check)};check()})`)
   if(hit)return{point,...hit}
  }
  throw Error('No actual pointer hit reached the exact route in '+mode)
 }
 const closeCard=async()=>{await world(`d.querySelector('.layout-inspection iframe')?.contentDocument?.querySelector('obc-button.close')?.click()`);await until(`return !d.querySelector('.layout-inspection')`,'closed exact card')}
 const readCard=async(elementId=expected.elementId)=>{
  await until(`const child=d.querySelector('.layout-inspection iframe')?.contentWindow;return child?.document.querySelector('[data-faceplate="${elementId}"]')&&/Paused · readings fresh|Live owner readings/.test(child.document.body.innerText)`,'exact fresh owner card')
  return world(`const iframe=d.querySelector('.layout-inspection iframe'),child=iframe.contentWindow;return{src:iframe.src,text:child.document.body.innerText,faceplate:child.document.querySelector('[data-faceplate]').dataset.faceplate,samples:child.__nativeRouteProof.operationSamples}`)
 }
 await world(`d.querySelector('button[aria-label="Close grid overview panel"]')?.click();d.querySelector('.explorer-controls .scope').click()`)
 await until(`return Boolean(d.querySelector('.scopes input[type=search]'))`,'scope picker')
 await world(`const input=d.querySelector('.scopes input[type=search]');input.value='Halden Unit 1 full plant';input.dispatchEvent(new w.Event('input',{bubbles:true}))`)
 await until(`return [...d.querySelectorAll('.scopes button[title]')].some(button=>button.title==='Halden Unit 1 full plant')`,'unit scope')
 await world(`[...d.querySelectorAll('.scopes button[title]')].find(button=>button.title==='Halden Unit 1 full plant').click()`);await settled()
 await button('View');await until(`return Boolean([...d.querySelectorAll('.settings label')].find(label=>label.textContent.trim()==='Utility routes'))`,'utility layer control')
 const defaultLayer=await world(`const label=[...d.querySelectorAll('.settings label')].find(label=>label.textContent.trim()==='Utility routes');return{checked:label.querySelector('input').checked,key:q.currentDrawKey,prepared:q.prepared}`)
 if(!defaultLayer.checked)throw Error('Utility routes are not visible by default before any toggle')
 await button('View')
 for(const mode of deviceOnly?[]:['3d','2d']){
  await button(mode==='3d'?'3D':'Plan');await settled();await focusSubject(expected.elementId)
  // An explicit floor is required for Plan; use the declared operating level.
  if(mode==='2d')await world(`const select=d.querySelector('select[aria-label="Layout level"]');if(!select)throw Error('Missing declared floor control');select.value='operating';select.dispatchEvent(new w.Event('change',{bubbles:true}))`)
  await settled();await world('q.selectionTables=[]')
  const hover=await pointOnTarget(mode)
  if(!hover.text.includes('From')||!hover.text.includes('To')||!hover.text.includes('Flow'))throw Error('Hover omitted exact route endpoints or actual flow context')
  await shot(mode+'-hover-highlight.png')
  if(mode==='3d'&&!hover.selection?.selected?.every((v:any)=>v.color[3]>0))throw Error('The actual route mesh selection table was not highlighted')
  // Direct physical click must open the edge, not its plant overview.
  await click(hover.point);const card=await readCard()
  const sample=card.samples.at(-1);if(!sample||sample.subject.elementId!==expected.elementId||sample.subject.topology?.kind!=='connection'||!sample.subject.topology.bindings.some((b:any)=>b.role==='flow'))throw Error('Hosted card did not receive exact owner route semantics')
  if(!card.text.includes('From')||!card.text.includes('To')||!card.text.includes('Flow'))throw Error('Card omitted route context')
  const envelope=parseEmbeddedViewFragment(new URL(card.src).hash),state=JSON.parse(envelope.state)
  if(state.elementId!==expected.elementId||state.objectId!==sample.scope.objectId||state.revision!==design.digest||sample.scope.revision!==design.digest)throw Error('Card identity differs from its actual owner sample')
  await shot(mode+'-direct-card.png');await closeCard()
  // Rest on the same real route; no card before the declared two-second intent.
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:30,y:30,button:'none',buttons:0});await Bun.sleep(160)
  const again=await pointOnTarget(mode),started=performance.now();await Bun.sleep(900)
  if(await world(`return Boolean(d.querySelector('.layout-inspection'))`))throw Error('Dwell opened before two seconds')
  await until(`return Boolean(d.querySelector('.layout-inspection'))`,'two-second dwell card')
  const elapsed=performance.now()-started,dwell=await readCard();if(elapsed<1500)throw Error('Actual dwell duration was shorter than the declared two-second intent')
  await shot(mode+'-dwell-card.png');await closeCard()
  trials.push({mode,defaultLayer,hover,card,dwell:{elapsedMs:elapsed,card:dwell},again,pose:await world(`return{nativeMvp:q.matrix,planTransform:q.planMatrix,sourceKey:q.sourceKey,preparedKey:q.key,scope:d.querySelector('.explorer-controls .scope')?.textContent,floor:d.querySelector('select[aria-label="Layout level"]')?.value}`)})
 }
 await button('3D');await settled();const childPhase={elementId:'pressurizer',deviceId:'pressurizer.reliefValve'};await world("q.selectTarget('pressurizer')");await focusSubject('pressurizer','Pressurizer');const ownerId=await world('return q.object.id'),ownerHit=await pointOnTarget('3d',ownerId);await click(ownerHit.point);const ownerCard=await readCard('pressurizer');await world(`const child=d.querySelector('.layout-inspection iframe').contentDocument;const button=[...child.querySelectorAll('obc-button,button')].find(button=>button.getAttribute('title')==="PORV's faceplate");if(!button)throw Error('No public exact PORV device action');button.click()`);await until(`const child=d.querySelector('.layout-inspection iframe')?.contentWindow;return child?.document.querySelector('[data-faceplate=\"pressurizer.reliefValve\"]')&&child.__nativeRouteProof.requests.some(request=>request.refs.some(ref=>ref.startsWith('plant:halden-1#pressurizer.reliefValve')))`,'exact child own acquisition');const device=await world(`const frame=d.querySelector('.layout-inspection iframe'),child=frame.contentWindow;return{src:frame.src,text:child.document.body.innerText,faceplate:child.document.querySelector('[data-faceplate]').dataset.faceplate,requests:child.__nativeRouteProof.requests}`);if(/Unknown subject|No current owner sample|cannot be shown/i.test(device.text))throw Error('Child card substituted or failed actual owner readings');await shot('device-own-reading-card.png');await closeCard();trials.push({kind:'owner-and-device',childPhase,ownerHit,ownerCard,device});
 const witnesses=await world('return{registrations:q.registrations,prepared:q.prepared,reportedLogicalCpus:navigator.hardwareConcurrency,userAgent:navigator.userAgent}')
 await call('Page.navigate',{url:'about:blank'});await Bun.sleep(100)
 await writeFile(join(folder,'receipt.json'),JSON.stringify({testedAppCommit:tested,instrumentationSha256:createHash('sha256').update(instrumentation).digest('hex'),expected,startup,trials,witnesses,errors,limits:['Functional actual Host/World pointer and hosted-card proof; not a frame-time or cold-loading benchmark.','Candidates derive from actual prepared route triangles and submitted MVP or actual native Plan ink transform; a real pointer pick must independently accept the exact route.','Default-on is tested before any Utility routes checkbox click. Full graph/model values come only from acquired owner samples.']},null,2))
 if(errors.length)throw Error('Actual browser runtime exceptions were recorded')
 console.log('DONE',folder)
}catch(error){let current:any;try{current=await world('return{body:d.body.innerText.slice(-4000),object:q.object,prepared:q.prepared,points:q.points?.length,plan:q.planMatrix,frames:[...d.querySelectorAll(".layout-inspection iframe")].map(f=>({src:f.src,text:f.contentDocument?.body.innerText}))}')}catch{};await writeFile(join(folder,'failure.json'),JSON.stringify({error:String(error),current,trials,errors},null,2));throw error}
finally{socket?.close();chrome.kill();await chrome.exited;await rm(profile,{recursive:true,force:true})}
