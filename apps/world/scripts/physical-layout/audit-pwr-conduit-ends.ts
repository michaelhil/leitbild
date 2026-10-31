import {createHash} from 'node:crypto'
import {resolvePhysicalDesign,pwrConnectedUnitPhysicalDesignRef,pwrManifoldUnitPhysicalDesignRef} from '../../src/packs/physical-layout/design.ts'
import {pwrManifoldInstallations,pwrTurbinePhysicalFittings} from '../../src/packs/physical-layout/authoring/pwr-manifolds.ts'
import {compilePhysicalScene} from '../../src/packs/physical-layout/native/drafting/compile-scene.ts'
import {elementWorld,type V3} from '../../src/packs/physical-layout/native/drafting/source.ts'
import {preparePhysicalGeometry} from '../../src/ui/map/physical-scene/preparation.ts'
import {defaultPhysicalSceneView} from '../../src/ui/map/physical-scene/types.ts'

const before=await resolvePhysicalDesign(pwrConnectedUnitPhysicalDesignRef),after=await resolvePhysicalDesign(pwrManifoldUnitPhysicalDesignRef)
if(before.profile!=='drafting'||after.profile!=='drafting')throw Error('Conduit ledger needs exact drafting sources')
const source=after.source,network=source.routing!,elements=new Map(source.elements.map(e=>[e.id,e])),terminals=new Map(network.terminals.map(t=>[t.id,t])),pipes=source.elements.filter(e=>e.kind==='pipe'&&e.disposition==='installed'),headers=new Map(pwrManifoldInstallations.map(i=>[i.elementId,i]))
const world=(id:string)=>{const t=terminals.get(id)!,p=elementWorld(source,elements.get(t.elementId)!),c=Math.cos(p.yaw),s=Math.sin(p.yaw);return[p.position[0]+c*t.local[0]-s*t.local[1],p.position[1]+s*t.local[0]+c*t.local[1],p.position[2]+t.local[2]]as V3}
const sub=(a:readonly number[],b:readonly number[])=>a.map((v,i)=>v-b[i]!),distance=(a:readonly number[],b:readonly number[])=>Math.hypot(...sub(a,b))
const onSegment=(p:V3,a:V3,b:V3)=>{const d=sub(b,a),length=d.reduce((s,v)=>s+v*v,0),t=sub(p,a).reduce((s,v,i)=>s+v*d[i]!,0)/length;if(t<0||t>1)return false;const q=a.map((v,i)=>v+d[i]!*t),bound=32*Number.EPSILON*Math.max(1,...p.map(Math.abs),...a.map(Math.abs),...b.map(Math.abs));return distance(p,q)<=bound}
const ends:unknown[]=[]
for(const route of network.connections)for(const [end,id,p]of[['from',route.from,route.solution![0]!],['to',route.to,route.solution!.at(-1)!]]as const){const expected=world(id);if(distance(p,expected)!==0)throw Error(`Route/terminal seam: ${route.id}/${id}`);ends.push({conduitId:route.id,end,kind:'actual-graph-port',terminalId:id,subjectId:terminals.get(id)!.subjectId,port:terminals.get(id)!.port,point:p,contactError:0})}
for(const pipe of pipes)for(const [end,p]of[['first',pipe.path![0]!],['last',pipe.path!.at(-1)!]]as const){
 const header=headers.get(pipe.id)
 if(header){const capId=`${pipe.id}/blind-${end}`;if(!elements.get(capId)?.label.includes('closed, not a route continuation'))throw Error(`Missing explicit manifold end closure: ${pipe.id}/${end}`);ends.push({conduitId:pipe.id,end,kind:'intentional-closed-header-end',point:p,capId});continue}
 const fitting=pwrTurbinePhysicalFittings.find(f=>f.id===pipe.id)
 if(fitting&&end==='first'){ends.push({conduitId:pipe.id,end,kind:'physical-subassembly-interface',point:p,equipmentId:fitting.equipmentId,basis:fitting.kind==='msr-feed'?'existing-family-nozzle':'actual-LP-casing-ring',mountAxis:fitting.mountAxis,telemetry:'same lumped turbine; no independent flow or process-model port'});continue}
 const joined=pipes.filter(other=>other.id!==pipe.id&&other.path!.slice(1).some((b,i)=>onSegment(p,other.path![i]!,b))).map(other=>other.id)
 if(!joined.length)throw Error(`Unclassified free physical conduit end: ${pipe.id}/${end}`)
 ends.push({conduitId:pipe.id,end,kind:'physical-subassembly-interface',point:p,joined,telemetry:'same lumped turbine; no independent flow or process-model port'})
}
const aggregateAnchors=new Set(['equipment/vessel|hotLegC|hotLegD','equipment/sgC|steamOutlet|steamReliefOutlet','equipment/pressurizer|backupHeaterPower|blockValvePower|heaterPower'])
const terminalGroups=new Map<string,typeof network.terminals>()
for(const terminal of network.terminals){const key=terminal.elementId+JSON.stringify(terminal.local),group=terminalGroups.get(key)??[];group.push(terminal);terminalGroups.set(key,group)}
const coincident=[...terminalGroups.values()].filter(group=>group.length>1).map(group=>{
 const elementId=group[0]!.elementId,ports=group.map(t=>t.port).sort(),aggregate=aggregateAnchors.has([elementId,...ports].join('|'))
 return{elementId,ports,confidence:aggregate?'schematic-aggregate-body-anchor':'unresolved-contradictory-port-intent',qualification:aggregate?'Shared lumped equipment/body contact; separate physical branch/load nozzle installation is not authored.':'Distinct opposite-flow, medium, voltage or equipment-terminal meanings share an illustrative body anchor; actual separated hardware port placement remains unresolved. Exact graph endpoint identity is retained, not a claim that these are the same physical port.'}
})
const compile=(d:typeof after)=>compilePhysicalScene('ledger',{...d,owner:{objectId:'owner'},placement:{anchor:[0,0],bearing:0}})
const metrics=(d:typeof after)=>{const scene=compile(d),triangles=scene.objects.reduce((n,o)=>n+(o.indices?.length??o.positions.length/3)/3,0),lines=scene.objects.reduce((n,o)=>n+(o.featureLines??[]).reduce((n,l)=>n+l.positions.length/6,0),0)
 const prepared=Bun.argv.includes('--with-prepared')?preparePhysicalGeometry(scene,{...defaultPhysicalSceneView(scene.levels),mode:'3d',levelId:'all',hiddenLayerIds:[]},d.design.digest):null
 return{design:d.design,compiler:d.compiler,objects:scene.objects.length,sourceTriangles:triangles,authoredLineSegments:lines,...(prepared?{preparedMeshes:prepared.meshes.length,packedTriangleVertices:prepared.buffers.vertices.length/8,packedLineVertices:prepared.buffers.lines.length/6,packedVertexBytes:prepared.buffers.vertices.byteLength,packedLineBytes:prepared.buffers.lines.byteLength}:{}),selectedViewContinuations:{graphRoutes:scene.objects.filter(o=>o.clipToScope&&o.spatialPath).length,policy:'Inspection cuts derive marked continuation caps; they are not source hardware blind ends.'}}}
