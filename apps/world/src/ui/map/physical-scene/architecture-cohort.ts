import type {PhysicalLayerEntry} from './layer.ts'
import type {PhysicalArchitectureBsp,PhysicalArchitectureBspInput,PhysicalArchitectureBspPreparer,PhysicalArchitectureBspSource} from './architecture-bsp-types.ts'
import {localMercatorMatrix} from './math.ts'
import {physicalPlanDepthDomain,type PhysicalPlanDepthDomain} from './plan-projection.ts'
export interface PhysicalArchitectureBspFrame {readonly matrix:Float64Array;readonly planDepth?:PhysicalPlanDepthDomain}
export interface PhysicalArchitectureCohort extends PhysicalArchitectureBspInput {readonly frame:PhysicalArchitectureBspFrame}

/** Relative placement without subtracting two large inverse-world translations.
 * The cohort basis is the FIRST actual architecture source's scene placement,
 * including bearing, and never that first mesh's separated offset. */
const relativePlacement=(basis:Float64Array,placement:Float64Array,offset:readonly number[]):Float64Array=>{
  const out=new Float64Array(16),scaleSquared=basis[0]!**2+basis[1]!**2
  if(!(scaleSquared>0)||!Number.isFinite(scaleSquared)||!(basis[10]!>0))throw Error('Invalid architecture cohort placement basis')
  for(let column=0;column<3;column++){
    out[column*4]=(basis[0]!*placement[column*4]!+basis[1]!*placement[column*4+1]!)/scaleSquared
    out[column*4+1]=(basis[4]!*placement[column*4]!+basis[5]!*placement[column*4+1]!)/scaleSquared
    out[column*4+2]=placement[column*4+2]!/basis[10]!
  }
  const dx=placement[12]!-basis[12]!,dy=placement[13]!-basis[13]!
  out[12]=(basis[0]!*dx+basis[1]!*dy)/scaleSquared
  out[13]=(basis[4]!*dx+basis[5]!*dy)/scaleSquared
  out[14]=(placement[14]!-basis[14]!)/basis[10]!
  for(let row=0;row<3;row++)for(let axis=0;axis<3;axis++)out[12+row]!+=out[axis*4+row]!*offset[axis]!
  out[15]=1
  if(!out.every(Number.isFinite))throw Error('Architecture cohort placement is not finite')
  return out
}

/** Actual prepared geometry/placements define ordering. Camera and opacity do
 * not. Camera-facing full/cut and conditional owner alternatives stay present;
 * traversal later admits only the exact currently displayed owner ordinals. */
