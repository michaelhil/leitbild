// Test-only fresh-process comparison, never a production preparation policy.
import {createHash} from 'node:crypto'
import {resolvePhysicalDesign,pwrConnectedUnitPhysicalDesignRef,pwrConnectedCampusPhysicalDesignRef} from '../../src/packs/physical-layout/design.ts'
import {compilePhysicalScene} from '../../src/packs/physical-layout/native/drafting/compile-scene.ts'
import {buildVisibleMeshes} from '../../src/ui/map/physical-scene/geometry.ts'
import {physicalSurfaceAnnotations} from '../../src/ui/map/physical-scene/surface-annotations.ts'
import {clipPhysicalMeshesToScope} from '../../src/ui/map/physical-scene/scope-clipping.ts'
import {preparePhysicalSurfaceOwnership as before} from '../../tests/fixtures/physical-layout/surface-ownership-before-centroid.ts'
import {preparePhysicalSurfaceOwnership as centroid} from '../../src/ui/map/physical-scene/surface-ownership.ts'
import {preparePhysicalRenderBuffers} from '../../src/ui/map/physical-scene/render-buffers.ts'
import {preparePhysicalPickAcceleration} from '../../src/ui/map/physical-scene/picking.ts'
import {defaultPhysicalSceneView} from '../../src/ui/map/physical-scene/types.ts'
const args=new Map(Bun.argv.slice(2).map(a=>{const at=a.indexOf('=');return[a.slice(0,at),a.slice(at+1)]})),engine=args.get('--engine'),design=args.get('--design'),output=args.get('--output')
if(!['before','centroid'].includes(engine??'')||!['unit','campus'].includes(design??'')||!output)throw Error('Expected --engine=before|centroid --design=unit|campus --output=path')
const data=await resolvePhysicalDesign(design==='unit'?pwrConnectedUnitPhysicalDesignRef:pwrConnectedCampusPhysicalDesignRef)
if(data.profile!=='drafting')throw Error('Requires the exact retained R5 drafting source')
const scene=compilePhysicalScene('census',{...data,owner:{objectId:'census'},placement:{anchor:[0,0],bearing:0}}),view={...defaultPhysicalSceneView(scene.levels),mode:'3d' as const,levelId:'all',hiddenLayerIds:[]}
const meshes=physicalSurfaceAnnotations(scene,view,clipPhysicalMeshesToScope(scene,view,buildVisibleMeshes(scene,view)))
// One GC after source/mesh construction and before this process's ONE engine
// call. No fingerprint or prior engine output precedes its measured interval.
Bun.gc(true)
const memoryBefore=process.memoryUsage(),cpuBefore=process.cpuUsage(),at=performance.now(),result=(engine==='before'?before:centroid)(meshes),ms=performance.now()-at,cpu=process.cpuUsage(cpuBefore),memoryAfter=process.memoryUsage()
const hash=createHash('sha256'),binary=(values:ArrayBufferView)=>hash.update(new Uint8Array(values.buffer,values.byteOffset,values.byteLength))
for(const {object,vertices,lines,...metadata}of result.meshes){hash.update(JSON.stringify([object.id,metadata]));binary(Float64Array.from(vertices));binary(Float64Array.from(lines))}
const packed=preparePhysicalRenderBuffers(result.meshes);binary(packed.vertices);binary(packed.lines);hash.update(JSON.stringify([packed.roles,packed.objectCount]))
const pick=preparePhysicalPickAcceleration(result.meshes)
let retainedPickIndexBytes=0
for(const index of[pick.meshes,...pick.triangles.map(t=>t.triangles)])for(const values of[index.bounds,index.children,index.ranges,index.order]){binary(values);retainedPickIndexBytes+=values.byteLength}
const cohorts=new Map<string,number>()
for(const mesh of meshes){let count=0;for(let at=0;at<mesh.vertices.length;at+=21){const v=mesh.vertices,ux=v[at+7]!-v[at]!,uy=v[at+8]!-v[at+1]!,uz=v[at+9]!-v[at+2]!,vx=v[at+14]!-v[at]!,vy=v[at+15]!-v[at+1]!,vz=v[at+16]!-v[at+2]!;if(uy*vz-uz*vy!==0||uz*vx-ux*vz!==0||ux*vy-uy*vx!==0)count++}if(count){const key=`${mesh.planPriority??'physical'}|${mesh.offset.join(',')}`;cohorts.set(key,(cohorts.get(key)??0)+count)}}
const atomicTemporaryIndexBytes=[...cohorts.values()].reduce((n,count)=>n+(count*2-1)*64+count*4,0)
const{broadPhaseCandidates:_work,...truth}=result.diagnostics;hash.update(JSON.stringify(truth))
const receipt={engine,design:data.design,sourceDigest:data.sourceDigest,compiler:data.compiler,inputMeshes:meshes.length,inputTriangles:meshes.reduce((n,m)=>n+m.vertices.length/21,0),ms,cpu,memoryBefore,memoryAfter,process:process.resourceUsage(),outputMeshes:result.meshes.length,packedBytes:packed.vertices.byteLength+packed.lines.byteLength,retainedPickIndexBytes,...(engine==='centroid'?{atomicTemporaryIndexBytes,temporaryIndexFormula:'Per nonempty ownership cohort: 2N−1 nodes ×64bytes(bounds/children/ranges) + N×4bytes primitive IDs; this ownership tree is not retained in the prepared output.'}:{}),diagnostics:{...result.diagnostics,coincidentPairs:result.diagnostics.coincidentPairs.length},fingerprint:hash.digest('hex'),limits:['One fresh Bun process and one engine call; compilation, mesh generation, render/pick fingerprint and memory census outside measured interval.','One explicit test-only GC before the measured call; not a production cache/GC policy.','Process memory snapshots/peak are not retained product GPU residency. No browser or network latency claim.']}
await Bun.write(output,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({engine,design:design,ms,fingerprint:receipt.fingerprint,candidates:receipt.diagnostics.broadPhaseCandidates}))
