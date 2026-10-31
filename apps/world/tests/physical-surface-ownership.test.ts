import { expect, test } from 'bun:test'
import type { PackPhysicalScene, PhysicalSceneObject } from '../src/core/packs/scene.ts'
import { preparePhysicalGeometry } from '../src/ui/map/physical-scene/preparation.ts'
import { visiblePhysicalSurfaceOwners } from '../src/ui/map/physical-scene/surface-ownership.ts'
import { pickPhysicalMesh } from '../src/ui/map/physical-scene/picking.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'
import { projectPhysicalPlan } from '../src/ui/map/physical-scene/plan-projection.ts'
import { inverse, localMercatorMatrix } from '../src/ui/map/physical-scene/math.ts'
const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
const quad = (id: string, x0: number, y0: number, x1: number, y1: number, z = 0, reverse = false): PhysicalSceneObject => ({ id, label: id, kind: 'context', levelId: 'site', subjectIds: [], edgePolicy: 'none', positions: reverse ? [x0,y0,z,x1,y0,z,x0,y1,z,x1,y0,z,x1,y1,z,x0,y1,z] : [x0,y0,z,x1,y0,z,x1,y1,z,x0,y0,z,x1,y1,z,x0,y1,z] })
const source = (objects: PhysicalSceneObject[]): PackPhysicalScene => ({ id: 'surface', revision: 'r', targetObjectId: 'owner', anchor: [0,0], bearing: 0, bounds: { min: [-1,-1,-1], max: [1,1,1] }, levels: [{id:'ground',label:'Ground',elevation:0,cutHeight:1}], objects })
const prepared = (value: PackPhysicalScene) => preparePhysicalGeometry(value,{...defaultPhysicalSceneView(value.levels),mode:'3d',levelId:'all'},'surface')
const pick = (meshes: ReturnType<typeof prepared>['meshes'], x: number, y: number) => pickPhysicalMesh([{sceneId:'surface',meshes,matrix:identity}],{x:(x+1)*100,y:(1-y)*100},200,200)?.mesh.object.id
const area = (meshes: ReturnType<typeof prepared>['meshes'], id: string) => meshes.filter(mesh=>mesh.object.id===id).reduce((sum,mesh)=>{for(let at=0;at<mesh.vertices.length;at+=21){const v=mesh.vertices;sum+=Math.abs((v[at+7]!-v[at]!)*(v[at+15]!-v[at+1]!)-(v[at+14]!-v[at]!)*(v[at+8]!-v[at+1]!))/2}return sum},0)

test('different coplanar tessellations have one first-source display owner and retain the hidden alternative',()=>{
 const value=source([quad('first',-.6,-.6,.6,.6),quad('later',-.8,-.3,.8,.3,0,true)]),before=JSON.stringify(value),asset=prepared(value),visible=visiblePhysicalSurfaceOwners(asset.meshes)
 expect(pick(visible,0,0)).toBe('first');expect(pick(visible,.7,0)).toBe('later');expect(area(visible,'later')).toBeCloseTo(.24,10)
 const filtered=visiblePhysicalSurfaceOwners(asset.meshes.filter(mesh=>mesh.object.id!=='first'))
 expect(pick(filtered,0,0)).toBe('later');expect(area(filtered,'later')).toBeCloseTo(.96,10);expect(JSON.stringify(value)).toBe(before);expect(asset.surfaceOwnership.coincidentPairs.some(pair=>pair.first==='first'&&pair.later==='later')).toBe(true)
 expect(visiblePhysicalSurfaceOwners(asset.meshes)).toBe(visible)
})

test('coplanar partitioning keeps real holes and does not remove an entire partly overlapping triangle',()=>{
 const ring=[quad('top',-.8,.3,.8,.8),quad('bottom',-.8,-.8,.8,-.3),quad('left',-.8,-.3,-.3,.3),quad('right',.3,-.3,.8,.3)],value=source([...ring,quad('behind',-.9,-.9,.9,.9,0,true)]),asset=prepared(value),visible=visiblePhysicalSurfaceOwners(asset.meshes)
 expect(pick(visible,0,0)).toBe('behind');expect(pick(visible,0,.5)).toBe('top');expect(pick(visible,.85,0)).toBe('behind');expect(area(visible,'behind')).toBeCloseTo(1.04,10)
})

