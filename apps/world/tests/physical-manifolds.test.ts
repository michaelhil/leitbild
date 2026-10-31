import {test,expect} from 'bun:test'
import {resolvePhysicalDesign,pwrConnectedUnitPhysicalDesignRef,pwrConnectedCampusPhysicalDesignRef,pwrManifoldUnitPhysicalDesignRef,pwrManifoldCampusPhysicalDesignRef} from '../src/packs/physical-layout/design.ts'
import {pwrManifoldInstallations,pwrTurbinePhysicalFittings,createPwrManifoldUnitArtifacts,createPwrManifoldCampusArtifacts} from '../src/packs/physical-layout/authoring/pwr-manifolds.ts'
import {compilePhysicalObjects,compilePhysicalScene} from '../src/packs/physical-layout/native/drafting/compile-scene.ts'
import {elementWorld,type V3} from '../src/packs/physical-layout/native/drafting/source.ts'
import {physicalCoverageIssues} from '../src/packs/physical-layout/coverage.ts'
import {preparePhysicalGeometry} from '../src/ui/map/physical-scene/preparation.ts'
import {defaultPhysicalSceneView} from '../src/ui/map/physical-scene/types.ts'

const [old,current,site]=await Promise.all([resolvePhysicalDesign(pwrConnectedUnitPhysicalDesignRef),resolvePhysicalDesign(pwrManifoldUnitPhysicalDesignRef),resolvePhysicalDesign(pwrManifoldCampusPhysicalDesignRef)])
if(old.profile!=='drafting'||current.profile!=='drafting'||site.profile!=='drafting')throw Error('Manifold installation must use the retained drafting compiler')
const source=current.source,network=source.routing!,headers=new Set(pwrManifoldInstallations.map(i=>i.elementId)),elements=new Map(source.elements.map(e=>[e.id,e]))
const oldSource=old.source,oldBindings=old.bindings
const body=compilePhysicalObjects(current),objects=new Map(body.map(o=>[o.id,o]))
const world=(terminal:typeof network.terminals[number]):V3=>{const p=elementWorld(source,elements.get(terminal.elementId)!),c=Math.cos(p.yaw),s=Math.sin(p.yaw),v=terminal.local;return[p.position[0]+c*v[0]-s*v[1],p.position[1]+s*v[0]+c*v[1],p.position[2]+v[2]]}

test('R6 is an exact new source revision; R5 and all unrelated machinery and accepted routes remain retained',async()=>{
 expect(old.design.revision).toBe('pwr-full-unit-20261027-r5');expect(current.design.revision).toBe('pwr-full-unit-20261028-r6')
 expect(current.compiler).toEqual(old.compiler);expect(current.modelRequirement).toEqual(old.modelRequirement)
 for(const e of oldSource.elements)if(!headers.has(e.id))expect(elements.get(e.id)).toEqual(e)
 const changed=new Set(network.terminals.filter(t=>t.elementId.includes('/nozzle/')).map(t=>t.id));let unchanged=0,rerouted=0
 for(const route of oldSource.routing!.connections){const next=network.connections.find(c=>c.id===route.id)!;expect(next.graphConnectionId).toBe(route.graphConnectionId)
  if(changed.has(route.from)||changed.has(route.to)){rerouted++;expect(next.solution!.length).toBeGreaterThan(1)}else{unchanged++;expect(next).toEqual(route)}}
 expect({unchanged,rerouted}).toEqual({unchanged:119,rerouted:33});expect(network.terminals).toHaveLength(239);expect(network.connections).toHaveLength(152)
 expect(new Set(current.bindings.map(b=>b.elementId))).toEqual(new Set(oldBindings.map(b=>b.elementId)))
 expect((await resolvePhysicalDesign(pwrConnectedCampusPhysicalDesignRef)).design.revision).toBe('pwr-campus-20261027-r5')
})

