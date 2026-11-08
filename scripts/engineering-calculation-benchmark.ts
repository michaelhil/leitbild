// Local research measurement only. No provider calls, Run controls or credentials.
import { cpus, platform, arch } from 'node:os'
import { fileURLToPath } from 'node:url'
import { calculateEngineeringMethod } from '../apps/agents/src/core/calculations/engineering-methods.ts'
import { runEngineeringScript } from '../apps/agents/src/core/calculations/script-runner.ts'

const datums=[20,19,17].map((value,index)=>({name:`T${index}`,value,quantity:'temperature',unit:'degC',quality:'good',origin:'assumption',simulationAt:new Date(Date.UTC(2026,10,8,12,0,[0,7,20][index])).toISOString()}))
const source='const a=input.h/input.C, l=1/3600, t=1800; ({temperature:30+150*Math.exp(-a*t)+(0.8/input.C)*(Math.exp(-l*t)-Math.exp(-a*t))/(a-l)})'
const sample=async()=>{
  const methodStart=performance.now()
  calculateEngineeringMethod({method:'sample_changes',samples:['T0','T1','T2']},datums)
  const methodMs=performance.now()-methodStart
  const receipt=await runEngineeringScript({source,input:{C:120,h:0.02}})
  if(receipt.status!=='completed')throw new Error(JSON.stringify(receipt.error))
  return{methodMs,scriptMs:receipt.elapsedMs,peakSampledRssBytes:receipt.peakSampledProcessRssBytes,output:receipt.output,runtimeHash:receipt.runtimeHash,sourceHash:receipt.sourceHash}
}
if(process.argv.includes('--single'))console.log(JSON.stringify(await sample()))
else if(import.meta.main){
  const fresh=[]
  for(let i=0;i<5;i++){
    const processStart=performance.now()
    const child=Bun.spawn([process.execPath,'--no-env-file','--no-macros','--no-install',fileURLToPath(import.meta.url),'--single'],{env:{PATH:'/usr/bin:/bin',LANG:'C',TZ:'UTC'},stdout:'pipe',stderr:'pipe'})
    const [text,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
    if(code!==0)throw new Error(`Fresh supervisor failed: ${error}`)
    fresh.push({...JSON.parse(text),driverMs:performance.now()-processStart})
  }
  const reused=[]
  for(let i=0;i<10;i++)reused.push(await sample())
  const summarize=(rows:Awaited<ReturnType<typeof sample>>[])=>Object.fromEntries(['methodMs','scriptMs','peakSampledRssBytes'].map(key=>{
    const values=rows.map(row=>row[key as 'methodMs'|'scriptMs'|'peakSampledRssBytes']).sort((a,b)=>a-b)
    return[key,{median:(values[Math.floor((values.length-1)/2)]!+values[Math.ceil((values.length-1)/2)]!)/2,max:values.at(-1)}]
  }))
  console.log(JSON.stringify({at:new Date().toISOString(),host:{platform:platform(),architecture:arch(),cpu:cpus()[0]?.model,bun:Bun.version},scope:'Arithmetic and supervised script only; excludes owner binding, persistence, UI and model latency. Every guest process is fresh. Filesystem/OS caches are not flushed; these are fresh versus reused supervisor cohorts, not controlled cold-disk measurements.',freshSupervisor:{count:5,summary:summarize(fresh),samples:fresh},reusedSupervisor:{count:10,summary:summarize(reused),samples:reused}},null,2))
}