test('opposite winding, diagonal planes and close but distinct surfaces do not require culling or a physical Z epsilon',()=>{
 const a=quad('first',-.6,-.6,.6,.6),b=quad('second',-.8,-.3,.8,.3,0,true)
 const reversed: number[] = []; for (let at=0;at<b.positions.length;at+=9) reversed.push(...Array.from(b.positions.slice(at,at+3)),...Array.from(b.positions.slice(at+6,at+9)),...Array.from(b.positions.slice(at+3,at+6))); b.positions=reversed
 for(const object of [a,b]){const values=Array.from(object.positions);for(let at=0;at<values.length;at+=3)values[at+2]=.2+values[at]!*.3+values[at+1]!*.1;object.positions=values}
 const asset=prepared(source([a,b]));expect(pick(visiblePhysicalSurfaceOwners(asset.meshes),0,0)).toBe('first')
 const distinct=prepared(source([quad('front',-.6,-.6,.6,.6),quad('separated',-.8,-.3,.8,.3,1e-8,true)]));expect(distinct.surfaceOwnership.coincidentPairs.filter(pair=>pair.first!==pair.later)).toEqual([])
})

test('Plan semantic bands remain independent of physical coincidence',()=>{
 const value=source([{...quad('floor',-.6,-.6,.6,.6),kind:'slab'},{...quad('equipment',-.6,-.6,.6,.6,0,true),kind:'equipment'}]),view={...defaultPhysicalSceneView(value.levels),mode:'2d' as const},asset=preparePhysicalGeometry(value,view,'plan'),meshes=visiblePhysicalSurfaceOwners(asset.meshes)
 const projected=projectPhysicalPlan([{scene:value,asset,meshes,view,status:new Map()}],inverse(localMercatorMatrix(value.anchor,value.bearing)))[0]!
 expect(pickPhysicalMesh([{sceneId:'surface',meshes:projected.meshes,matrix:projected.matrix}],{x:100,y:100},200,200)?.mesh.object.id).toBe('equipment')
})

test('within-object material interfaces retain the first triangle and keep non-overlapping later material',()=>{
 const first=quad('compound',-.6,-.6,.6,.6),later=quad('compound',-.8,-.3,.8,.3,0,true),object={...first,positions:[...first.positions,...later.positions],materials:['earlier','later'],materialIndices:[...Array(6).fill(0),...Array(6).fill(1)]},asset=prepared(source([object])),visible=visiblePhysicalSurfaceOwners(asset.meshes)
 const byRole=[0,0]; for(const mesh of visible)for(let at=0;at<mesh.vertices.length;at+=21){const v=mesh.vertices,role=v[at+6]!;byRole[role]!+=Math.abs((v[at+7]!-v[at]!)*(v[at+15]!-v[at+1]!)-(v[at+14]!-v[at]!)*(v[at+8]!-v[at+1]!))/2}
 expect(byRole[0]).toBeCloseTo(1.44,10);expect(byRole[1]).toBeCloseTo(.24,10);expect(asset.surfaceOwnership.coincidentPairs.some(pair=>pair.first==='compound'&&pair.later==='compound')).toBe(true)
})

test('numerical coplanarity does not merge representably separated planes at large source coordinates',()=>{
 const first=quad('first',-.6,-.6,.6,.6),later=quad('later',-.8,-.3,.8,.3,1e-8,true)
 for(const object of[first,later])object.positions=Array.from(object.positions,value=>value+1e6)
 const asset=prepared(source([first,later]));expect(asset.surfaceOwnership.coincidentPairs.filter(pair=>pair.first!==pair.later)).toEqual([])
})

test('a numerically thin triangle cannot become an unbounded occluder when its turn is uncertain',()=>{
 const thin={...quad('thin',0,0,1,1),positions:[0,0,0,1,1,0,1+2**-51,1,0]},asset=prepared(source([thin,quad('behind',.1,.1,.9,.9)])),visible=visiblePhysicalSurfaceOwners(asset.meshes)
 expect(pick(visible,.5,.2)).toBe('behind');expect(area(visible,'behind')).toBeCloseTo(.64,12)
})

test('a numerically thin physical triangle cannot be hidden by a spatially distant uncertain plane cover', () => {
 const step = 2 ** -40, floor = quad('floor',0,0,200,200), positions = [100,100,.5,100+step,100,.5,100,100+step,.5]
 const sliver: PhysicalSceneObject = {id:'physical-sliver',label:'Physical sliver',kind:'equipment',levelId:'site',positions,subjectIds:['sliver'],material:'sliver-metal',edgePolicy:'none'}
 const value = {...source([floor,sliver]),bounds:{min:[0,0,-1] as [number,number,number],max:[200,200,1] as [number,number,number]}}, before = JSON.stringify(value), asset = prepared(value), visible = visiblePhysicalSurfaceOwners(asset.meshes)
 const retained = visible.filter(mesh=>mesh.object.id==='physical-sliver')
 expect(retained).toHaveLength(1);expect(retained[0]!.vertices.length).toBe(21)
 const actual: number[]=[];for(let at=0;at<retained[0]!.vertices.length;at+=7)actual.push(...retained[0]!.vertices.slice(at,at+3))
 expect(actual).toEqual(positions)
 expect(asset.surfaceOwnership.coincidentPairs.some(pair=>pair.first==='floor'&&pair.later==='physical-sliver')).toBe(false)
 expect(JSON.stringify(value)).toBe(before)
})
