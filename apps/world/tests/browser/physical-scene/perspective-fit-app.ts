import { Map as MapLibreMap, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor } from '../../../src/core/packs/scene.ts'
import { createMapPhysicalViewport } from '../../../src/ui/map/physical-scene/map-viewport.ts'
import { createCanvasPhysicalViewport } from '../../../src/ui/map/physical-scene/canvas-viewport.ts'
import { createPhysicalSceneControllerForViewport } from '../../../src/ui/map/physical-scene/scene-controller.ts'
import { boundsCorners, inverse, localMercatorMatrix, transform } from '../../../src/ui/map/physical-scene/math.ts'
import { physicalLayoutPalette } from '../../../src/ui/physical-layout/palette.ts'
import type { PhysicalViewport } from '../../../src/ui/map/physical-scene/viewport.ts'
setWorkerUrl('/worker.mjs')
const {scenes,descriptors}=await(await fetch('/fixtures.json')).json() as {scenes:PackPhysicalScene[];descriptors:PackPhysicalSceneDescriptor[]}
const scene=scenes[0]!,descriptor=descriptors[0]!,errors:string[]=[],mapElement=document.querySelector<HTMLElement>('#map')!,canvas=document.querySelector<HTMLCanvasElement>('#canvas')!
const map=new MapLibreMap({container:mapElement,style:{version:8,sources:{},layers:[{id:'ground',type:'background',paint:{'background-color':'#e6e9df'}}]},center:scene.anchor,zoom:17,attributionControl:false,fadeDuration:0,canvasContextAttributes:{preserveDrawingBuffer:true}}),loaded=new Promise<void>(resolve=>map.once('load',()=>resolve()))
const tick=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
const placement=localMercatorMatrix(scene.anchor,scene.bearing),unplace=inverse(placement)
const localBounds={min:[-44.4,-26,0] as [number,number,number],max:[44.4,27.6,31.2] as [number,number,number]},world=boundsCorners(localBounds).map(point=>transform(placement,point)),bounds={min:[0,1,2].map(axis=>Math.min(...world.map(point=>point[axis]!))) as [number,number,number],max:[0,1,2].map(axis=>Math.max(...world.map(point=>point[axis]!))) as [number,number,number]}
interface Host{viewport:PhysicalViewport;controller:ReturnType<typeof createPhysicalSceneControllerForViewport>;matrix:number[]|null}
let active:Host|null=null
const hosts=new Map<string,Host>()
const rendered=(host:Host)=>new Promise<void>(resolve=>{const off=host.viewport.surface.on('render',()=>{off();resolve()});host.viewport.requestRender()})
declare global{interface Window{perspectiveFitProbe:{phase:(name:string,asymmetric:boolean,nativePadding:boolean,maximumPitch?:number,requestedPitch?:number,minimumPitch?:number)=>Promise<unknown>;lifecycle:()=>Promise<unknown>;finish:()=>unknown}}}
window.perspectiveFitProbe={async phase(name,asymmetric,nativePadding,maximumPitch=85,requestedPitch=57.914,minimumPitch=0){
 await loaded;active?.controller.setActive(false);mapElement.hidden=name!=='map';canvas.hidden=name!=='canvas';if(name==='map')map.resize()
 let host=hosts.get(name)
 if(!host){const viewport=name==='map'?createMapPhysicalViewport(map,()=>undefined):createCanvasPhysicalViewport(canvas),gl=(name==='map'?map.getCanvas():canvas).getContext('webgl2')!,bufferData=gl.bufferData.bind(gl);host={viewport,controller:null!,matrix:null};const value=host;gl.bufferData=((target:number,data:unknown,usage:number,...rest:unknown[])=>{if(target===gl.ARRAY_BUFFER&&usage===gl.DYNAMIC_DRAW&&data instanceof Float32Array&&data.length===17)value.matrix=[...data.subarray(0,16)];(bufferData as(...args:unknown[])=>void)(target,data,usage,...rest)}) as typeof gl.bufferData
 host.controller=createPhysicalSceneControllerForViewport(viewport,{palette:physicalLayoutPalette(canvas),onChange(){},reportError:error=>errors.push(error.message)});host.controller.setSources([{descriptor,load:async()=>scene}]);host.controller.setView(scene.id,{...host.controller.presentations()[0]!.view,mode:'3d',levelId:'all',live:false});host.controller.focus(scene.id,{scopeId:'building/turbine-hall',preservePose:false});hosts.set(name,host)}
 active=host;host.controller.setActive(true);if(name==='map'){map.setMinPitch(0);map.setMaxPitch(maximumPitch);map.setMinPitch(minimumPitch);map.setPadding(nativePadding?{left:90,right:15,top:40,bottom:25}:{left:0,right:0,top:0,bottom:0})}
 const started=performance.now();while(host.controller.presentations()[0]?.status!=='ready'){if(errors.length)throw Error(errors.join(';'));if(performance.now()-started>60000)throw Error('Actual source did not prepare');await tick()}
 const size=host.viewport.surface.getSize(),padding=asymmetric?{left:Math.min(size.width/4,180),right:25,top:Math.min(size.height/3,230),bottom:60}:{left:30,right:30,top:30,bottom:30}
 const authoredTarget=transform(placement,[0,-2,11.5]);host.viewport.fitWorld(bounds,{padding,preservePose:false,mode:'3d',bearing:scene.bearing+139.893,pitch:requestedPitch,target:authoredTarget});await rendered(host)
 if(!host.matrix)throw Error('No actual GPU placement matrix')
 const corners=boundsCorners(bounds).map(point=>{const local=transform(unplace,point),p=transform(host!.matrix!,local);return{x:(p[0]+1)*size.width/2,y:(1-p[1])*size.height/2,z:p[2]}}),p=transform(host.matrix,[0,-2,11.5]),anchor={x:(p[0]+1)*size.width/2,y:(1-p[1])*size.height/2},tolerance=1/devicePixelRatio
 const effectivePitch=name==='map'?Math.max(map.getMinPitch(),Math.min(requestedPitch,map.getMaxPitch())):requestedPitch,pose=host.viewport.cameraPose()
 const passed=Math.abs(pose.pitch-effectivePitch)<1e-8&&corners.every(point=>point.x>=padding.left-tolerance&&point.x<=size.width-padding.right+tolerance&&point.y>=padding.top-tolerance&&point.y<=size.height-padding.bottom+tolerance&&point.z>=-1-1e-5&&point.z<=1+1e-5)&&Math.abs(anchor.x-(padding.left+size.width-padding.right)/2)<=tolerance&&Math.abs(anchor.y-(padding.top+size.height-padding.bottom)/2)<=tolerance
 return{name,asymmetric,nativePadding,requestedPitch,minimumPitch:name==='map'?map.getMinPitch():null,maximumPitch:name==='map'?map.getMaxPitch():null,effectivePitch,size,padding,anchor,corners,passed,matrix:host.matrix,pose,actualNativeNearRatio:name==='map'?map.transform.nearZ/map.transform.cameraToCenterDistance:null,hardwareConcurrency:navigator.hardwareConcurrency,dpr:devicePixelRatio,errors}
},async lifecycle(){
 for(const value of hosts.values())value.controller.setActive(false)
 mapElement.hidden=false;canvas.hidden=true;map.resize();map.setMinPitch(0);map.setMaxPitch(85);const host=hosts.get('map')!;host.controller.setActive(true)
 const options={padding:{left:90,right:25,top:120,bottom:40},preservePose:false,mode:'3d' as const,bearing:139.893,pitch:57.914,target:transform(placement,[0,-2,11.5])}
 host.viewport.fitWorld(bounds,options);await rendered(host);const before=host.viewport.cameraPose(),during=map.getCenterClampedToGround()
 host.controller.setActive(false);await rendered(host);const suspended=map.getCenterClampedToGround()
 host.controller.setActive(true);await rendered(host);const resumed=host.viewport.cameraPose(),resumedClamp=map.getCenterClampedToGround()
 host.controller.setActive(false);host.viewport.fitWorld(bounds,options);await rendered(host);host.controller.setActive(true);await rendered(host);const handoffPose=host.viewport.cameraPose()
 host.controller.setActive(false);const point=map.getCenter();map.jumpTo({center:[point.lng+.001,point.lat]});await rendered(host);const moved=host.viewport.cameraPose()
 host.controller.setActive(true);await rendered(host);const afterExternalMove=host.viewport.cameraPose()
 host.viewport.fitWorld(bounds,{...options,mode:'2d'});await rendered(host);const plan=map.getCenterClampedToGround()
 map.setCenterClampedToGround(false);host.viewport.fitWorld(bounds,options);await rendered(host);host.viewport.fitWorld(bounds,{...options,mode:'2d'});await rendered(host);const freePlan={clamp:map.getCenterClampedToGround(),elevation:map.getCenterElevation()};host.viewport.fitWorld(bounds,options);await rendered(host);host.controller.destroy();const afterDispose=map.getCenterClampedToGround()
 return{passed:!freePlan.clamp&&freePlan.elevation===0&&!during&&suspended&&!resumedClamp&&plan&&!afterDispose&&Math.abs(before.elevation!-resumed.elevation!)<1e-6&&Math.abs(before.elevation!-handoffPose.elevation!)<1e-6&&Math.abs(moved.elevation!-afterExternalMove.elevation!)<1e-6&&JSON.stringify(moved.center)===JSON.stringify(afterExternalMove.center),during,suspended,resumedClamp,plan,freePlan,afterDispose,before,resumed,handoffPose,moved,afterExternalMove}
},finish(){for(const value of hosts.values())value.controller.destroy();return{errors}}}
