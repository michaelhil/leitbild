/** Offline native history cost witness. Actual coefficients and material count;
 * prescribed finite prehistory/trial feeds, not a coupled neutron simulation. */
import {createHash} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {advanceDecayHistory,compileDecayHistory,parseDecayHistory} from './reference-design-decay-history'
const sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex')
if(import.meta.main){
 const [wikiArg,materialArg,binaryArg,output]=Bun.argv.slice(2)
 if(!wikiArg||!materialArg||!binaryArg||!output)throw Error('Usage: <LD-01 wiki> <current material receipt> <native heat-history binary> <NEW receipt.json>')
 const wiki=resolve(wikiArg),materialText=await Bun.file(materialArg).text(),material=JSON.parse(materialText)
 if(!Array.isArray(material.consumed)||!Array.isArray(material.result?.segments))throw Error('Missing material ownership receipt')
 for(const owner of material.consumed){
  if(typeof owner.name!=='string'||owner.name.includes('..')||owner.name.startsWith('/'))throw Error('Invalid material owner')
  if(sha(await Bun.file(join(wiki,owner.name)).text())!==owner.sha256)throw Error('Stale material owner: '+owner.name)
 }
 const ids=material.result.segments.map((s:{id:string})=>s.id)
 if(ids.length===0||ids.some((id:unknown)=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length
  ||ids.length!==material.result.totals.historySegments)throw Error('Invalid material segments')
 const name='systems/reactor/heat-and-history.md',document=await Bun.file(join(wiki,name)).text(),
  record=parseDecayHistory(document),kernel=compileDecayHistory(record),
  // Explicit conditional prescribed preparation, not an attained reactor state.
  Fpre=3e9/(record.referenceFissionEnergy_MeV*1.602176634e-13)/ids.length,
  prepared=advanceDecayHistory(kernel,kernel.groups.map(()=>0),
   {fission_s_inv:Fpre,fertileCapture_s_inv:record.referenceCaptureRatio*Fpre},600*86400),
  history=ids.flatMap(()=>prepared.stores_J.map(E=>10*E)),
  payload=[ids.length,kernel.groups.length,kernel.fissionEnergy_J,
   ...kernel.groups.flatMap(g=>[g.feed==='fission'?0:1,g.energy_J_per_event,g.lambda_s_inv]),...history].join(' ')+'\n',
  binary=resolve(binaryArg),binaryBefore=sha(new Uint8Array(await Bun.file(binary).arrayBuffer())),
  process=Bun.spawn([binary],{stdin:new Blob([payload]),stdout:'pipe',stderr:'pipe'}),
  [stdout,stderr,code]=await Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited])
 if(code!==0)throw Error('Native history witness failed: '+stderr)
 const result=JSON.parse(stdout)
 if(result.physicalStores!==ids.length*kernel.groups.length||!(result.secondsPerMaterialBankStageAndRhs>0)
  ||sha(new Uint8Array(await Bun.file(binary).arrayBuffer()))!==binaryBefore)throw Error('Invalid/changed native history witness')
 if(await Bun.file(join(wiki,name)).text()!==document)throw Error('History owner changed during witness')
 await writeFile(output,JSON.stringify({scope:'History block cost only, not whole-source or unit capacity',
  materialReceiptSHA256:sha(materialText),historyOwner:{name,sha256:sha(document)},
  sourceSHA256:sha(await Bun.file(import.meta.path).text()),binarySHA256:binaryBefore,inputSHA256:sha(payload),
  preparation:'Prescribed 600-day constant independent feeds; stage history/feeds are synthetic cost trials',
  materialSegments:ids.length,groupCount:kernel.groups.length,result},null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify({receipt:output,...result}))
}
