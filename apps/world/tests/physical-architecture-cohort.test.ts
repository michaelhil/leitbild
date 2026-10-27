import{test,expect}from'bun:test'
import type{PackPhysicalScene}from'../src/core/packs/scene.ts'
import{preparePhysicalGeometry}from'../src/ui/map/physical-scene/preparation.ts'
import{defaultPhysicalSceneView}from'../src/ui/map/physical-scene/types.ts'
import type{PhysicalLayerEntry}from'../src/ui/map/physical-scene/layer.ts'
import{physicalArchitectureCohort,createPhysicalArchitectureOrdering}from'../src/ui/map/physical-scene/architecture-cohort.ts'
import{preparePhysicalArchitectureBsp}from'../src/ui/map/physical-scene/architecture-bsp.ts'
import type{PhysicalArchitectureBsp,PhysicalArchitectureBspInput}from'../src/ui/map/physical-scene/architecture-bsp-types.ts'
import{localMercatorMatrix,multiply,transform}from'../src/ui/map/physical-scene/math.ts'
import{physicalPlanDepthDomain}from'../src/ui/map/physical-scene/plan-projection.ts'
type MutableEntry={-readonly[K in keyof PhysicalLayerEntry]:PhysicalLayerEntry[K]}
const entry=(id:string,kind='wall'):MutableEntry=>{
 const scene:PackPhysicalScene={id,revision:'r',targetObjectId:`owner:${id}`,anchor:[11,59],bearing:27,bounds:{min:[0,0,0],max:[2,2,2]},levels:[{id:'ground',label:'Ground',elevation:0,cutHeight:3}],objects:[{id:`object:${id}`,label:id,kind,levelId:'ground',subjectIds:[],material:'wall',positions:[0,0,0,2,0,2,0,2,2]}]}
 const view={...defaultPhysicalSceneView(scene.levels),mode:'3d' as const,cutaway:false},asset=preparePhysicalGeometry(scene,view,`asset:${id}`)
 return{scene,view,asset,meshes:asset.meshes,status:new Map()}
}
test('cohort basis is first actual architecture placement; exact offsets and placement reach the same world point',()=>{
 const irrelevant=entry('first-equipment','equipment'),a=entry('a'),b=entry('b');b.scene={...b.scene,anchor:[11.003,59.002],bearing:71}
 const mesh={...b.meshes[0]!,offset:[0,0,17] as const};b.meshes=[mesh]
 const cohort=physicalArchitectureCohort([irrelevant,a,b])!
 expect(cohort.sources[0]!.sceneId).toBe('a')
 expect([...cohort.frame.matrix]).toEqual([...localMercatorMatrix(a.scene.anchor,a.scene.bearing)])
 const source=cohort.sources.find(source=>source.sceneId==='b')!,actual=transform(multiply(cohort.frame.matrix,source.matrix),[.4,.7,.2]),expected=transform(localMercatorMatrix(b.scene.anchor,b.scene.bearing),[.4,.7,17.2])
 for(let axis=0;axis<3;axis++)expect(actual[axis]!).toBeCloseTo(expected[axis]!,14)
 expect(source.assetKey).toBe(b.asset!.key);expect(source.meshIndex).toBe(mesh.assetIndex!)
})
test('opacity edits reuse the cohort; actual separation and layer/scope mesh eligibility change it',()=>{
 const a=entry('a'),base=physicalArchitectureCohort([a])!
 expect(physicalArchitectureCohort([{...a,view:{...a.view,wallOpacity:.2,floorOpacity:.7}}])!.key).toBe(base.key)
 expect(physicalArchitectureCohort([{...a,view:{...a.view,levelId:'all',separation:4}}])!.key).not.toBe(base.key)
 expect(physicalArchitectureCohort([{...a,meshes:[]}])).toBeNull()
 const sameOffset=physicalArchitectureCohort([{...a,meshes:a.meshes.map(mesh=>({...mesh,offset:[0,0,9] as const}))}])!
 expect(sameOffset.sources[0]!.preparedOwnershipCohort).toBe(base.sources[0]!.preparedOwnershipCohort)
 expect(sameOffset.key).not.toBe(base.key)
})
test('solid Plan carries the same authored priority depth bands and ignores physical latitude height scale',()=>{
 const a=entry('a'),b=entry('b');a.view={...a.view,mode:'2d'};b.view={...b.view,mode:'2d'};b.scene={...b.scene,anchor:[11.02,60.2]};b.meshes=b.meshes.map(mesh=>({...mesh,planPriority:3}))
 const cohort=physicalArchitectureCohort([a,b])!,depth=physicalPlanDepthDomain([a,b])!,source=cohort.sources.find(source=>source.sceneId==='b')!
 expect(cohort.frame.planDepth).toEqual(depth)
 expect(source.matrix[10]).toBe(1);expect(source.matrix[14]).toBe(6*depth.span)
})
test('ordering cancels obsolete work and a refusal retries only on explicit demand',async()=>{
 const jobs:Array<{input:PhysicalArchitectureBspInput;signal:AbortSignal|undefined;resolve:(value:PhysicalArchitectureBsp)=>void;reject:(error:Error)=>void}>=[];let destroyed=0
 const prepare=Object.assign((input:PhysicalArchitectureBspInput,signal?:AbortSignal)=>new Promise<PhysicalArchitectureBsp>((resolve,reject)=>jobs.push({input,signal,resolve,reject})),{destroy:()=>{destroyed++},diagnostics:()=>({workers:jobs.length,pending:jobs.length})})
 const ordering=createPhysicalArchitectureOrdering(prepare,()=>{}),a=physicalArchitectureCohort([entry('a')])!,b=physicalArchitectureCohort([entry('b')])!
 ordering.request(a);ordering.request(b);expect(jobs[0]!.signal!.aborted).toBe(true)
 jobs[0]!.resolve(preparePhysicalArchitectureBsp(a));await Promise.resolve();expect(ordering.asset(a.key)).toBeNull()
 jobs[1]!.reject(Error('Actual partition refused'));await Promise.resolve();expect(ordering.state().status).toBe('unavailable')
 ordering.request(b);expect(jobs).toHaveLength(2);ordering.request(b,true);expect(jobs).toHaveLength(3)
 const result=preparePhysicalArchitectureBsp(b);jobs[2]!.resolve(result);await Promise.resolve();expect(ordering.asset(b.key)).toBe(result)
 ordering.request(b);expect(jobs).toHaveLength(3);ordering.destroy();expect(destroyed).toBe(1)
})
