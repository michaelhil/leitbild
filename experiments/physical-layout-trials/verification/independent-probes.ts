/** Independent, read-only-to-contenders probes. Mutated IFC/JSON exists only in memory. */
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'

const ifcRoot=resolve(Bun.argv[2]??'../ifc')
const nativeRoot=resolve(Bun.argv[3]??'../native')
const destination=Bun.argv[4]
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex')
const load=(root:string,file:string)=>import(pathToFileURL(resolve(root,file)).href)
const revision=(root:string)=>new TextDecoder().decode(Bun.spawnSync(['git','-C',root,'rev-parse','HEAD']).stdout).trim()
const fileHashes=async(root:string,names:string[])=>Object.fromEntries(await Promise.all(names.map(async n=>[n,sha(await Bun.file(resolve(root,n)).bytes())])))
const ifc=await load(ifcRoot,'ifc.ts'),ifcEdit=await load(ifcRoot,'edit.ts'),ifcModel=await load(ifcRoot,'model.ts')
const W=createRequire(resolve(ifcRoot,'package.json'))('web-ifc')
const bytes=await Bun.file(resolve(ifcRoot,'output/source.ifc')).bytes()
const original=await ifc.read(bytes),pump=original.model.elements.find((e:any)=>e.id==='mfw-a')
const accepted=await ifcEdit.admit(bytes,ifcModel.hash(bytes),{kind:'move-pump',east:2},{tamper:(m:any)=>{m.elements.find((e:any)=>e.id==='mfw-a').position[0]+=100}})
const moved=(await ifc.read(accepted.bytes)).model.elements.find((e:any)=>e.id==='mfw-a')
const sameTarget={requestedEast:2,acceptedEast:moved.position[0]-pump.position[0],before:pump.position,after:moved.position,intendedIds:accepted.receipt.intended,actualIds:accepted.receipt.actual,findingReproduced:moved.position[0]-pump.position[0]!==2}

const a=await ifc.api(),id=a.OpenModel(bytes)
const first=(type:number)=>a.GetLine(id,a.GetLineIDsWithType(id,type).get(0),false)
const representation=(e:any)=>a.GetLine(id,a.GetLine(id,e.Representation.value,false).Representations[0].value,false)
const p=representation(first(W.IFCPUMP)),wall=representation(first(W.IFCWALL))
p.Items.push(wall.Items[0]);a.WriteLine(id,p)
const augmented=a.SaveModel(id);a.CloseModel(id)
let extraItem:any
try{
  const parsed=await ifc.read(augmented)
  extraItem={accepted:true,baselineNativeTriangles:original.nativeTessellation.triangles,augmentedNativeTriangles:parsed.nativeTessellation.triangles,parsedModelUnchanged:sha(JSON.stringify(parsed.model))===sha(JSON.stringify(original.model)),parsedPumpBodyUnchanged:sha(JSON.stringify(parsed.nativeBodies.get('mfw-a')))===sha(JSON.stringify(original.nativeBodies.get('mfw-a')))}
  extraItem.findingReproduced=extraItem.accepted&&extraItem.augmentedNativeTriangles!==extraItem.baselineNativeTriangles&&extraItem.parsedModelUnchanged&&extraItem.parsedPumpBodyUnchanged
}catch(error){extraItem={accepted:false,refusal:String(error),findingReproduced:false}}

const n=await load(nativeRoot,'model.ts'),ne=await load(nativeRoot,'edit.ts')
const base=n.readSource(await Bun.file(resolve(nativeRoot,'output/base/source.json')).text())
const command={kind:'move',elementId:'mfw-a',east:2},valid=ne.edit(base,command).candidate
const mutations:[string,(s:any)=>void][]=[
  ['same-target-extra100m',s=>{s.elements.find((e:any)=>e.id==='mfw-a').pose.position[0]+=100}],
  ['weaken-independent-requirement',s=>{s.requirements[0].max=20}],
  ['change-process-model',s=>{s.modelRequirement.digest='f'.repeat(64)}],
  ['keep-study-current',s=>{s.studies[0].applicability='current'}],
]
const native=[]
for(const [name,mutate] of mutations){
  const candidate=n.clone(valid);mutate(candidate)
  let refusal=''
  try{ne.admit(base,candidate,n.hash(n.sourceText(base)),command)}catch(error){refusal=String(error)}
  native.push({name,rejected:!!refusal,refusal})
}
const result={observedAt:new Date().toISOString(),scope:'Independent in-memory source/admission counterchecks; no contender source or output modified',ifc:{commit:revision(ifcRoot),files:await fileHashes(ifcRoot,['ifc.ts','edit.ts','model.ts']),sourceSha256:sha(bytes),sameTarget,extraRepresentationItem:extraItem},native:{commit:revision(nativeRoot),files:await fileHashes(nativeRoot,['model.ts','edit.ts','compile.ts']),sourceSha256:sha(await Bun.file(resolve(nativeRoot,'output/base/source.json')).bytes()),mutations:native},limits:['These probes are not a complete hostile-import audit or production qualification','IFC failures concern this contender, not intrinsic IFC capability','Native counterexamples being refused does not establish full schema or security coverage']}
const output=JSON.stringify(result,null,2)+'\n'
if(destination)await Bun.write(destination,output)
console.log(output)
