import {describe,expect,test} from 'bun:test'
import {compileSourcePartition,diskRectangleArea,parseSourcePartition} from './reference-design-source-partition'
import {fuelAssemblyPositions} from './reference-design-fuel-handling'

// Test-only engineering fixture. Real compilation consumes the wiki owners.
const fixture:Parameters<typeof compileSourcePartition>[0]={
 fuel:{design:'LD-01-fresh-fuel-reference',assemblies:193,latticeSide:17,rodsPerAssembly:264,guidesPerAssembly:25,pitch_m:.0126,
  rodOuterDiameter_m:.0095,cladThickness_m:.00057,pelletDiameter_m:.0082,guideOuterDiameter_m:.0122,activeLength_m:4,
  plenumLength_m:.25,fillPressure_Pa:2e6,referenceTemperature_K:300,fuelDensityFraction:.95,fuelTheoreticalDensity_kg_m3:10960,
  cladDensity_kg_m3:6551,power_W:3e9,coolantPressures_MPa:[15.2,15.1,15],coolantTemperatures_K:[563.15,578.15,593.15]},
 handling:{slotRadiusSquared:61,supportRadius_m:1.85,bottomFittingLength_m:.25,bottomFitting_kg:10,topFittingLength_m:.15,
  topFitting_kg:10,guideInnerDiameter_m:.011,seatedBottom_m:-2.25,transferBottom_m:4.25,surface_m:14,minimumActiveCover_m:5,
  sourceThimbleDiameter_m:.006,sourceThimbleBottom_m:-3.5,sourceThimbleTop_m:2.5,sourceCapsule_m:-1,wellArea_m2:25,wellFloor_m:4,
  canalWidth_m:1,canalLength_m:6,canalFloor_m:3.5,poolSide_m:10,poolFloor_m:-.75,rackSide:14,rackPitch_m:.5,rackSleeveSide_m:.3,
  rackSkin_m:.0005,panelB10_kg_m2:.2,b4cDensity_kg_m3:2500,b10AtomFraction:.199,b10MolarMass_kg_mol:.010012937,
  b4cMolarMass_kg_mol:.055255,hoistForce_N:10000,hoistPower_W:5000,motionSpeed_m_s:.05,gravity_m_s2:9.80665},
 control:{clusters:52,rodletsPerCluster:24,bodyDiameter_m:.009,absorberDiameter_m:.0065,activeLength_m:4,bodyLength_m:4.3,
  insertedBodyBottom_m:-2.1,insertedActiveBottom_m:-2,normalTravel_m:4,parkTravel_m:4.5,spiderMass_kg:20,spiderBottom_m:2.2,
  spiderHeight_m:.1,spiderRadius_m:.1,stemDiameter_m:.04,stemLength_m:6,steelDensity_kg_m3:7920,b4cDensity_kg_m3:2500,
  headBottom_m:4,headThickness_m:.15,headGrossArea_m2:16.75,housingID_m:.06,housingOD_m:.08,housingTop_m:10,
  housingCapHeight_m:.02,neckID_m:.06,neckOD_m:.08,neckTop_m:11,neckCapHeight_m:.02,collarID_m:.04,collarOD_m:.06,
  collarHeight_m:.02,collarBottoms_m:[6,7],guideRoughness_m:.000001,endLossEach:1,ordinarySpeedLimit_m_s:.01,
  driveEfficiency:.8,deliveredMotiveLimit_W:1000,forceLimitPerCluster_N:10000,attachedJackMassPerCluster_kg:100,
  jackID_m:.08,jackOD_m:.1,jackBottom_m:7,gapStroke_m:.01,gapArmature_kg:10,gapSpring_N_m:1000,gapDamping_N_s_m:10,
  manualGapSpeed_m_s:.01,manualGapForce_N:100,manualGapPower_W:100,gravity_m_s2:9.80665},
 primary:{design:'LD-01',hotInsideDiameter_m:1,pumpPassageInsideDiameter_m:.7,pumpPassageVolume_m3:8,coldHeaderVolume_m3:4,
  coldHeaderHeight_m:1,coldReturnLength_m:.5,sgDevelopedLength_m:20,downcomerBottom_m:-3,downcomerTop_m:3},
 barrel:{innerRadius_m:1.9,outerRadius_m:2},
 initialization:{design:'LD-01',volumes_m3:[20,28.5,10,10,33.5,15,15,24,24,20,20],metalCapacity_MJ_K:1,motorTracking_s:1,
  inertiaDecay_s:1,hold_s:1,holdStep_s:1,perturbation_s:1,steps_s:[1,.5,.25],sourcePulseFraction:.001,sourcePulse_s:.5},
 partition:{coreBands:4},
}
describe('fixed source geometry compilation',()=>{
 test('analytic disk intersections conserve area across arbitrary Cartesian cuts',()=>{
  for(const radius of [.2,1,2.2496739661439764]){
   const cuts=[-3,-.95,-.17,0,.41,1.11,3],areas=[]
   for(let y=1;y<cuts.length;y++)for(let x=1;x<cuts.length;x++){
    const box={x0:cuts[x-1]!,x1:cuts[x]!,y0:cuts[y-1]!,y1:cuts[y]!},a=diskRectangleArea(radius,box)
    expect(a).toBeGreaterThanOrEqual(0);expect(a).toBeLessThanOrEqual((box.x1-box.x0)*(box.y1-box.y0)+1e-12)
    expect(a).toBeCloseTo(diskRectangleArea(radius,{x0:box.y0,x1:box.y1,y0:box.x0,y1:box.x1}),11);areas.push(a)
   }
   expect(areas.reduce((sum,a)=>sum+a,0)).toBeCloseTo(Math.PI*radius**2,11)
  }
  expect(diskRectangleArea(1,{x0:1,x1:2,y0:-1,y1:1})).toBe(0)
  expect(diskRectangleArea(1,{x0:0,x1:1,y0:0,y1:1})).toBeCloseTo(Math.PI/4,13)
  expect(()=>diskRectangleArea(-1,{x0:0,x1:1,y0:0,y1:1})).toThrow()
 })
 test('actual generation closes all gross regions and preserves identities',()=>{
  const r=compileSourcePartition(fixture)
  expect(r.counts).toEqual({ACTIVE:1508,LOWER:1,UPPER:1,WELL:300,CANAL:48,POOL:3168})
  expect(r.regionCount).toBe(5026);expect(r.neutronCoordinates).toBe(35182)
  expect(r.assemblies).toHaveLength(193);expect(r.racks).toHaveLength(196)
  expect(r.assemblies).toEqual(fuelAssemblyPositions(fixture.handling,fixture.fuel))
  expect(r.headArea_m2).toBeCloseTo(16.75,11)
  expect(r.representedDownVolume_m3).toBeCloseTo(40/3,12)
  expect(r.uncreditedDownEndVolume_m3).toBeCloseTo(20/3,12)
  for(const v of r.volumes)expect(v.compiled_m3).toBeCloseTo(v.expected_m3,8)
  for(const rack of r.racks){const pieces=r.regions.filter(q=>q.rackId===rack.id)
   expect(pieces.filter(q=>q.part!=='whole')).toHaveLength(10)
   expect(new Set(pieces.map(q=>q.envelopeLength_m)).size).toBe(1)
   expect(pieces.reduce((sum,q)=>sum+q.volume_m3,0)).toBeCloseTo(.25*14.75,11)
  }
 })
 test('source numerical refinement changes no equipment or compartment stock',()=>{
  const a=compileSourcePartition(fixture),b=compileSourcePartition({...fixture,partition:{coreBands:8}})
  expect(b.counts.ACTIVE).toBe(2*a.counts.ACTIVE!);expect(b.assemblies).toEqual(a.assemblies);expect(b.racks).toEqual(a.racks)
  for(let i=0;i<a.volumes.length;i++)expect(b.volumes[i]!.compiled_m3).toBeCloseTo(a.volumes[i]!.compiled_m3,9)
  expect(b.regions[0]!.envelopeLength_m).toBe(a.regions[0]!.envelopeLength_m)
 })
 test('invalid supports and ambiguous partition records fail visibly',()=>{
  const doc='```reference-source-partition\n{"coreBands":4}\n```\n'
  expect(parseSourcePartition(doc)).toEqual({coreBands:4});expect(()=>parseSourcePartition(doc+doc)).toThrow()
  expect(()=>parseSourcePartition(doc.replace('"coreBands":4','"coreBands":4,"shape":[]'))).toThrow()
  expect(()=>parseSourcePartition(doc.replace('"coreBands":4','"coreBands":0'))).toThrow()
  expect(()=>compileSourcePartition({...fixture,handling:{...fixture.handling,rackPitch_m:.6}})).toThrow()
  expect(()=>compileSourcePartition({...fixture,control:{...fixture.control,headGrossArea_m2:30}})).toThrow()
  expect(()=>compileSourcePartition({...fixture,primary:{...fixture.primary,downcomerTop_m:1}})).toThrow()
  expect(()=>fuelAssemblyPositions(fixture.handling,{...fixture.fuel,assemblies:194})).toThrow()
 })
})