const receipt={sourceCoordinateFrame:'authoring X/Y/Z, metres; northAxis is applied only by retained delivery',sourceId:source.id,sourceDigest:after.sourceDigest,compiler:after.compiler,scope:'Complete unit pipe/conductor source-end ledger. Campus geometry is byte-retained; no new campus engineering qualification.',routes:network.connections.length,terminals:network.terminals.length,rawPipeBodies:pipes.length,conduits:network.connections.length+pipes.length,ends,manifoldInstallations:pwrManifoldInstallations,physicalTurbineFittings:pwrTurbinePhysicalFittings,remainingCoincidentEquipmentPorts:coincident,limitations:['Exact graph/contact qualification does not establish distinct equipment nozzle schedules or as-built plant routing. The listed non-manifold equipment port coincidences remain explicit authoring debt.','Routing obstacle constraints cover the authored equipment/column set; route-to-route separation, civil penetrations and maintenance qualification are not claimed.','Triangle/line/packed-byte deltas are geometry census only, not a performance benchmark.'],before:metrics(before),after:metrics(after)}
const output=Bun.argv.find(arg=>arg.startsWith('--output='))?.slice('--output='.length)
if(output)await Bun.write(output,JSON.stringify(receipt,null,2)+'\n')
console.log(JSON.stringify({sourceDigest:receipt.sourceDigest,ledgerEntries:ends.length,remainingCoincidentEquipmentPorts:coincident.length,before:receipt.before,after:receipt.after,sha256:createHash('sha256').update(JSON.stringify(receipt)).digest('hex')},null,2))
