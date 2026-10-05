import {expect,test} from 'bun:test'
import {fixture} from './reference-design-source.test-fixture'
import {compileSourcePartition,diskRectangleMeasure} from './reference-design-source-partition'
import {circleRectangleArcs,compileSourceFaces} from './reference-design-source-faces'
const gates={width_m:.6,stroke_m:.6,sills_m:[4,3.5] as [number,number],top_m:14}
test('clipped centroid and circle arc measures are true geometry, not outside box centres',()=>{
 const box={x0:.6,x1:1.2,y0:.6,y1:1.2},m=diskRectangleMeasure(1,box)
 expect(m.area_m2).toBeGreaterThan(0)
 const cx=m.momentX_m3/m.area_m2,cy=m.momentY_m3/m.area_m2
 expect(cx).toBeCloseTo(cy,11);expect(Math.hypot(cx,cy)).toBeLessThan(1)
 expect(Math.hypot(.9,.9)).toBeGreaterThan(1)
 const arcs=circleRectangleArcs(1,box),angle=arcs.reduce((sum,a)=>sum+a.hi-a.lo,0)
 expect(angle).toBeCloseTo(Math.acos(.6)-Math.asin(.6),12)
 expect(()=>circleRectangleArcs(-1,box)).toThrow()
})
test('shared/escape geometry closes all regions without default gate reflection',()=>{
 const p=compileSourcePartition(fixture),closed=compileSourceFaces(p,gates,[0,0]),open=compileSourceFaces(p,gates,[.6,.6]),half=compileSourceFaces(p,gates,[.3,.3])
 for(const q of [closed,open,half]){
  expect(q.gateArea_m2).toBeCloseTo(12.3,10);expect(q.maximumRegionSurfaceDefect_m2).toBeLessThan(1e-10)
  expect(q.faces.every(f=>f.area_m2>0&&f.leftDistance_m>0&&(!f.right||f.rightDistance_m!>0))).toBe(true)
 }
 expect(closed.gateCoveredArea_m2).toBeCloseTo(12.3,10);expect(open.gateCoveredArea_m2).toBe(0)
 expect(half.gateCoveredArea_m2).toBeCloseTo(6.15,10)
 expect(closed.faces.filter(f=>f.support?.kind==='transfer-gate').every(f=>f.right!==undefined)).toBe(true)
 const lower=closed.faces.filter(f=>f.left==='LOWER'&&f.right),upperHead=closed.faces.filter(f=>f.left==='UPPER'&&f.right?.startsWith('WELL/'))
 expect(lower.reduce((sum,f)=>sum+f.area_m2,0)).toBeCloseTo(Math.PI*1.9**2,10)
 expect(upperHead.reduce((sum,f)=>sum+f.area_m2,0)).toBeCloseTo(16.75,10)
 expect(new Set(lower.map(f=>f.leftDistance_m)).size).toBe(1)
 expect(new Set(upperHead.map(f=>f.leftDistance_m)).size).toBe(1)
 const wellEscape=closed.faces.filter(f=>f.left.startsWith('WELL/')&&!f.right&&f.axis==='z'&&f.plane_m===4)
 expect(wellEscape.reduce((sum,f)=>sum+f.area_m2,0)).toBeCloseTo(25-16.75,10)
 const radius=p.outerRadius_m,arcEscape=closed.faces.filter(f=>f.axis==='arc')
 expect(arcEscape.reduce((sum,f)=>sum+f.area_m2,0)).toBeCloseTo(2*Math.PI*radius*4,9)
 const panelGroups=new Map<string,number>()
 for(const f of closed.faces)if(f.support?.kind==='rack-panel')panelGroups.set(f.support.id,(panelGroups.get(f.support.id)??0)+f.area_m2)
 expect(panelGroups.size).toBe(196*4)
 for(const A of panelGroups.values())expect(A).toBeCloseTo((2*(.15-.0005)-fixture.handling.panelB10_kg_m2/(4*.199*.010012937/.055255)/2500)*4,10)
 // Below actual panel bottom is a true open passage on the same panel plane.
 const insideBottom=p.regions.find(r=>r.rackId==='RACK/0/0'&&r.part==='inside'&&r.z0_m===-.75)!
 expect(closed.faces.filter(f=>(f.left===insideBottom.id||f.right===insideBottom.id)&&f.axis!=='z'&&!f.support).length).toBe(4)
})
test('numerical refinement cannot change physical optical support, envelope or equipment half-distance',()=>{
 const a=compileSourceFaces(compileSourcePartition(fixture),gates,[.2,.4]),b=compileSourceFaces(compileSourcePartition({...fixture,partition:{coreBands:8}}),gates,[.2,.4])
 expect(b.gateArea_m2).toBeCloseTo(a.gateArea_m2,11);expect(b.panelArea_m2).toBeCloseTo(a.panelArea_m2,9)
 const total=(faces:typeof a.faces)=>faces.filter(f=>f.left==='LOWER'&&f.right).reduce((sum,f)=>sum+f.area_m2/f.leftDistance_m,0)
 expect(total(a.faces)).toBeCloseTo(total(b.faces),10)
})
test('invalid or implicit gate pose and malformed partitions fail visibly',()=>{
 const p=compileSourcePartition(fixture)
 expect(()=>compileSourceFaces(p,gates,[NaN,0])).toThrow()
 expect(()=>compileSourceFaces(p,gates,[.61,0])).toThrow()
 expect(()=>compileSourceFaces(p,{...gates,width_m:Infinity},[0,0])).toThrow()
 expect(()=>compileSourceFaces(p,{...gates,sills_m:[NaN,3.5]},[0,0])).toThrow()
 expect(()=>compileSourceFaces(p,gates,[] as unknown as [number,number])).toThrow()
 expect(()=>compileSourceFaces({...p,regions:p.regions.filter(r=>r.compartment!=='CANAL')},gates,[0,0])).toThrow()
 expect(()=>compileSourceFaces({...p,regions:[...p.regions,p.regions[0]!]},gates,[0,0])).toThrow()
})