export const physicalArchitectureCohort=(entries:ReadonlyArray<PhysicalLayerEntry>):PhysicalArchitectureCohort|null=>{
  const solid=entries.filter(entry=>entry.asset&&!(entry.view.mode==='2d'&&entry.scene.planDrawing?.views.some(view=>view.levelId===entry.view.levelId)))
  const plan=solid.length>0&&solid.every(entry=>entry.view.mode==='2d'),depth=plan?physicalPlanDepthDomain(solid):null
  const selected=solid.flatMap(entry=>entry.meshes.filter(mesh=>mesh.object.kind==='wall'||mesh.object.kind==='slab').map(mesh=>({entry,mesh})))
  if(!selected.length)return null
  const first=selected[0]!.entry.scene,basis=localMercatorMatrix(first.anchor,first.bearing),identities:unknown[]=[],sources:PhysicalArchitectureBspSource[]=[]
  for(const{entry,mesh}of selected){
    const asset=entry.asset!,meshIndex=mesh.assetIndex??asset.meshes.indexOf(mesh)
    if(!Number.isInteger(meshIndex)||meshIndex<0||meshIndex>=asset.meshes.length)throw Error('Architecture source has no exact prepared mesh ordinal')
    const id=JSON.stringify([entry.scene.id,asset.key,meshIndex])
    const original=asset.meshes[meshIndex]!,preparedOwnershipCohort=JSON.stringify([entry.scene.id,asset.key,entry.scene.anchor,entry.scene.bearing,original.planPriority??'physical',original.offset])
    const offset=plan?[mesh.offset[0],mesh.offset[1],mesh.offset[2]+2*(mesh.planPriority??0)*depth!.span]:mesh.offset
    identities.push([id,entry.view.mode,entry.scene.anchor,entry.scene.bearing,entry.view.levelId==='all'?entry.view.separation:0,offset])
    const matrix=relativePlacement(basis,localMercatorMatrix(entry.scene.anchor,entry.scene.bearing),offset)
    if(plan){matrix[2]=0;matrix[6]=0;matrix[10]=1;matrix[14]=offset[2]!}
    let last=Math.max((mesh.materials?.length??0)-1,(mesh.object.materials?.length??0)-1,0)
    for(let at=6;at<mesh.vertices.length;at+=7)last=Math.max(last,mesh.vertices[at]!)
    const materials=Array.from({length:last+1},(_,index)=>mesh.materials?.[index]??mesh.object.materials?.[index]??mesh.object.material??mesh.object.kind)
    sources.push({id,sceneId:entry.scene.id,assetKey:asset.key,meshIndex,occurrenceId:mesh.object.id,preparedOwnershipCohort,matrix,vertices:mesh.vertices,lines:mesh.lines,materials,...(mesh.lineMaterials?{lineMaterials:mesh.lineMaterials}:{}),...(mesh.lineStyles?{lineStyles:mesh.lineStyles}:{})})
  }
  return{key:`architecture-bsp/${JSON.stringify([depth,identities])}`,sources,frame:{matrix:basis,...(depth?{planDepth:depth}:{})}}
}

export interface PhysicalArchitectureOrderingState {readonly key:string|null;readonly status:'idle'|'loading'|'ready'|'unavailable';readonly reason?:string}
/** One current ordering demand and its last accepted result. This is a resource
 * lifetime, not an all-visited cache. The worker copies owned input storage;
 * active prepared geometry is never transferred or detached. */
export const createPhysicalArchitectureOrdering=(prepare:PhysicalArchitectureBspPreparer,changed:()=>void)=>{
  let state:PhysicalArchitectureOrderingState={key:null,status:'idle'},ready:PhysicalArchitectureBsp|null=null,request:AbortController|null=null,generation=0,destroyed=false
  const cancel=():void=>{generation++;request?.abort();request=null}
  return{
    state:()=>state,
    asset:(key:string):PhysicalArchitectureBsp|null=>ready?.key===key?ready:null,
    request(input:PhysicalArchitectureBspInput|null,retry=false):void{
      if(destroyed)throw Error('Architecture ordering has been disposed')
      if(!input){if(state.key===null&&ready===null)return;cancel();ready=null;state={key:null,status:'idle'};changed();return}
      if(ready?.key===input.key){if(state.key===input.key&&state.status==='ready')return;cancel();state={key:input.key,status:'ready'};changed();return}
      if(state.key===input.key&&(state.status==='loading'||state.status==='unavailable'&&!retry))return
      cancel();const signal=new AbortController(),expected=generation;request=signal;state={key:input.key,status:'loading'};changed()
      void(async()=>{try{
        const result=await prepare(input,signal.signal)
        if(destroyed||signal.signal.aborted||generation!==expected)return
        if(result.key!==input.key)throw Error('Architecture worker answered a different cohort')
        ready=result;request=null;state={key:input.key,status:'ready'};changed()
      }catch(error){if(destroyed||signal.signal.aborted||generation!==expected)return;request=null;state={key:input.key,status:'unavailable',reason:error instanceof Error?error.message:String(error)};changed()}})()
    },
    suspend():void{if(!request)return;cancel();state=ready?{key:ready.key,status:'ready'}:{key:null,status:'idle'};changed()},
    destroy():void{if(destroyed)return;destroyed=true;cancel();ready=null;state={key:null,status:'idle'};prepare.destroy()},
  }
}
