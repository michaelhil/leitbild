import {test,expect} from 'bun:test'
import {createHash} from 'node:crypto'
import type {PhysicalSceneBounds} from '../src/core/packs/scene.ts'
import {createPhysicalSpatialIndex,visitPhysicalSpatialBounds,physicalSpatialBoundsOverlap} from '../src/ui/map/physical-scene/spatial-index.ts'
import {preparePhysicalSurfaceOwnership as before} from './fixtures/physical-layout/surface-ownership-before-centroid.ts'
import {preparePhysicalSurfaceOwnership as current} from '../src/ui/map/physical-scene/surface-ownership.ts'
import {resolvePhysicalDesign,pwrManifoldUnitPhysicalDesignRef,pwrManifoldCampusPhysicalDesignRef} from '../src/packs/physical-layout/design.ts'
import {compilePhysicalScene} from '../src/packs/physical-layout/native/drafting/compile-scene.ts'
import {buildVisibleMeshes,type PhysicalMesh} from '../src/ui/map/physical-scene/geometry.ts'
import {physicalSurfaceAnnotations} from '../src/ui/map/physical-scene/surface-annotations.ts'
import {clipPhysicalMeshesToScope} from '../src/ui/map/physical-scene/scope-clipping.ts'
import {preparePhysicalRenderBuffers} from '../src/ui/map/physical-scene/render-buffers.ts'
import {preparePhysicalPickAcceleration} from '../src/ui/map/physical-scene/picking.ts'
import {defaultPhysicalSceneView} from '../src/ui/map/physical-scene/types.ts'

const box=(x:number,y:number,z:number,dx:number,dy:number,dz:number):PhysicalSceneBounds=>({min:[x,y,z],max:[x+dx,y+dy,z+dz]})
const eligible=(values:readonly PhysicalSceneBounds[],query:PhysicalSceneBounds)=>values.flatMap((value,id)=>physicalSpatialBoundsOverlap(value,query)?[id]:[])
const query=(values:readonly PhysicalSceneBounds[],bounds:PhysicalSceneBounds)=>{const index=createPhysicalSpatialIndex(values,'overlap'),ids:number[]=[];visitPhysicalSpatialBounds(index,bounds,id=>{if(physicalSpatialBoundsOverlap(values[id]!,bounds))ids.push(id)});return ids.sort((a,b)=>a-b)}
test('atomic overlap hierarchy is complete for empty, equal, adjacent, planar and heterogeneous bounds',()=>{
 const cases:PhysicalSceneBounds[][]=[[],[box(0,0,0,0,0,0)],Array.from({length:17},()=>box(-0,0,0,4,4,0)),[box(0,0,0,1,1,0),box(1,0,0,1,1,0),box(1+Number.EPSILON,0,0,1,1,0)],Array.from({length:31},(_,id)=>box(id%3===0?1e8: -id,id*2,id%2?0:1e-8,id%5,1,id%4))]
 for(const values of cases){const index=createPhysicalSpatialIndex(values,'overlap');expect(index.order.length).toBe(values.length);expect(index.bounds.length/6).toBe(values.length?values.length*2-1:0)
  expect([...index.ranges].filter((_,i)=>i%2===1&&index.ranges[i]===1)).toHaveLength(values.length)
  expect(createPhysicalSpatialIndex(values,'overlap')).toEqual(index)
  for(const bounds of[...values,box(-1e9,-1e9,-1e9,2e9,2e9,2e9),box(1,1,0,0,0,0)])expect(query(values,bounds)).toEqual(eligible(values,bounds))
 }
})
test('spatial midpoint handles a skewed cluster and representably adjacent centroids without losing eligible pairs',()=>{
 let seed=1827;const random=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/2**32}
 const values=Array.from({length:96},(_,id)=>box(id===0?1e5:random(),random()*1e3,0,random()*100,random(),0))
 values.push(box(1,1,1,0,0,0),box(1+Number.EPSILON,1,1,0,0,0))
 for(const bounds of[...values,...Array.from({length:35},()=>box(random()*100,random()*1e3,0,random()*20,random()*20,0))])expect(query(values,bounds)).toEqual(eligible(values,bounds))
})
const fingerprint=(owned:ReturnType<typeof current>):string=>{
 const hash=createHash('sha256'),binary=(values:ArrayBufferView)=>hash.update(new Uint8Array(values.buffer,values.byteOffset,values.byteLength))
 for(const{object,vertices,lines,...metadata}of owned.meshes){hash.update(JSON.stringify([object.id,metadata]));binary(Float64Array.from(vertices));binary(Float64Array.from(lines))}
 const packed=preparePhysicalRenderBuffers(owned.meshes);binary(packed.vertices);binary(packed.lines);hash.update(JSON.stringify([packed.roles,packed.objectCount]))
 const pick=preparePhysicalPickAcceleration(owned.meshes)
 for(const index of[pick.meshes,...pick.triangles.map(t=>t.triangles)])for(const values of[index.bounds,index.children,index.ranges,index.order])binary(values)
 const{broadPhaseCandidates:_work,...truth}=owned.diagnostics;hash.update(JSON.stringify(truth));return hash.digest('hex')
}
const compare=(meshes:readonly PhysicalMesh[])=>{const a=before(meshes),b=current(meshes);expect(fingerprint(b)).toBe(fingerprint(a));expect(b.meshes.map(m=>m.object)).toEqual(a.meshes.map(m=>m.object))}
test('actual R6 unit/campus, every source floor and scoped cut geometry preserve frozen ownership, render and picking bytes',async()=>{
 for(const ref of[pwrManifoldUnitPhysicalDesignRef,pwrManifoldCampusPhysicalDesignRef]){
  const data=await resolvePhysicalDesign(ref);if(data.profile!=='drafting')throw Error('Expected exact R6 drafting source')
  const scene=compilePhysicalScene('equivalence',{...data,owner:{objectId:'owner'},placement:{anchor:[0,0],bearing:0}}),base={...defaultPhysicalSceneView(scene.levels),mode:'3d' as const,hiddenLayerIds:[]}
  const cases=[...['all',...scene.levels.map(l=>l.id)].map(levelId=>({...base,levelId})),{...base,levelId:'all',cutaway:false},{...base,levelId:'all',separation:1},...(ref.id==='pwr-full-unit'?['all','lower','operating'].map(levelId=>({...base,levelId,scopeId:'area/turbine-island'})):[])]
  for(const view of cases)compare(physicalSurfaceAnnotations(scene,view,clipPhysicalMeshesToScope(scene,view,buildVisibleMeshes(scene,view))))
 }
},120_000)
