import { expect, test } from 'bun:test'
import type { PackPhysicalScene } from '../src/core/packs/scene.ts'
import { preparePhysicalGeometry } from '../src/ui/map/physical-scene/preparation.ts'
import { defaultPhysicalSceneView, type Color, type PhysicalSubjectStyle } from '../src/ui/map/physical-scene/types.ts'
import type { PhysicalDraw } from '../src/ui/map/physical-scene/backend.ts'
import { createPhysicalObjectTableRows } from '../src/ui/map/physical-scene/object-table.ts'
import { physicalArchitectureOpacity } from '../src/ui/map/physical-scene/architecture-opacity.ts'
import { createPhysicalSceneStyleCache, physicalAgreedSubjectStyle } from '../src/ui/map/physical-scene/subject-styles.ts'
const scene:PackPhysicalScene={id:'rows',revision:'r',targetObjectId:'owner',anchor:[0,0],bearing:0,bounds:{min:[0,0,0],max:[8,2,2]},levels:[{id:'floor',label:'Floor',elevation:0,cutHeight:2}],objects:['slab','wall','equipment'].map((kind,i)=>({id:String(i),label:String(i),kind,levelId:'floor',positions:[i*3,0,0,i*3+1,0,0,i*3,1,0],edgePolicy:'none' as const,subjectIds:i===0?[]:i===1?['a','b']:['a']}))}
const asset=preparePhysicalGeometry(scene,{...defaultPhysicalSceneView(scene.levels),mode:'3d',levelId:'all'},'rows'),fallback:Color=[.7,.6,.5],styles:ReadonlyArray<PhysicalSubjectStyle|null>=[null,{color:null,emphasis:0},{color:[.1,.2,.3],emphasis:.8}],matrix=new Float32Array(16)
const draw=(extra:Partial<PhysicalDraw>={}):PhysicalDraw=>({asset,matrix,flat:false,meshes:asset.meshes,styles,...extra})
/** Frozen pre-cache table construction oracle. */
const original=(draws:ReadonlyArray<PhysicalDraw>,base=asset.meshes,color:Color=fallback)=>{
 const data=new Float32Array(draws.length*base.length*12)
 draws.forEach((draw,instance)=>{const shown=new Map(draw.meshes.map(mesh=>[mesh.assetIndex??base.indexOf(mesh),mesh]));base.forEach((mesh,index)=>{const displayed=shown.get(index),style=draw.styles[index],at=(instance*base.length+index)*12,c=style?.color??color;data.set([c[0],c[1],c[2],style?.color?style.emphasis:0],at);data.set([displayed?.offset[0]??mesh.offset[0],displayed?.offset[1]??mesh.offset[1],displayed?.offset[2]??mesh.offset[2],displayed?physicalArchitectureOpacity(mesh.object,draw.architecture??{}):0],at+4);const selection=draw.highlight?.occurrenceId===mesh.object.id?draw.highlight.color:null;data.set(selection?[...selection,.24]:[0,0,0,0],at+8)})});return data
}

test('camera-only updates reuse exact rows; source/visibility/offset/style/theme/opacity/highlight updates match original bytes',()=>{
 const update=createPhysicalObjectTableRows(),base=draw(),data=new Float32Array(36);expect(update(data,asset.meshes,[base],fallback)).toEqual({changed:true,updatedInstances:1,reusedInstances:0});expect(data).toEqual(original([base]))
 expect(update(data,asset.meshes,[{...base,matrix:new Float32Array(16).fill(3)}],fallback)).toEqual({changed:false,updatedInstances:0,reusedInstances:1})
 const variants=[draw({meshes:asset.meshes.slice(1)}),draw({meshes:asset.meshes.map((mesh,i)=>i===1?{...mesh,offset:[3,4,5]}:mesh)}),draw({styles:styles.map((style,i)=>i===2?{color:[.9,.8,.7],emphasis:.5}:style)}),draw({architecture:{wallOpacity:.5,floorOpacity:0}}),draw({highlight:{sceneId:'rows',occurrenceId:'2',color:[.3,.4,.9]}}),draw({asset:{...asset,identity:'other-owner'}}),base]
 for(const variant of variants){const result=update(data,asset.meshes,[variant],fallback);expect(result.updatedInstances).toBe(1);expect(data).toEqual(original([variant]));expect(update(data,asset.meshes,[variant],fallback).reusedInstances).toBe(1)}
 const palette:Color=[.8,.2,.5];expect(update(data,asset.meshes,[base],palette).updatedInstances).toBe(1);expect(data).toEqual(original([base],asset.meshes,palette))
 const replaced=new Float32Array(36);expect(update(replaced,asset.meshes,[base],palette).updatedInstances).toBe(1);expect(replaced).toEqual(data)
})

test('instance reorder/count/first-asset changes retain owner data and undefined-index fallback semantics',()=>{
 const a=draw(),b=draw({asset:{...asset,identity:'second'},styles:styles.map(()=>({color:[.8,.1,.2],emphasis:1}))}),update=createPhysicalObjectTableRows(),data=new Float32Array(72)
 for(const draws of [[a,b],[b,a],[b],[a,b]]){update(data,asset.meshes,draws,fallback);expect(data.slice(0,draws.length*36)).toEqual(original(draws))}
 const meshes=asset.meshes.map(mesh=>{const {assetIndex:_index,...value}=mesh;return value}),first=draw({meshes,asset:{...asset,meshes}}),reversed=[...meshes].reverse(),last=draw({meshes,asset:{...asset,meshes:reversed}})
 update(data,meshes,[first],fallback);expect(data.slice(0,36)).toEqual(original([first],meshes));update(data,reversed,[last],fallback);expect(data.slice(0,36)).toEqual(original([last],reversed))
})

test('style cache preserves subject agreement, live-off, source binding changes and stable visual values across new readings',()=>{
 const get=createPhysicalSceneStyleCache(),a:PhysicalSubjectStyle={color:[.1,.2,.3],emphasis:.7},b:PhysicalSubjectStyle={color:[.1,.2,.3],emphasis:.7},status=new Map([['a',a],['b',b]]),first=get(asset,status,true)
 expect(first).toEqual([null,a,a]);expect(get(asset,status,true)).toBe(first);expect(get(asset,new Map([['a',{...a,color:[.1,.2,.3]}],['b',{...b,color:[.1,.2,.3]}]]),true)).toBe(first)
 expect(get(asset,status,false)).toEqual([null,null,null]);expect(get(asset,new Map(),false)).toBe(get(asset,status,false));expect(get(asset,new Map([['a',a],['b',{color:null,emphasis:.7}]]),true)).toEqual([null,null,a])
 expect(physicalAgreedSubjectStyle(new Map(),['missing'])).toBeNull();expect(physicalAgreedSubjectStyle(status,[])).toBeNull();expect(physicalAgreedSubjectStyle(status,['b','a'])).toBe(b)
 const rebound={...asset,meshes:asset.meshes.map(mesh=>({...mesh,object:{...mesh.object,subjectIds:['new']}}))};expect(get(rebound,status,true)).toEqual([null,null,null])
})
