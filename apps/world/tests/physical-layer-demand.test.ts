import { expect, test } from 'bun:test'
import type { PackPhysicalScene } from '../src/core/packs/scene.ts'
import { physicalDesiredMeshLayers, physicalLayerUnion, physicalMeshDemandScene, physicalMeshLayers, physicalViewWithMeshCoverage } from '../src/ui/map/physical-scene/layer-demand.ts'
import { createPhysicalPreparationPool } from '../src/ui/map/physical-scene/preparation.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'
const fixture = (): PackPhysicalScene => ({ id:'layer-layout',revision:'immutable',targetObjectId:'plant',anchor:[0,0],bearing:0,bounds:{min:[0,0,0],max:[10,10,4]},levels:[{id:'ground',label:'Ground',elevation:0,cutHeight:2}],
 layers:[{id:'pipes',label:'Pipes',defaultVisible:false},{id:'power',label:'Power',defaultVisible:true},{id:'labels',label:'Labels',defaultVisible:true}],
 objects:['machine','hidden-pipe','visible-power'].map((id,index)=>({id,label:id,kind:'equipment',levelId:'ground',subjectIds:[`graph/${id}`],positions:[index*2,0,.2,index*2+1,0,.2,index*2,1,.2],edgePolicy:'none',...(index?{layerId:index===1?'pipes':'power'}:{})})) })

test('mesh demand keeps the complete retained source and excludes presentation-only toggles without layer-count masks',()=>{
 const source=fixture(),before=JSON.stringify(source),view={...defaultPhysicalSceneView(source.levels),mode:'3d' as const}
 expect(physicalMeshLayers(source,view)).toEqual(['pipes','power']);expect(physicalDesiredMeshLayers(source,view)).toEqual(['power'])
 expect(physicalDesiredMeshLayers(source,{...view,hiddenLayerIds:['pipes','labels']})).toEqual(['power'])
 const demand=physicalMeshDemandScene(source,view);expect(demand.objects.map(object=>object.id)).toEqual(['machine','visible-power']);expect(demand.objects[1]).toBe(source.objects[2]!)
 expect(physicalMeshDemandScene(source,{...view,hiddenLayerIds:[]})).toBe(source)
 const coverage=physicalLayerUnion(['power'],['pipes']),superset=physicalViewWithMeshCoverage(source,{...view,hiddenLayerIds:['power']},coverage)
 expect(physicalDesiredMeshLayers(source,superset)).toEqual(['pipes','power']);expect(JSON.stringify(source)).toBe(before)
 const many={...source,layers:Array.from({length:70},(_,i)=>({id:`layer-${i}`,label:`Layer${i}`,defaultVisible:true})),objects:Array.from({length:70},(_,i)=>({...source.objects[0]!,id:`machine-${i}`,layerId:`layer-${i}`}))}
 expect(physicalDesiredMeshLayers(many,view)).toHaveLength(70);expect(physicalLayerUnion(physicalDesiredMeshLayers(many,view))).toHaveLength(70)
})

test('real module worker preserves original source ordinals graph identity and prepared status-table ordinals across layer coverage',async()=>{
 const source=fixture(),before=JSON.stringify(source),view={...defaultPhysicalSceneView(source.levels),mode:'3d' as const},pool=createPhysicalPreparationPool(undefined,()=>2),prepare=pool.createPreparer()
 try {
  prepare.retainIdentities!(new Set(['same-design']))
  const first=await prepare(source,view,'default','same-design','full-source')
  expect(first.meshes.map(mesh=>mesh.object.id)).toEqual(['machine','visible-power']);expect(first.meshes[1]!.object).toBe(source.objects[2]!);expect(first.meshes[1]!.object.subjectIds).toEqual(['graph/visible-power'])
  expect(first.buffers.objectCount).toBe(first.meshes.length)
  for(let at=7;at<first.buffers.vertices.length;at+=8)expect(first.buffers.vertices[at]).toBeLessThan(first.meshes.length)
  const all=await prepare(source,{...view,hiddenLayerIds:[]},'all-layers','same-design','full-source')
  expect(all.meshes.map(mesh=>mesh.object.id)).toEqual(source.objects.map(object=>object.id));expect(all.meshes[1]!.object.subjectIds).toEqual(['graph/hidden-pipe'])
  const back=await prepare(source,view,'default','same-design','full-source');expect(back).toBe(first);expect(pool.diagnostics().registrations).toBe(1);expect(pool.diagnostics().cacheHits).toBe(1);expect(JSON.stringify(source)).toBe(before)
 } finally { prepare.destroy!() }
 expect(pool.diagnostics().workerAlive).toBe(false)
})
