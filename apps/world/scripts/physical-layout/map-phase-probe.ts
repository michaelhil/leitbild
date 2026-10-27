import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'

const root=join(import.meta.dir,'../..'), referenceRoot=process.env.LEITBILD_MAP_PHASE_REFERENCE_ROOT??root,candidateRoot=process.env.LEITBILD_MAP_PHASE_CANDIDATE_ROOT??root
const output=process.env.LEITBILD_MAP_PHASE_DIR??await mkdtemp(join(tmpdir(),'leitbild-map-phase-'))
await mkdir(output,{recursive:true})
const entry=join(root,'tests/browser/physical-scene/map-phase-app.ts'),reference=join(root,'tests/browser/physical-scene/map-phase-reference.ts')
const bundle=await Bun.build({entrypoints:[entry],outdir:join(output,'dist'),target:'browser',format:'esm',naming:'app.js',plugins:[{name:'explicit-map-phase-reference-and-candidate',setup(build){build.onLoad({filter:/map-phase-(app|reference)\.ts$/},async args=>{
  if(args.path===entry)return{contents:(await readFile(entry,'utf8')).replaceAll("'../../../src/",`'${candidateRoot}/src/`),loader:'ts'}
  if(args.path===reference)return{contents:`export {createPhysicalSceneLayer} from ${JSON.stringify(join(referenceRoot,'src/ui/map/physical-scene/layer.ts'))}`,loader:'ts'}
})}}]})
if(!bundle.success)throw new AggregateError(bundle.logs,'Actual Map phase proof failed to build')
const require=createRequire(import.meta.url),maplibre=dirname(require.resolve('maplibre-gl/package.json'))
const glyphUrl=process.env.LEITBILD_MAP_PHASE_GLYPH_URL??'http://127.0.0.1:43148/map/fonts/Noto%20Sans%20Regular/0-255.pbf'
const glyphFile=process.env.LEITBILD_MAP_PHASE_GLYPH_FILE
const glyphResponse=glyphFile?null:await fetch(glyphUrl)
if(glyphResponse&&!glyphResponse.ok)throw Error(`Actual installed Noto glyph request failed: ${glyphResponse.status}`)
const glyphs=glyphFile?new Uint8Array(await readFile(glyphFile)):new Uint8Array(await glyphResponse!.arrayBuffer())
if(!glyphs.length)throw Error('Actual installed Noto glyph artifact is empty')
await writeFile(join(output,'noto-0-255.pbf'),glyphs)
let glyphRequests=0
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){const path=new URL(request.url).pathname
  if(path==='/app.js')return new Response(Bun.file(bundle.outputs[0]!.path))
  if(path==='/worker.mjs')return new Response(Bun.file(join(maplibre,'dist/maplibre-gl-worker.mjs')))
  if(path==='/maplibre.css')return new Response(Bun.file(join(maplibre,'dist/maplibre-gl.css')))
  if(path==='/fonts/Noto%20Sans%20Regular/0-255.pbf'||decodeURIComponent(path)==='/fonts/Noto Sans Regular/0-255.pbf'){glyphRequests++;return new Response(glyphs,{headers:{'content-type':'application/x-protobuf'}})}
  if(path==='/favicon.ico')return new Response(null,{status:204})
  if(path!=='/')return new Response('Not found',{status:404})
  return new Response('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/maplibre.css"><style>html,body{margin:0;width:100%;height:100%}#map{width:640px;height:480px}</style></head><body><div id="map"></div><script type="module" src="/app.js"></script></body></html>',{headers:{'content-type':'text/html'}})
}})
const runs:any[]=[]
const single=process.env.LEITBILD_MAP_PHASE_SINGLE==='1'
try{for(const dpr of (single?[1]:[1,2])){
  const profile=await mkdtemp(join(tmpdir(),'leitbild-phase-chrome-')),chrome=Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=800,700',`--force-device-scale-factor=${dpr}`,'about:blank'],{stdout:'ignore',stderr:Bun.file(join(output,`chrome-${dpr}.log`))})
  let socket:WebSocket|null=null
  try{
    let port=0
    for(let count=0;count<80&&!port;count++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0])}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}if(!port)await Bun.sleep(100)}
    if(!port)throw Error('Isolated phase Chrome did not start')
    const target=await(await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.port}/${single?'?single=1':''}`)}`,{method:'PUT'})).json() as{webSocketDebuggerUrl:string}
    socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{socket!.onopen=()=>resolve();socket!.onerror=reject})
    let id=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:unknown)=>void}>()
    socket.onmessage=event=>{const message=JSON.parse(String(event.data)),task=pending.get(message.id);if(!task)return;pending.delete(message.id);message.error?task.reject(message.error):task.resolve(message.result)}
    const call=(method:string,params:unknown={}):Promise<any>=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});socket!.send(JSON.stringify({id:next,method,params}))})
    const result=await call('Runtime.evaluate',{expression:'new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(window.mapPhaseProbe){clearInterval(timer);window.mapPhaseProbe.then(resolve,reject)}else if(++n>400){clearInterval(timer);reject(Error("Phase fixture failed to mount"))}},25)})',awaitPromise:true,returnByValue:true,timeout:120000})
    if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails))
    const receipt=result.result.value
    if(!receipt)throw Error('Phase fixture produced no receipt')
    for(const item of receipt.summaries){await writeFile(join(output,`${item.which}-${item.mode}-${item.pitch}-${item.bearing}-dpr${dpr}.png`),Buffer.from(item.image.split(',')[1],'base64'));delete item.image}
    receipt.glyphRequests=glyphRequests;receipt.dpr=dpr
    await writeFile(join(output,`receipt-dpr${dpr}.json`),JSON.stringify(receipt,null,2));runs.push(receipt)
  }finally{socket?.close();chrome.kill();await chrome.exited;await rm(profile,{recursive:true,force:true})}
}
const hash=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex'),paths=['layer.ts','renderer.ts','render-pass.ts','backend.ts','architecture-backend.ts']
const provenance=async(base:string)=>({root:base,commit:Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:base}).stdout.toString().trim(),files:Object.fromEntries(await Promise.all(paths.map(async file=>[file,await hash(join(base,'src/ui/map/physical-scene',file))])))})
const expectSplit=process.env.LEITBILD_MAP_PHASE_EXPECT_SPLIT==='1'
const passed=runs.every(run=>!run.errors.length&&run.summaries.every((item:any)=>!item.errors.length&&!item.glError&&item.glCheckpoints.every((point:any)=>point.error===0)&&item.phaseLocal.every((test:any)=>test.passed)&&item.before.geometryUploads===item.after.geometryUploads&&item.before.renderPass?.allocations===item.after.renderPass?.allocations&&item.disposed.liveBuffersAfterDisposal===0&&item.disposed.liveTexturesAfterDisposal===0&&item.disposed.liveProgramsAfterDisposal===0&&item.physicalPixels>100&&item.textPixels>10&&item.iconPixels>10&&item.native.includes('native-circle')&&item.native.includes('native-icon')&&item.native.includes('native-label')&&(item.which==='reference'||item.differentBytes===0&&(!expectSplit||item.latest.some((phase:any)=>phase.name==='prerender')&&item.latest.filter((phase:any)=>phase.name==='render').every((phase:any)=>phase.queries===0&&phase.clears.length===0&&phase.drawTargets.every((target:number|null)=>target===phase.entryTarget))))))
const summary={passed,expectSplit,single,reference:await provenance(referenceRoot),candidate:await provenance(candidateRoot),glyphs:{source:glyphFile??glyphUrl,bytes:glyphs.length,sha256:createHash('sha256').update(glyphs).digest('hex'),requests:glyphRequests},runs,limits:['Functional exact-pixel gate, no timing claim.','Known packed synthetic geometry uses real MapLibre cameras, native circles and installed Noto native glyph text. Real admitted R5 product geometry is separately qualified.','No private MapLibre painter/context access.']}
await writeFile(join(output,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({output,passed,comparisons:runs.flatMap(run=>run.summaries.filter((item:any)=>item.which==='candidate').map((item:any)=>({dpr:run.dpr,mode:item.mode,pitch:item.pitch,bearing:item.bearing,differentBytes:item.differentBytes,latest:item.latest})))},null,2))
if(!passed)process.exitCode=1
}finally{server.stop(true)}
