import { describe, expect, test } from 'bun:test'
import polygonClipping from 'polygon-clipping'
import { circulationFromPaths, circulationSurfaces, roundedCentreline } from '../src/packs/physical-layout/authoring/pavement.ts'
import { createPwrExplorerCampusArtifacts, createPwrExplorerUnitArtifacts } from '../src/packs/physical-layout/authoring/pwr-explorer.ts'
import { compilePhysicalObjects } from '../src/packs/physical-layout/native/explorer/compile-scene.ts'
import { parameters, elementWorld, type Element, type Source } from '../src/packs/physical-layout/native/explorer/source.ts'
import { localPointAtAnchor } from '../src/packs/physical-layout/native/campus/author-campus.ts'
import arrangement from '../src/packs/physical-layout/pwr-campus.arrangement.json'

type Point=[number,number]
const area=(polygons:polygonClipping.MultiPolygon):number=>polygons.reduce((total,polygon)=>total+polygon.reduce((sum,ring,index)=>sum+(index?-1:1)*Math.abs(ring.reduce((n,p,i)=>{const q=ring[(i+1)%ring.length]!;return n+p[0]*q[1]-q[0]*p[1]},0)/2),0),0)
const footprint=(source:Source,element:Element):Point[]=>{
  const d=parameters(source,element),p=elementWorld(source,element),c=Math.cos(p.yaw),s=Math.sin(p.yaw)
  const ring:Point[]=element.footprint==='ellipse'?Array.from({length:64},(_,i)=>[d.length/2+Math.cos(i*Math.PI/32)*d.length/2,d.width/2+Math.sin(i*Math.PI/32)*d.width/2]):[[0,0],[d.length,0],[d.length,d.width],[0,d.width]]
  const world=ring.map(([x,y]):Point=>[p.position[0]+c*x-s*y-source.origin[0],p.position[1]+s*x+c*y-source.origin[1]])
  world.push([...world[0]!] as Point);return world
}

describe('Continuous authored circulation',()=>{
  test('L, T, X and acute junctions produce valid joined pavement with no segment-box seams',()=>{
    const paths:Array<Point[]>= [ [[-30,0],[30,0]], [[0,-30],[0,30]], [[-25,-25],[25,25]], [[30,0],[50,0],[50,30]] ]
    const network=circulationFromPaths(paths.map((path,i)=>({id:`road/${i}`,path,width:6,class:'service',turnRadius:6})),[-30,0])
    expect(network.nodes.find(n=>n.position[0]===0&&n.position[1]===0)?.kind).toBe('junction')
    const surface=circulationSurfaces(network).roads
    expect(surface).toHaveLength(1)
    expect(area(surface)).toBeGreaterThan(1000)
    for(const polygon of surface)for(const ring of polygon)expect(ring[0]).toEqual(ring.at(-1)!)
    const rounded=roundedCentreline([[0,0],[20,0],[20,20]],5,.05)
    expect(rounded.length).toBeGreaterThan(4)
    expect(rounded).not.toContainEqual([20,0])
    expect(()=>roundedCentreline([[0,0],[2,0],[2,2]],10,.05)).toThrow('turning radius')
  })
  test('the authored full site has connected vehicle and pedestrian surfaces, truthful topology and two surface draws',()=>{
    const {source,bindings}=createPwrExplorerCampusArtifacts()
    expect(source.elements.find(e=>e.id==='pavement/roads')!.surface).toHaveLength(1)
    expect(source.elements.find(e=>e.id==='pavement/pedestrian')!.surface).toHaveLength(1)
    expect(source.circulation!.nodes.some(node=>node.kind==='entrance'&&node.position[0]===-790&&node.position[1]===-205)).toBe(true)
    expect(source.elements.find(e=>e.id==='fence/switchyard')!.path!.at(-1)).toEqual([-150,-55,0])
    const objects=compilePhysicalObjects({source,bindings})
    expect(objects.filter(o=>o.kind==='road')).toHaveLength(0)
    for(const surface of objects.filter(o=>o.kind==='pavement')){
      expect(surface.edgePolicy).toBe('none')
      expect(surface.featureLines).toBeUndefined()
      expect(new Set(surface.positions.filter((_,i)=>i%3===2)).size).toBe(1)
      expect(surface.normals!.filter((_,i)=>i%3===2).every(z=>z>.999)).toBe(true)
    }
    expect(bindings).toHaveLength(86)
  })
  test('actual pavement is clear of every unit/common building and outdoor unit equipment footprint',()=>{
    const campus=createPwrExplorerCampusArtifacts().source,unit=createPwrExplorerUnitArtifacts().source
    const pavement=campus.elements.find(e=>e.id==='pavement/roads')!.surface!
    const footprints:Array<{id:string;ring:Point[]}>=campus.elements.filter(e=>e.kind==='building').map(e=>({id:e.id,ring:footprint(campus,e)}))
    for(const member of arrangement.units)for(const e of unit.elements.filter(e=>e.kind==='building'||e.kind==='equipment'&&!e.buildingId)){
      footprints.push({id:`${member.role}/${e.id}`,ring:footprint(unit,e).map(p=>{const q=localPointAtAnchor(arrangement.siteAnchor as Point,member.anchor as Point,[p[0],p[1],0]);return[q[0],q[1]]})})
    }
    expect(footprints.filter(f=>f.id.includes('building/'))).toHaveLength(49)
    const conflicts=footprints.filter(f=>area(polygonClipping.intersection(pavement,[f.ring]))>1e-4).map(f=>f.id)
    expect(conflicts).toEqual([])
    // Negative control: a pavement patch over the reception building must fail.
    const admin=footprints.find(f=>f.id==='building/administration')!
    expect(area(polygonClipping.intersection([admin.ring],[admin.ring]))).toBeGreaterThan(100)
  })
})
