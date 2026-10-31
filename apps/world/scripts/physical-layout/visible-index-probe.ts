import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const root=resolve(import.meta.dir,'../..'),candidate=process.env.LEITBILD_VISIBLE_INDEX_RENDERER_ROOT??root,reference=process.env.LEITBILD_VISIBLE_INDEX_REFERENCE_ROOT??root
const output=process.env.LEITBILD_VISIBLE_INDEX_PROBE_DIR??await mkdtemp(join(tmpdir(),'leitbild-visible-index-')),baseline='2a2755715162fc2335cf958fc08c14eebb0322f3'
const expectIndices=process.env.LEITBILD_VISIBLE_INDEX_EXPECT_INDICES==='1'
const canonical=Bun.spawnSync(['git','diff',baseline,'--','src'],{cwd:reference})
if(canonical.exitCode!==0||canonical.stdout.toString().length)throw Error('The visible-index reference must retain the exact frozen2a production tree')
await mkdir(join(output,'dist'),{recursive:true})
const entry=join(root,'tests/browser/physical-scene/visible-index-probe.ts'),referenceModule=join(root,'tests/browser/physical-scene/visible-index-reference.ts'),referenceBackend=join(reference,'src/ui/map/physical-scene/backend.ts')
const build=await Bun.build({entrypoints:[entry],outdir:join(output,'dist'),target:'browser',format:'esm',naming:'app.js',plugins:[{name:'independent-frozen-native-backend',setup(build){
  build.onLoad({filter:/visible-index-probe\.ts$/},async args=>args.path===entry?{contents:(await readFile(entry,'utf8')).replaceAll("'../../../src/",`'${candidate}/src/`),loader:'ts'}:undefined)
  build.onLoad({filter:/visible-index-reference\.ts$/},async args=>args.path===referenceModule?{contents:(await readFile(referenceBackend,'utf8')).replace(/from '([^']+)'/g,(statement,specifier:string)=>specifier.startsWith('.')?`from ${JSON.stringify(resolve(dirname(referenceBackend),specifier))}`:statement),loader:'ts',resolveDir:dirname(referenceBackend)}:undefined)
}}]})
if(!build.success)throw new AggregateError(build.logs,'Visible-index differential fixture did not build')
const html=`<!doctype html><canvas></canvas><script>window.visibleIndexConfig={expectIndices:${expectIndices}};window.addEventListener("error",event=>{window.visibleIndexProof??={passed:false,error:event.message}})</script><script type="module" src="/app.js"></script>`
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>new URL(request.url).pathname==='/app.js'?new Response(Bun.file(build.outputs[0]!.path)):new Response(html,{headers:{'content-type':'text/html'}})})
const runs:any[]=[]
try{
  for(const dpr of [1,2]){
    const profile=await mkdtemp(join(tmpdir(),'leitbild-visible-index-chrome-')),chrome=Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--force-device-scale-factor=${dpr}`,'about:blank'],{stdout:'ignore',stderr:Bun.file(join(output,`chrome-${dpr}.log`))})
    let socket:WebSocket|null=null
    try{
      let port=0;const started=performance.now()
      while(!port&&performance.now()-started<15000){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0])}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}if(!port)await Bun.sleep(50)}
      if(!port)throw Error('The differential browser did not start')
      const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json() as {webSocketDebuggerUrl:string}
      socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{socket!.onopen=()=>resolve();socket!.onerror=reject})
      let id=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:unknown)=>void}>()
      socket.onmessage=event=>{const value=JSON.parse(String(event.data)),task=pending.get(value.id);if(task){pending.delete(value.id);value.error?task.reject(value.error):task.resolve(value.result)}}
      const call=(method:string,params:unknown={}):Promise<any>=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});socket!.send(JSON.stringify({id:next,method,params}))})
      await call('Page.enable');await call('Runtime.enable');await call('Page.navigate',{url:`http://127.0.0.1:${server.port}/`})
      const evaluation=await call('Runtime.evaluate',{expression:'new Promise((resolve,reject)=>{const started=performance.now();const poll=()=>{if(window.visibleIndexProof){resolve(window.visibleIndexProof);return}if(performance.now()-started>30000){reject(Error("Visible-index proof did not finish"));return}requestAnimationFrame(poll)};poll()})',awaitPromise:true,returnByValue:true,timeout:35000})
      const result=evaluation.result?.value??{passed:false,evaluation};runs.push(result)
      await writeFile(join(output,`receipt-dpr${dpr}.json`),JSON.stringify(result,null,2))
      const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,`dpr${dpr}.png`),Buffer.from(shot.data,'base64'))
    }finally{socket?.close();chrome.kill();await chrome.exited;await rm(profile,{recursive:true,force:true})}
  }
  const hash=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex')
  const production=async(base:string)=>{const files:Record<string,string>={};for await(const path of new Bun.Glob('src/ui/map/physical-scene/**/*.ts').scan({cwd:base}))files[path]=await hash(join(base,path));return files}
  const receipt={passed:runs.every(run=>run.passed),runs,provenance:{baseline,reference,candidate,expectIndices,candidateCommit:Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:candidate}).stdout.toString().trim(),referenceFiles:await production(reference),candidateFiles:await production(candidate),fixtureSha256:await hash(entry),runnerSha256:await hash(import.meta.path),executedBundleSha256:await hash(build.outputs[0]!.path)},limits:['Exact same-target GPU comparison against the frozen2a native backend, including original GL_LINES; no expanded-stroke reference or pixel tolerance.','Synthetic authored three-mesh topology exhaustively tests all visibility subsets; not a whole-plant performance claim.','Both backends consume identical prepared buffers and owner metadata. Sources, graph identities and geometric quality are not reduced.']}
  await writeFile(join(output,'summary.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({output,passed:receipt.passed,runs:runs.map(run=>({dpr:run.dpr,samples:run.samples,cases:run.results?.length,failed:run.results?.filter((value:any)=>!value.passed),error:run.error,hostState:run.hostState}))},null,2))
  if(!receipt.passed)process.exitCode=1
}finally{server.stop(true)}
