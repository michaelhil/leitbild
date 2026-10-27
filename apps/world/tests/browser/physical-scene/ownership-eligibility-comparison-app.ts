import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor } from '../../../src/core/packs/scene.ts'
import { createPhysicalSceneController } from '../../../src/ui/map/physical-scene/controller.ts'
import { createPhysicalSceneRenderer } from '../../../src/ui/map/physical-scene/renderer.ts'
import { preparePhysicalGeometry } from '../../../src/ui/map/physical-scene/preparation.ts'
import { preparePhysicalGeometry as legacyPrepare } from './legacy-preparation-reference.ts'
import { admitPhysicalPickAcceleration, derivePhysicalPickAcceleration } from '../../../src/ui/map/physical-scene/picking.ts'
import { physicalScopeMembers } from '../../../src/ui/map/physical-scene/scopes.ts'
import { visiblePhysicalInspectionBoundaries } from '../../../src/ui/map/physical-scene/inspection-cutaway.ts'
import { visiblePhysicalSurfaceOwners } from '../../../src/ui/map/physical-scene/surface-ownership.ts'
import { localMercatorMatrix, multiply } from '../../../src/ui/map/physical-scene/math.ts'
import { physicalLayoutPalette } from '../../../src/ui/physical-layout/palette.ts'
import { defaultPhysicalSceneView } from '../../../src/ui/map/physical-scene/types.ts'
import type { PhysicalLayerEntry } from '../../../src/ui/map/physical-scene/layer.ts'
setWorkerUrl('/worker.mjs')
const {scene,descriptor}=await(await fetch('/fixtures.json')).json() as {scene:PackPhysicalScene;descriptor:PackPhysicalSceneDescriptor}
const element=document.querySelector<HTMLElement>('#map')!,canvas=document.querySelector<HTMLCanvasElement>('#legacy')!,errors:string[]=[]
const map=new MapLibreMap({container:element,style:{version:8,sources:{},layers:[{id:'ground',type:'background',paint:{'background-color':'#ecefe7'}}]},center:descriptor.anchor,zoom:16,attributionControl:false,fadeDuration:0,canvasContextAttributes:{antialias:true,preserveDrawingBuffer:true}})
const loaded=new Promise<void>(resolve=>map.once('load',()=>resolve())),frames=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))
let previousLegacy:{key:string;asset:ReturnType<typeof legacyPrepare>}|undefined
let matrix:Float64Array|undefined,ready=false,currentAsset:ReturnType<typeof preparePhysicalGeometry>|undefined,legacyEntry:PhysicalLayerEntry|undefined
await loaded
map.addLayer({id:'qualification-matrix',type:'custom',renderingMode:'3d',render(_gl,args){matrix=Float64Array.from(args.defaultProjectionData.mainMatrix)}})
canvas.width=map.getCanvas().width;canvas.height=map.getCanvas().height
const gl=canvas.getContext('webgl2',{antialias:true,preserveDrawingBuffer:true})!,size=()=>({width:element.clientWidth,height:element.clientHeight}),palette=physicalLayoutPalette(element)
const legacyRenderer=createPhysicalSceneRenderer(gl,()=>legacyEntry?[legacyEntry]:[],palette,size,error=>errors.push(error.message))
const controller=createPhysicalSceneController({map,palette,beforeId:()=>undefined,onChange:rows=>{ready=rows[0]?.status==='ready'},reportError:error=>errors.push(error.message),prepare:async(s,v,key,identity)=>{currentAsset=preparePhysicalGeometry(s,v,key,identity);return currentAsset}})
controller.setSources([{descriptor,load:async()=>scene}])
const pixels=(context:WebGL2RenderingContext)=>{const bytes=new Uint8Array(context.drawingBufferWidth*context.drawingBufferHeight*4);context.readPixels(0,0,context.drawingBufferWidth,context.drawingBufferHeight,context.RGBA,context.UNSIGNED_BYTE,bytes);return bytes}
const surfaceStats=(entry:PhysicalLayerEntry)=>{
 const selected=visiblePhysicalSurfaceOwners(visiblePhysicalInspectionBoundaries(entry.meshes,multiply(matrix!,localMercatorMatrix(scene.anchor,scene.bearing))),entry.asset!.acceleration),materials:Record<string,{area:number;normal:number[]}>={}
 let physicalTriangles=0,duplicateFloat32Triangles=0
 for(const mesh of selected)for(let at=0;at<mesh.vertices.length;at+=21){
  const v=mesh.vertices,a=[v[at]!,v[at+1]!,v[at+2]!],b=[v[at+7]!,v[at+8]!,v[at+9]!],c=[v[at+14]!,v[at+15]!,v[at+16]!],u=b.map((n,i)=>n-a[i]!),w=c.map((n,i)=>n-a[i]!),area=Math.hypot(u[1]!*w[2]!-u[2]!*w[1]!,u[2]!*w[0]!-u[0]!*w[2]!,u[0]!*w[1]!-u[1]!*w[0]!)/2
  const role=mesh.materials?.[v[at+6]!]??mesh.object.materials?.[v[at+6]!]??mesh.object.material??mesh.object.kind,key=mesh.object.id+'/'+role,stats=materials[key]??{area:0,normal:[0,0,0]};stats.area+=area
  for(let axis=0;axis<3;axis++)stats.normal[axis]!+=area*(v[at+3+axis]!+v[at+10+axis]!+v[at+17+axis]!)/3
  materials[key]=stats;physicalTriangles++
  const points=[a,b,c].map(p=>[...Float32Array.from(p)].join(','));if(new Set(points).size<3)duplicateFloat32Triangles++
 }
 return {materials,physicalTriangles,duplicateFloat32Triangles}
}
;(window as any).ownershipComparison={
 async phase(levelId:string,scopeId:string|undefined,separation:number,alert:boolean){
  const view={...defaultPhysicalSceneView(scene.levels),mode:'3d' as const,levelId,separation,hiddenLayerIds:[],live:alert}
  controller.setView(scene.id,view);controller.home(scene.id,scopeId)
  const started=performance.now();while(!ready||!currentAsset||!matrix){if(errors.length||performance.now()-started>60000)throw Error(JSON.stringify(errors));await frames()};await frames()
  const legacyKey='legacy/'+JSON.stringify([levelId,scopeId,separation]);if(previousLegacy?.key!==legacyKey)previousLegacy={key:legacyKey,asset:legacyPrepare(scene,{...view,...(scopeId?{scopeId}:{})},legacyKey)};const legacy=previousLegacy.asset;admitPhysicalPickAcceleration(legacy.meshes,legacy.acceleration)
  const members=scopeId?physicalScopeMembers(scene.scopes??[],scopeId):null
  const filter=(asset:typeof legacy)=>{const result=members?asset.meshes.filter(mesh=>mesh.inspectionScopeId===scopeId||(mesh.annotation?.scopeIds??mesh.object.scopeIds)?.some(id=>members.has(id))):asset.meshes;if(result!==asset.meshes)derivePhysicalPickAcceleration(result,asset.acceleration);return result}
  const status=new Map(alert?scene.objects.flatMap(object=>object.subjectIds.map(id=>[id,{color:[.91,.17,.2] as const,emphasis:.65}] as const)):[])
  controller.setStatus(scene.id,status);await frames()
  const beforeEntry:PhysicalLayerEntry={scene,view,asset:legacy,meshes:filter(legacy),status},afterEntry:PhysicalLayerEntry={scene,view,asset:currentAsset!,meshes:filter(currentAsset!),status}
  const drawControlled=(entry:PhysicalLayerEntry)=>{legacyEntry=entry;gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(236/255,239/255,231/255,1);gl.clearDepth(1);gl.depthMask(true);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);legacyRenderer.render(matrix!);return pixels(gl)}
  // Same context/default-FBO sample locations isolate geometry from host GL
  // resolve differences. The MVP is the actual realized native-map camera.
  const a=drawControlled(beforeEntry),b=drawControlled(afterEntry),mapBytes=pixels(map.getCanvas().getContext('webgl2')!)
  let hostResolveDifferences=0;for(let at=0;at<b.length;at+=4)if(b[at]!==mapBytes[at]||b[at+1]!==mapBytes[at+1]||b[at+2]!==mapBytes[at+2])hostResolveDifferences++
  drawControlled(beforeEntry)
  let changedPixels=0,maxChannelDifference=0
  for(let at=0;at<a.length;at+=4){let changed=false;for(let channel=0;channel<4;channel++){const delta=Math.abs(a[at+channel]!-b[at+channel]!);changed||=delta!==0;maxChannelDifference=Math.max(maxChannelDifference,delta)}if(changed)changedPixels++}
  const pickDifferences=[];let picks=0
  for(let y=40;y<size().height;y+=70)for(let x=40;x<size().width;x+=70){const old=legacyRenderer.pick({x,y}),now=controller.pick({x,y});picks++;if(JSON.stringify(old?.subjectIds)!==JSON.stringify(now?.subjectIds)||old?.occurrenceId!==now?.occurrenceId)pickDifferences.push({x,y,old,now})}
  const oldStats=surfaceStats(legacyEntry!),newStats=surfaceStats({scene,view,asset:currentAsset!,meshes:filter(currentAsset!),status}),materialDifferences=[]
  for(const key of new Set([...Object.keys(oldStats.materials),...Object.keys(newStats.materials)])){const old=oldStats.materials[key],now=newStats.materials[key];if(JSON.stringify(old)!==JSON.stringify(now))materialDifferences.push({key,old,now})}
  document.querySelector('#caption')!.textContent=`${levelId} · ${scopeId??'whole unit'} · separation${separation} · ${alert?'controlled status':'architectural materials'}`
  return {levelId,scopeId,separation,alert,changedPixels,maxChannelDifference,hostResolveDifferences,picks,pickDifferences,materialDifferences,oldStats:{physicalTriangles:oldStats.physicalTriangles,duplicateFloat32Triangles:oldStats.duplicateFloat32Triangles},newStats:{physicalTriangles:newStats.physicalTriangles,duplicateFloat32Triangles:newStats.duplicateFloat32Triangles},camera:controller.cameraPose(),matrix:[...matrix!],sourceRevision:scene.revision,errors,passed:changedPixels===0&&pickDifferences.length===0&&errors.length===0}
 },
 finish(){legacyRenderer.dispose();controller.destroy();map.remove()}
}