test('every manifold has distinct installed side nozzles, exact outward terminal faces and explicit visible closed ends',()=>{
 for(const install of pwrManifoldInstallations){
  const header=elements.get(install.elementId)!,axis=install.axis==='x'?0:1;expect(header.path).toEqual([install.from,install.to]);expect(header.material).toBe(install.material)
  const points:V3[]=[]
  for(const tap of install.taps){const terminal=network.terminals.find(t=>t.subjectId===install.subject&&t.port===tap.port)!,nozzle=elements.get(terminal.elementId)!,flange=elements.get(`${install.elementId}/flange/${tap.port}`)!
   expect(terminal.elementId).toBe(`${install.elementId}/nozzle/${tap.port}`);expect(terminal.outward).toEqual(tap.outward);expect(tap.outward[axis]).toBe(0)
   const center=[...install.from]as V3;center[axis]=tap.at;const end=center.map((v,a)=>v+tap.outward[a]!*install.nozzleReach)as V3
   expect(world(terminal)).toEqual(end);points.push(end)
   for(const hardware of[nozzle,flange]){expect(hardware.material).toBe(install.material);expect(current.bindings).toContainEqual({physicalElementId:hardware.id,elementId:install.subject,relation:'partOf'})}
   const segment=nozzle.member!;expect(segment.kind).toBe('tube');if(segment.kind!=='tube')throw Error('Nozzle must be a cylinder')
   const a=segment.points[0]!,b=segment.points[1]!,direction=b.map((v,i)=>v-a[i]!),length=Math.hypot(...direction)
   expect(direction.map(v=>v/length)).toEqual(tap.outward)
   for(const connection of network.connections.filter(c=>c.from===terminal.id||c.to===terminal.id))expect(connection.from===terminal.id?connection.solution![0]:connection.solution!.at(-1)).toEqual(end)
  }
  expect(new Set(points.map(p=>JSON.stringify(p))).size).toBe(install.taps.length)
  for(const end of['first','last']){const cap=elements.get(`${install.elementId}/blind-${end}`)!;expect(cap.label).toContain('closed, not a route continuation');expect(cap.member?.kind).toBe('tube');expect(cap.material).toBe(install.material)}
 }
 expect(physicalCoverageIssues({evidence:current.coverageEvidence,physicalIds:[...elements.keys(),...network.connections.map(c=>c.id)],ownerSubjectIds:current.coverageEvidence.dispositions.map(d=>d.subjectId),bindings:current.bindings})).toEqual([])
})

