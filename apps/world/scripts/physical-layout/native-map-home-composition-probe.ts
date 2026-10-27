import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {nativeMapStartup} from '../../tests/browser/physical-scene/native-map-startup.ts'
// Functional-only: capture the actual built pure fit function through CDP.
// No production hooks, private map mutation, playback commands or timing claim.
const url=process.argv[2],out=resolve(process.argv[3]??'')
const width=Number(process.env.LEITBILD_HOME_VIEWPORT_WIDTH??1280),height=Number(process.env.LEITBILD_HOME_VIEWPORT_HEIGHT??720),railWidth=Number(process.env.LEITBILD_HOME_RAIL_WIDTH??280)
if(![width,height,railWidth].every(value=>Number.isFinite(value)&&value>0))throw Error('Positive finite test viewport/rail dimensions required')
const testedRef=process.env.LEITBILD_LOADING_TESTED_COMMIT
if(!testedRef)throw Error('Set LEITBILD_LOADING_TESTED_COMMIT to the separately built app commit')
const testedAppCommit=Bun.spawnSync(['git','rev-parse',testedRef],{cwd:resolve(import.meta.dir,'../../../..')}).stdout.toString().trim()
if(!/^[0-9a-f]{40}$/.test(testedAppCommit))throw Error('The tested app commit must resolve locally')
if(!url||!process.argv[3]||!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('Own paused loopback Run URL and output required')
await mkdir(out,{recursive:true});const profile=await mkdtemp(join(tmpdir(),'layout-home-capture-'))
const chrome=Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--force-device-scale-factor=1','about:blank'],{stdout:'ignore',stderr:Bun.file(join(out,'chrome.log'))})
let ws:WebSocket|null=null,n=0;const pending=new Map<number,{resolve:(v:any)=>void,reject:(v:unknown)=>void}>(),scripts=new Map<string,{url:string}>(),fits:any[]=[],errors:any[]=[]
const call=(method:string,params:any={}):Promise<any>=>new Promise((resolve,reject)=>{const id=++n;pending.set(id,{resolve,reject});ws!.send(JSON.stringify({id,method,params}))})
const E=async(expression:string)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,timeout:90000});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value}
const W=(body:string)=>E(`(()=>{const f=document.querySelector('iframe[src*="/world/runs/"]'),w=f.contentWindow,d=w.document;${body}})()`)
const until=async(body:string,label:string)=>{const start=performance.now();for(;;){if(await W(body))return;if(performance.now()-start>60000)throw Error('Missing '+label);await Bun.sleep(50)}}
let variables:{input:string;distance:string;target:string;eye:string;focus:string}|null=null,phase='setup'
try{
 let port=0;const started=performance.now();for(;;){if(performance.now()-started>45000)throw Error('Chrome did not expose CDP before test startup deadline');try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0])}catch{}if(port)break;if(chrome.exitCode!==null)throw Error('Chrome exited');await Bun.sleep(50)}
 const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((r,j)=>{ws!.onopen=()=>r();ws!.onerror=j})
 ws.onmessage=event=>{const m=JSON.parse(String(event.data)),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);return}
  if(m.method==='Debugger.scriptParsed')scripts.set(m.params.scriptId,{url:m.params.url})
  if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)
  if(m.method==='Debugger.paused')void(async()=>{try{if(variables){const v=variables,r=await call('Debugger.evaluateOnCallFrame',{callFrameId:m.params.callFrames[0].callFrameId,expression:`({input:${v.input},distance:${v.distance},target:${v.target},eye:${v.eye},focus:${v.focus}})`,returnByValue:true});fits.push({phase,location:m.params.callFrames[0].location,functionName:m.params.callFrames[0].functionName,...r.result?.value})}}catch(error){errors.push(String(error))}finally{await call('Debugger.resume')}})()
 }
 await call('Runtime.enable');await call('Page.enable');await call('Debugger.enable');await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await call('Page.navigate',{url});await E(`(${nativeMapStartup.toString()})(true)`)
 const rail=await E(`(()=>{const f=document.querySelector('iframe[src*="/world/runs/"]'),r=f.getBoundingClientRect(),h=f.contentDocument.querySelector('.rail-resize-handle')?.getBoundingClientRect();return h?{x:r.x+h.x+h.width/2,y:r.y+h.y+Math.min(300,h.height/2),visible:h.width>0&&h.height>0,end:r.x+${railWidth}}:{visible:false}})()`)
 if(rail.visible){await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:rail.x,y:rail.y});await call('Input.dispatchMouseEvent',{type:'mousePressed',x:rail.x,y:rail.y,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:rail.end,y:rail.y,button:'left',buttons:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:rail.end,y:rail.y,button:'left',clickCount:1})
 await until(`return Math.abs(d.querySelector('.maplibregl-canvas').getBoundingClientRect().x-${railWidth})<1`,'public rail resize')}else await W(`d.querySelector('[aria-label="Close objects drawer"]')?.click()`)

 await W(`d.querySelector('.scope').click()`);await until(`return !!d.querySelector('.scopes input')`,'scope search');await W(`const i=d.querySelector('.scopes input');i.value='Turbine hall';i.dispatchEvent(new w.Event('input',{bubbles:true}))`)
 await until(`return [...d.querySelectorAll('.choose-area')].some(b=>b.title==='Halden Unit 1 full plant / PWR unit / Turbine hall and feedwater pump annex')`,'authored area');await W(`[...d.querySelectorAll('.choose-area')].find(b=>b.title==='Halden Unit 1 full plant / PWR unit / Turbine hall and feedwater pump annex').click()`)
 await until(`return d.querySelector('select[aria-label="Layout level"]')&&!/Loading this/.test(d.querySelector('.evidence')?.textContent??'')`,'area');await W(`const s=d.querySelector('select[aria-label="Layout level"]');s.value='operating';s.dispatchEvent(new w.Event('change',{bubbles:true}))`)
 await until(`return /Paused · fresh/.test(d.querySelector('.evidence')?.textContent??'')`,'operating');await W(`[...d.querySelectorAll('.modes button')].find(b=>b.textContent==='3D').click()`)
 await until(`return /Paused · fresh/.test(d.querySelector('.evidence')?.textContent??'')`,'3D');await W(`const s=d.querySelector('select[aria-label="Layout level"]');s.value='all';s.dispatchEvent(new w.Event('change',{bubbles:true}))`)
 await until(`return /Paused · fresh/.test(d.querySelector('.evidence')?.textContent??'')`,'Stack')
 let scriptId='',source='';for(const [id,item]of scripts)if(/PhysicalExplorer[^/]*\.js/.test(item.url)){const text=await call('Debugger.getScriptSource',{scriptId:id});if(text.scriptSource.includes('An authored physical focus must yield')){scriptId=id;source=text.scriptSource;break}}
 if(!scriptId)throw Error('Actual fit function was not found in loaded public module')
 const marker=source.indexOf('An authored physical focus must yield'),prefix=source.slice(0,marker),matches=[...prefix.matchAll(/([\w$]+)=([\w$]+)=>\{let\{width:/g)],param=matches.at(-1)?.[2],returnAt=source.indexOf('return{distance:',marker),returns=source.slice(returnAt,returnAt+150).match(/^return\{distance:([\w$]+),target:([\w$]+),eye:([\w$]+),focus:([\w$]+)\}/)
 if(!param||!returns)throw Error('Cannot identify exact public module fit inputs without changing code')
 variables={input:param,distance:returns[1]!,target:returns[2]!,eye:returns[3]!,focus:returns[4]!}
 const location={scriptId,lineNumber:source.slice(0,returnAt).split('\n').length-1,columnNumber:returnAt-(source.lastIndexOf('\n',returnAt)+1)}
 await call('Debugger.setBreakpoint',{location})
 phase='pending-home';await W(`const b=[...d.querySelectorAll('.action-row button')].find(b=>b.textContent==='View');b.click()`);await until(`return !!d.querySelector('.settings')`,'settings')
 await W(`const label=[...d.querySelectorAll('.settings label')].find(e=>e.textContent.trim()==='Utility routes');if(!label)throw Error('No declared utility route layer');const i=label.querySelector('input');if(!i.checked)i.click();d.querySelector('.settings [aria-label="Close view settings"]').click()`)
 const before=await W(`return {status:d.querySelector('.evidence')?.textContent,layerPending:/Preparing additional/.test(d.querySelector('.evidence')?.textContent??'')}`)
 await W(`[...d.querySelectorAll('.camera-primary button')].find(b=>b.textContent==='Home').click()`)
 await until(`return /Paused · fresh/.test(d.querySelector('.evidence')?.textContent??'')&&!/Preparing additional/.test(d.querySelector('.evidence')?.textContent??'')`,'utility coverage')
 await W(`return new Promise(resolve=>w.requestAnimationFrame(()=>w.requestAnimationFrame(resolve)))`)
 const dom=await W(`const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return{map:rect(d.querySelector('.maplibregl-canvas')),tools:rect(d.querySelector('.layout-tools')),camera:rect(d.querySelector('.camera-controls')),cameraButtons:[...d.querySelectorAll('.camera-primary button')].map(e=>({label:e.getAttribute('aria-label')??e.textContent,...rect(e)})),native:[...d.querySelectorAll('.maplibregl-ctrl')].map(rect),status:d.querySelector('.evidence')?.textContent}`)
 const screenshot=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(out,'home-before.png'),Buffer.from(screenshot.data,'base64'))
 phase='ready-home';await W(`[...d.querySelectorAll('.camera-primary button')].find(b=>b.textContent==='Home').click()`);await W(`return new Promise(resolve=>w.requestAnimationFrame(()=>w.requestAnimationFrame(resolve)))`)
 const hidden=await W(`d.querySelector('[aria-label="Close layout controls"]').click();return new Promise(resolve=>w.requestAnimationFrame(()=>resolve({hidden:!d.querySelector('.layout-tools,.camera-controls'),mapPresent:!!d.querySelector('.maplibregl-canvas')})))`)
 const hiddenShot=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(out,'controls-hidden.png'),Buffer.from(hiddenShot.data,'base64'))
 await E(`(${nativeMapStartup.toString()})(true)`)
 const restored=await W(`return{tools:!!d.querySelector('.layout-tools'),camera:!!d.querySelector('.camera-controls'),overflow:d.documentElement.scrollWidth>d.documentElement.clientWidth}`)
 phase='plan';await W(`[...d.querySelectorAll('.modes button')].find(b=>b.textContent==='Plan').click()`)
 await until(`return /Paused · fresh/.test(d.querySelector('.evidence')?.textContent??'')`,'restored Plan');await W(`const s=d.querySelector('select[aria-label="Layout level"]');if(s.value!=='operating'){s.value='operating';s.dispatchEvent(new w.Event('change',{bubbles:true}))}`)
 await until(`return /Paused · fresh/.test(d.querySelector('.evidence')?.textContent??'')`,'operating Plan');await W(`[...d.querySelectorAll('.action-row button')].find(b=>b.textContent==='Fit').click()`);await W(`return new Promise(resolve=>w.requestAnimationFrame(()=>w.requestAnimationFrame(resolve)))`)
 const plan=await W(`const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return{levelId:d.querySelector('select[aria-label="Layout level"]').value,map:rect(d.querySelector('.maplibregl-canvas')),tools:rect(d.querySelector('.layout-tools')),cameraPresent:!!d.querySelector('.camera-controls')}`)
 const planShot=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(out,'plan.png'),Buffer.from(planShot.data,'base64'))
 const buttonContained=dom.cameraButtons.every((button:any)=>button.x>=dom.camera.x&&button.y>=dom.camera.y&&button.x+button.width<=dom.camera.x+dom.camera.width&&button.y+button.height<=dom.camera.y+dom.camera.height&&button.width>=44&&button.height>=44)
 if(!hidden.hidden||!hidden.mapPresent||!restored.tools||!restored.camera||restored.overflow||!buttonContained)throw Error('The shelf failed public close/View restore, overflow or contained touch-target check')
 await writeFile(join(out,'receipt.json'),JSON.stringify({url,testedAppCommit,viewport:{width,height},railWidth,before,dom,hidden,restored,plan,fits,module:{url:scripts.get(scriptId)!.url,sha256:createHash('sha256').update(source).digest('hex'),location,variables},errors,limits:['Read-only own paused local Run; no playback/source/operational mutation.','Debugger snapshots actual pure fit inputs/results; timings are deliberately unqualified.']},null,2));console.log(JSON.stringify({out,before,dom,fitCalls:fits.length,phaseCounts:{pending:fits.filter(x=>x.phase==='pending-home').length,ready:fits.filter(x=>x.phase==='ready-home').length},errors}))
}catch(error){
 try{const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(out,'failure.png'),Buffer.from(shot.data,'base64'));const dom=await E(`(()=>{const f=document.querySelector('iframe[src*="/world/runs/"]');return{host:document.body.innerText,world:f?.contentDocument?.body.innerText}})()`);await writeFile(join(out,'failure.json'),JSON.stringify({testedAppCommit,error:String(error),phase,dom,errors},null,2))}catch{}
 throw error
}finally{ws?.close();chrome.kill();await chrome.exited;await rm(profile,{recursive:true,force:true})}