test('curved literal cells satisfy independent boundary-vector and arc-distance identities',()=>{
 const p=compileSourcePartition(fixture),q=compileSourceFaces(p,gates,[0,0])
 const incident=new Map<string,Array<{face:typeof q.faces[number],sign:1|-1}>>()
 for(const face of q.faces){
  for(const [id,sign] of [[face.left,1],[face.right,-1]] as const){
   if(id===undefined)continue
   const entries=incident.get(id)??[];entries.push({face,sign});incident.set(id,entries)
  }
 }
 let curved=0
 for(const r of p.regions){
  if(!r.box)continue // Equipment-volume exceptions are deliberately not literal cylinders.
  const entries=incident.get(r.id)!,vector=[0,0,0],flat=[0,0,0]
  let arcArea=0,arcDistanceMoment=0
  for(const {face,sign} of entries){
   let physicalNormal=face.meanOutwardNormal.map(n=>sign*n)
   if(face.axis==='x'||face.axis==='y'||face.axis==='z'){
    const axis=face.axis==='x'?0:face.axis==='y'?1:2,
     low=axis===0?r.box.x0:axis===1?r.box.y0:r.z0_m!,
     high=axis===0?r.box.x1:axis===1?r.box.y1:r.z1_m!
    expect(face.plane_m===low||face.plane_m===high).toBe(true)
    const outward=face.plane_m===low?-1:1
    physicalNormal=[0,0,0];physicalNormal[axis]=outward
    // Multiplying a right-side zero component by -1 produces IEEE -0;
    // geometric vector equality is component difference zero, not Object.is.
    for(let k=0;k<3;k++)expect(Math.abs(sign*face.meanOutwardNormal[k]!-physicalNormal[k]!)).toBe(0)
   }else{
    expect(face.axis).toBe('arc')
    expect(Math.hypot(...face.meanOutwardNormal)).toBeLessThanOrEqual(1+64*Number.EPSILON)
   }
   for(let k=0;k<3;k++){
    const contribution=face.area_m2*physicalNormal[k]!
    vector[k]=vector[k]!+contribution
    if(face.axis!=='arc')flat[k]=flat[k]!+contribution
   }
   if(face.axis==='arc'){
    expect(sign).toBe(1);expect(face.right).toBeUndefined()
    arcArea+=face.area_m2;arcDistanceMoment+=face.area_m2*face.leftDistance_m
   }
  }
  expect(Math.hypot(...vector)).toBeLessThan(1e-10)
  if(arcArea===0)continue
  curved++
  const R=r.diskRadius_m!,m=diskRectangleMeasure(R,r.box),cx=m.momentX_m3/m.area_m2,cy=m.momentY_m3/m.area_m2
  expect(Math.hypot(cx,cy)).toBeLessThan(R)
  expect(Math.abs(flat[2]!)).toBeLessThan(1e-11)
  // Green's identity: the integral of the curved outward normal is minus
  // the flat-face vector. This comparator does not reuse the arc interval code.
  const expected=R*arcArea+cx*flat[0]!+cy*flat[1]!
  expect(Math.abs(arcDistanceMoment-expected)).toBeLessThan(1e-10)
 }
 expect(curved).toBeGreaterThan(100)
})

