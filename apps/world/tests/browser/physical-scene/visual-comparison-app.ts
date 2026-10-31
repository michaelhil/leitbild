import { buildScene, drawObjects } from '../../../../../experiments/physical-layout-trials/render/src/reference/scene.ts'
import { palette as referencePalette } from '../../../../../experiments/physical-layout-trials/render/src/reference/mesh.ts'
import { lookAt, perspective, multiply as originalMultiply, type V3 } from '../../../../../experiments/physical-layout-trials/render/src/reference/math.ts'
import { createRenderer as createOriginalRenderer, homeCamera } from './original-reference-renderer.ts'
import type { PackPhysicalScene } from '../../../src/core/packs/scene.ts'
import { physicalLayoutPalette } from '../../../src/ui/physical-layout/palette.ts'
import { preparePhysicalGeometry } from '../../../src/ui/map/physical-scene/preparation.ts'
import { createPhysicalSceneRenderer } from '../../../src/ui/map/physical-scene/renderer.ts'
import { inverse, localMercatorMatrix, multiply } from '../../../src/ui/map/physical-scene/math.ts'
import { physicalScopeMembers } from '../../../src/ui/map/physical-scene/scopes.ts'
import { defaultPhysicalSceneView } from '../../../src/ui/map/physical-scene/types.ts'

