import { expect, test } from 'bun:test'
import { fitPhysicalPerspective, type PhysicalPerspectiveFit } from '../src/ui/map/physical-scene/perspective-fit.ts'
import { boundsCorners, cross, dot, normalize, subtract, localMercatorMatrix, transform, type Vector3 } from '../src/ui/map/physical-scene/math.ts'
import { createPhysicalSceneControllerForViewport } from '../src/ui/map/physical-scene/scene-controller.ts'
import { preparePhysicalGeometry } from '../src/ui/map/physical-scene/preparation.ts'
import type { PhysicalViewport, PhysicalViewportRenderer } from '../src/ui/map/physical-scene/viewport.ts'
import type { PackPhysicalScene } from '../src/core/packs/scene.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'

/** Independent camera projection from returned eye/target, not fit inequalities. */
const project = (point: Vector3, fit: ReturnType<typeof fitPhysicalPerspective>, input: PhysicalPerspectiveFit) => {
 const b=input.bearing*Math.PI/180,back=normalize(subtract(fit.eye,fit.target)),right:Vector3=[Math.cos(b),Math.sin(b),0],up=cross(right,back),q=subtract(point,fit.eye),depth=-dot(q,back),tan=Math.tan(input.verticalFieldOfView/2)
 const x=dot(q,right)/(depth*tan*input.width/input.height)+(input.projectionOffset?.x??0),y=dot(q,up)/(depth*tan)+(input.projectionOffset?.y??0)
 return{x:(x+1)*input.width/2,y:(1-y)*input.height/2,depth}
}
for(const width of [638,1440])for(const pitch of [0,50,85])for(const bearing of [-25,139.893,275])for(const nativeOffset of [false,true])test(`8 corners: ${width}px pitch${pitch} bearing${bearing} nativeOffset${nativeOffset}`,()=>{
 const input:PhysicalPerspectiveFit={bounds:{min:[-44.4,-26,0],max:[44.4,27.6,31.2]},target:[0,-2,11.5],width,height:913,padding:{left:width===638?70:250,right:20,top:210,bottom:50},verticalFieldOfView:Math.PI/4,bearing,pitch,nearRatio:.02,...(nativeOffset?{projectionOffset:{x:.15,y:-.08}}:{})}
 const fit=fitPhysicalPerspective(input),pixels=boundsCorners(input.bounds).map(point=>project(point,fit,input))
 for(const point of pixels){expect(point.x).toBeGreaterThanOrEqual(input.padding.left-1e-7);expect(point.x).toBeLessThanOrEqual(input.width-input.padding.right+1e-7);expect(point.y).toBeGreaterThanOrEqual(input.padding.top-1e-7);expect(point.y).toBeLessThanOrEqual(input.height-input.padding.bottom+1e-7);expect(point.depth).toBeGreaterThanOrEqual(fit.distance*input.nearRatio-1e-7)}
 const anchor=project(input.target!,fit,input);expect(anchor.x).toBeCloseTo((input.padding.left+input.width-input.padding.right)/2,7);expect(anchor.y).toBeCloseTo((input.padding.top+input.height-input.padding.bottom)/2,7)
 const gaps=pixels.flatMap(point=>[point.x-input.padding.left,input.width-input.padding.right-point.x,point.y-input.padding.top,input.height-input.padding.bottom-point.y,point.depth-fit.distance*input.nearRatio]);expect(Math.min(...gaps.map(Math.abs))).toBeLessThan(1e-7)
})
test('host near ratio keeps a tall thin tower in front of the clip plane',()=>{
 const input:PhysicalPerspectiveFit={bounds:{min:[-.01,-.01,-500],max:[.01,.01,500]},width:1000,height:700,padding:{top:0,right:0,bottom:0,left:0},verticalFieldOfView:Math.PI/4,bearing:0,pitch:0,nearRatio:.02}
 const fit=fitPhysicalPerspective(input);expect(fit.distance).toBeCloseTo(500/.98,8);for(const corner of boundsCorners(input.bounds))expect(project(corner,fit,input).depth).toBeGreaterThanOrEqual(fit.distance*.02-1e-9)
})
test('rejects unusable viewport and invalid host projection facts',()=>{
 const input:PhysicalPerspectiveFit={bounds:{min:[0,0,0],max:[1,1,1]},width:100,height:100,padding:{top:0,right:0,bottom:0,left:0},verticalFieldOfView:Math.PI/4,bearing:0,pitch:50,nearRatio:.02}
 expect(()=>fitPhysicalPerspective({...input,padding:{...input.padding,left:100}})).toThrow();expect(()=>fitPhysicalPerspective({...input,nearRatio:NaN})).toThrow();expect(()=>fitPhysicalPerspective({...input,nearRatio:1})).toThrow()
})
test('authored area Home composes members and transforms one camera intent for both ports',async()=>{
 const bounds={min:[0,0,0] as [number,number,number],max:[6,6,3] as [number,number,number]},scope=(id:string)=>({id,label:id,kind:'building' as const,bounds,levelIds:['lower']})
 const scene:PackPhysicalScene={id:'s',revision:'r',targetObjectId:'p',anchor:[11.47,59.087],bearing:35,bounds,levels:[{id:'lower',label:'Lower',elevation:0,cutHeight:1.2}],scopes:[scope('one'),scope('two'),scope('other'),{id:'area',label:'Area',kind:'area',members:['one','two'],bounds,levelIds:['lower'],inspectionView:{bearing:90,pitch:60,target:[2,3,1]},levelInspectionViews:[{levelId:'lower',view:{bearing:45,pitch:55,target:[2,3,2]}}]}],objects:['one','two','other'].map((id,index)=>({id,label:id,kind:'equipment',levelId:'lower',scopeIds:[id],subjectIds:[],positions:[index,0,0,index+1,0,0,index,1,0]}))}
 const descriptor={...scene,locationValid:true,modelDigest:'a'.repeat(64),subjectIds:[]},fits:Array<{bounds:unknown;options:Parameters<PhysicalViewport['fitWorld']>[1]}>=[]
 let camera:import('../src/ui/map/physical-scene/types.ts').PhysicalCameraPose={center:[0,0] as [number,number],bearing:17,pitch:31,zoom:19,revision:0},installed:PhysicalViewportRenderer|null=null,getEntries:()=>ReadonlyArray<any>=()=>[]
 const renderer={setArchitectureBsp(){},setPalette(){},setHighlight(){},visitOccurrencePoints(){},retainGeometryIdentities(){},dispose(){},invalidatePicks(){},metrics:()=>null,pick:()=>null,cheapProject:()=>null,visibleAt:()=>false,project:()=>null}
 const viewport:PhysicalViewport={surface:{kind:'canvas',element:{} as HTMLElement,getSize:()=>({width:1000,height:700}),getPadding:()=>({top:0,right:0,bottom:0,left:0}),on:()=>()=>{}},ready:()=>true,on:()=>()=>{},intersectsBounds:()=>true,projectGeographic:()=>({x:0,y:0}),requestRender(){},installRenderer(entries){getEntries=entries;installed=renderer;return renderer},registered:value=>value===installed,orderRenderer(){},removeRenderer(){installed=null},cameraPose:()=>camera,setPose(patch){camera={...camera,...patch}},fitWorld(bounds,options){fits.push({bounds,options});if(!options.preservePose)camera={...camera,bearing:options.bearing,pitch:options.pitch??50}},panBy(){},setNavigationTool(){},cancelCamera(){},destroy(){}}
 const controller=createPhysicalSceneControllerForViewport(viewport,{palette:{materials:{},defaultMaterial:[.5,.5,.5],line:[0,0,0]},onChange(){},reportError:error=>{throw error},prepare:async(scene,view,key)=>preparePhysicalGeometry(scene,view,key)})
 controller.setSources([{descriptor,load:async()=>scene}]);controller.setView('s',{...defaultPhysicalSceneView(scene.levels),mode:'3d',levelId:'all',cutaway:false});for(let i=0;i<16;i++)await Promise.resolve()
 controller.home('s','area');for(let i=0;i<16;i++)await Promise.resolve();const authored=fits.at(-1)!.options;expect(authored.bearing).toBe(125);expect(authored.pitch).toBe(60);expect(authored.target).toEqual(transform(localMercatorMatrix(scene.anchor,35),[2,3,1]));expect(new Set(getEntries()[0].meshes.map((mesh:any)=>mesh.object.id))).toEqual(new Set(['one','two']))
 camera={...camera,bearing:78,pitch:22};controller.focus('s',{scopeId:'area',preservePose:true});expect(camera.bearing).toBe(78);expect(camera.pitch).toBe(22)
 controller.setView('s',{...defaultPhysicalSceneView(scene.levels),mode:'3d',levelId:'lower',cutaway:false});for(let i=0;i<16;i++)await Promise.resolve();controller.home('s','area');expect(fits.at(-1)!.options.bearing).toBe(80);expect(fits.at(-1)!.options.pitch).toBe(55);expect(fits.at(-1)!.options.target).toEqual(transform(localMercatorMatrix(scene.anchor,35),[2,3,2]))
 controller.focus('s',{occurrenceId:'one',preservePose:false});expect(fits.at(-1)!.options.target).toBeUndefined();expect(fits.at(-1)!.options.bearing).toBe(10);controller.destroy()
})