test('equipment distances and directional optical patches retain actual datum and coverage',()=>{
 const p=compileSourcePartition(fixture),q=compileSourceFaces(p,gates,[.15,.45]),
  Acore=Math.PI*fixture.barrel.innerRadius_m**2,
  lowerHalf=fixture.initialization.volumes_m3[1]!/(2*Acore),
  upperCoreHalf=fixture.initialization.volumes_m3[4]!/(2*Acore),
  upperHeadHalf=fixture.initialization.volumes_m3[4]!/(2*fixture.control.headGrossArea_m2)
 for(const face of q.faces){
  if(face.left==='LOWER')expect(face.leftDistance_m).toBeCloseTo(lowerHalf,12)
  if(face.right==='UPPER')expect(face.rightDistance_m).toBeCloseTo(upperCoreHalf,12)
  if(face.left==='UPPER')expect(face.leftDistance_m).toBeCloseTo(upperHeadHalf,12)
 }
 expect(q.faces.filter(f=>f.left==='UPPER'&&!f.right)).toHaveLength(0)
 for(const [id,travel,sill] of [['GATE.WELL',.15,4],['GATE.POOL',.45,3.5]] as const){
  const covered=q.faces.filter(f=>f.support?.id===id).reduce((sum,f)=>sum+f.area_m2,0)
  expect(covered).toBeCloseTo((gates.width_m-travel)*(gates.top_m-sill),11)
 }
 const bottom=p.regions.find(r=>r.rackId==='RACK/0/0'&&r.part==='inside'&&r.z0_m===fixture.handling.poolFloor_m)!,
  panelWidth=bottom.box!.x1-bottom.box!.x0,
  expectedOpen=panelWidth*(p.panelSupport_m.bottom-bottom.z0_m!)
 for(const direction of ['west','east','south','north']){
  const outside=p.regions.find(r=>r.rackId===bottom.rackId&&r.part===direction&&r.z0_m===bottom.z0_m)!,
   faces=q.faces.filter(f=>f.left===bottom.id&&f.right===outside.id||f.left===outside.id&&f.right===bottom.id),
   covered=faces.filter(f=>f.support!==undefined),open=faces.filter(f=>f.support===undefined)
  expect(covered).toHaveLength(1);expect(covered[0]!.support!.id).toBe(`RACK/0/0/${direction}`)
  expect(open).toHaveLength(1);expect(open[0]!.area_m2).toBeCloseTo(expectedOpen,12)
  expect(covered[0]!.area_m2).toBeCloseTo(panelWidth*(bottom.z1_m!-p.panelSupport_m.bottom),12)
 }
})