const source: PackPhysicalScene = await (await fetch('/scene.json')).json()
const errors: string[] = [], canvas = document.querySelector<HTMLCanvasElement>('canvas')!
const reference = buildScene().filter(object => object.id !== 'ground')
const state = { mode: 'all' as const, walls: 'cutaway' as const, utilities: false, service: false, crane: true, explode: 0 }
const origin: V3 = [44.4, 26, 0]
const camera = homeCamera(), eye: V3 = camera.target.map((value,axis)=>value + [Math.sin(camera.azimuth)*Math.cos(camera.elevation)*camera.distance, Math.sin(camera.elevation)*camera.distance, Math.cos(camera.azimuth)*Math.cos(camera.elevation)*camera.distance][axis]!) as unknown as V3
const swapped = new Float64Array([1,0,0,0, 0,0,1,0, 0,1,0,0, 0,0,0,1])
const shift = new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, ...origin,1])
const toLocal = ([x,y,z]: readonly number[]) => [x!-origin[0],z!-origin[1],y!-origin[2]]
const rgbRoles = new Map(Object.entries(referencePalette).map(([role,rgb])=>[rgb.join(','),role]))
const referenceObjects = drawObjects(reference,state,eye).map(({object,mesh,offset}) => {
 const positions:number[]=[],normals:number[]=[],materialIndices:number[]=[],materials:string[]=[],lines:number[]=[]
 for(let i=0;i<mesh.vertices.length;i+=9){positions.push(...toLocal([mesh.vertices[i]!,mesh.vertices[i+1]!+offset,mesh.vertices[i+2]!]));normals.push(mesh.vertices[i+3]!,mesh.vertices[i+5]!,mesh.vertices[i+4]!);const role=rgbRoles.get(mesh.vertices.slice(i+6,i+9).join(','));if(!role)throw Error('Reference colour has no declared material role');let index=materials.indexOf(role);if(index<0){index=materials.length;materials.push(role)};materialIndices.push(index)}
 for(let i=0;i<mesh.lines.length;i+=3)lines.push(...toLocal([mesh.lines[i]!,mesh.lines[i+1]!+offset,mesh.lines[i+2]!]))
 const kind = object.kind==='floor'?'slab':object.kind==='structure'||object.kind==='crane'?'support':object.kind==='utilities'?'pipe':object.kind==='service'?'context':object.kind
 return {id:object.id,label:object.name,kind,levelId:object.level==='link'?'site':object.level,positions,normals,materials,materialIndices,subjectIds:object.componentId?[object.componentId]:[],edgePolicy:'authored' as const,...(lines.length?{featureLines:[{positions:lines,material:'line'}]}:{})}
})
const bounds = (objects: typeof source.objects) => ({min:[0,1,2].map(axis=>Math.min(...objects.map(object=>{let low=Infinity;for(let i=axis;i<object.positions.length;i+=3)low=Math.min(low,object.positions[i]!);return low}))) as [number,number,number],max:[0,1,2].map(axis=>Math.max(...objects.map(object=>{let high=-Infinity;for(let i=axis;i<object.positions.length;i+=3)high=Math.max(high,object.positions[i]!);return high}))) as [number,number,number]})
const converted:PackPhysicalScene={...source,id:'reference-converted',revision:'exact-original-geometry',levels:[{id:'lower',label:'Lower',elevation:0,cutHeight:1.1},{id:'operating',label:'Operating',elevation:15,cutHeight:16.1}],objects:referenceObjects as PackPhysicalScene['objects'],bounds:bounds(referenceObjects as PackPhysicalScene['objects'])}
const scopeIds=[...physicalScopeMembers(source.scopes??[],'area/turbine-island')],hidden=new Set(source.layers?.filter(layer=>!layer.defaultVisible).map(layer=>layer.id)??[])
const objects=source.objects.filter(object=>!(object.layerId&&hidden.has(object.layerId))&&object.scopeIds?.some(id=>scopeIds.includes(id)))
const scoped:PackPhysicalScene={...source,objects,bounds:bounds(objects)}
const tick=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
let renderer:ReturnType<typeof createPhysicalSceneRenderer>|null=null, original:ReturnType<typeof createOriginalRenderer>|null=null
const frames:unknown[]=[]
declare global{interface Window{visualComparison:{draw:(variant:'original'|'original-through-current'|'r3-current',mode:'all'|'operating',status?:boolean)=>Promise<unknown>}}}
window.visualComparison={async draw(variant,mode,status=false){
 renderer?.dispose();renderer=null
 const viewState={...state,mode},cameraValue=homeCamera()
 if(mode==='operating'){cameraValue.target=[44,18,18];cameraValue.distance=120;cameraValue.azimuth=-.65;cameraValue.elevation=.65}
 const eyeValue=cameraValue.target.map((value,axis)=>value+[Math.sin(cameraValue.azimuth)*Math.cos(cameraValue.elevation)*cameraValue.distance,Math.sin(cameraValue.elevation)*cameraValue.distance,Math.cos(cameraValue.azimuth)*Math.cos(cameraValue.elevation)*cameraValue.distance][axis]!) as unknown as V3
 const local=multiply(multiply(originalMultiply(perspective(Math.PI/4,innerWidth/innerHeight,.1,700),lookAt(eyeValue,cameraValue.target,[0,1,0])),swapped),shift)
 if(variant==='original'){original??=createOriginalRenderer(canvas);original.draw(reference,viewState,cameraValue,null);await tick();return{variant,mode,camera:cameraValue,eye:eyeValue,objects:original.objects.map(value=>({id:value.object.id,triangles:value.mesh.vertices.length/27})),errors}}
 const gl=canvas.getContext('webgl2')!;canvas.width=Math.round(innerWidth*devicePixelRatio);canvas.height=Math.round(innerHeight*devicePixelRatio);gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(.927,.941,.904,1);gl.depthMask(true);gl.clearDepth(1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT)
 let scene=variant==='original-through-current'?converted:scoped
 // Original low/full variants were already selected by its frozen policy.
 const view={...defaultPhysicalSceneView(scene.levels),mode:'3d' as const,levelId:mode==='all'?'all':'operating',cutaway:variant==='r3-current',live:status}
 if(variant==='original-through-current'&&mode==='operating')scene={...converted,objects:converted.objects.filter(object=>object.levelId==='operating')}
 const asset=preparePhysicalGeometry(scene,view,variant+'/'+mode,variant+'/'+mode),palette=physicalLayoutPalette(canvas)
 const styles=new Map(status?scene.objects.flatMap(object=>object.subjectIds.map(id=>[id,{color:[.91,.17,.20] as const,emphasis:.65}] as const)):[])
 const entry={scene,meshes:asset.meshes,asset,view,status:styles}
 renderer=createPhysicalSceneRenderer(gl,()=>[entry],palette,()=>({width:innerWidth,height:innerHeight}),error=>errors.push(error.message));renderer.render(multiply(local,inverse(localMercatorMatrix(scene.anchor,scene.bearing))))
 await tick();gl.finish()
 const result={variant,mode,status,camera:cameraValue,eye:eyeValue,physicalCamera:[eyeValue[0],eyeValue[2],eyeValue[1]],sourceOrigin:origin,sourceObjects:scene.objects.length,scopeIds,materialUsage:scene.objects.reduce((roles,object)=>{for(const index of object.materialIndices??[]){const role=object.materials?.[index]??'default';roles[role]=(roles[role]??0)+1}return roles},{} as Record<string,number>),palette,localMatrix:[...local],metrics:renderer.metrics(),errors,glError:gl.getError()};frames.push(result);return result
}}