const sub=(a:V3,b:V3):V3=>a.map((v,i)=>v-b[i]!)as V3,dot=(a:V3,b:V3)=>a.reduce((sum,v,i)=>sum+v*b[i]!,0),along=(a:V3,b:V3,t:number):V3=>a.map((v,i)=>v+b[i]!*t)as V3
// Independent closest-point triangle oracle; no source-family surface formula.
const closest=(p:V3,a:V3,b:V3,c:V3):V3=>{
 const ab=sub(b,a),ac=sub(c,a),ap=sub(p,a),d1=dot(ab,ap),d2=dot(ac,ap);if(d1<=0&&d2<=0)return a
 const bp=sub(p,b),d3=dot(ab,bp),d4=dot(ac,bp);if(d3>=0&&d4<=d3)return b
 const vc=d1*d4-d3*d2;if(vc<=0&&d1>=0&&d3<=0)return along(a,ab,d1/(d1-d3))
 const cp=sub(p,c),d5=dot(ab,cp),d6=dot(ac,cp);if(d6>=0&&d5<=d6)return c
 const vb=d5*d2-d1*d6;if(vb<=0&&d2>=0&&d6<=0)return along(a,ac,d2/(d2-d6))
 const va=d3*d6-d5*d4;if(va<=0&&d4-d3>=0&&d5-d6>=0)return along(b,sub(c,b),(d4-d3)/(d4-d3+d5-d6))
 return a.map((n,i)=>n+ab[i]!*vb/(va+vb+vc)+ac[i]!*vc/(va+vb+vc))as V3
}
test('all eight added turbine fittings mount on actual non-foundation family triangles and join the exact retained paths',()=>{
 for(const fitting of pwrTurbinePhysicalFittings){const e=elements.get(fitting.id)!,original=elements.get(fitting.headerId)!,mount=e.path![0]!,p=sub(mount,source.origin),o=objects.get(fitting.equipmentId)!
  let distance=Infinity,outwardContact=false;const count=o.indices?.length??o.positions.length/3,arithmeticBound=64*Number.EPSILON*Math.max(1,...p.map(Math.abs))
  for(let i=0;i<count;i+=3){const ids=[0,1,2].map(k=>o.indices?.[i+k]??i+k);if(ids.every(id=>o.materials?.[o.materialIndices?.[id]??-1]==='plinth'))continue
   const[a,b,c]=ids.map(id=>[o.positions[id*3]!,o.positions[id*3+1]!,o.positions[id*3+2]!]as V3)as[V3,V3,V3],q=closest(p,a,b,c),d=Math.hypot(...sub(p,q));if(Number.isFinite(d))distance=Math.min(distance,d)
   if(d<=arithmeticBound&&ids.some(id=>fitting.mountAxis.reduce<number>((sum,value,axis)=>sum+value*o.normals![id*3+axis]!,0)>0))outwardContact=true}
  expect(distance).toBeLessThanOrEqual(arithmeticBound);expect(outwardContact).toBe(true)
  expect(e.path!.at(-1)).toEqual(fitting.kind==='msr-feed'?original.path![0]:original.path!.at(-1))
  expect(current.bindings).toContainEqual({physicalElementId:fitting.id,elementId:'turbine',relation:'partOf'})
 }
})

test('campus civil correction retains unrelated geometry and both exact sources regenerate without altering the physical owner model',async()=>{
 const previous=await resolvePhysicalDesign(pwrConnectedCampusPhysicalDesignRef);if(previous.profile!=='drafting')throw Error('Expected drafting campus')
 const compile=(d:typeof current)=>compilePhysicalScene('test',{...d,owner:{objectId:'owner'},placement:{anchor:[0,0],bearing:0}})
 expect(compile(site).objects.filter(o=>o.id!=='pavement/roads')).toEqual(compile(previous).objects.filter(o=>o.id!=='pavement/roads'))
 const regenerated=createPwrManifoldUnitArtifacts();expect(regenerated.source).toEqual(source);expect(regenerated.bindings).toEqual(current.bindings);expect(regenerated.coverage).toEqual(current.coverageEvidence)
 expect(JSON.stringify(createPwrManifoldCampusArtifacts().source)).toBe(JSON.stringify(site.source))
},30_000)

test('every actual R6 unit floor and turbine inspection scope prepares its full utility geometry without invalid cut topology',()=>{
 const scene=compilePhysicalScene('inspection-proof',{...current,owner:{objectId:'owner'},placement:{anchor:[0,0],bearing:0}}),base={...defaultPhysicalSceneView(scene.levels),mode:'3d' as const,hiddenLayerIds:[]}
 for(const levelId of['all',...scene.levels.map(level=>level.id)]){
  const prepared=preparePhysicalGeometry(scene,{...base,levelId},`unit/${levelId}`)
  expect(prepared.meshes.some(mesh=>mesh.object.kind==='equipment')).toBe(true)
  for(const mesh of prepared.meshes.filter(mesh=>mesh.object.id.startsWith('connection/')))expect(mesh.object.subjectIds).toHaveLength(1)
 }
 for(const levelId of['all','lower','operating']){
  const prepared=preparePhysicalGeometry(scene,{...base,levelId,scopeId:'area/turbine-island'},`turbine/${levelId}`)
  expect(prepared.meshes.some(mesh=>mesh.object.kind==='equipment')).toBe(true)
 }
},30_000)
