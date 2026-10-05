import {describe,expect,test} from 'bun:test'
import {compileSourcePartition} from './reference-design-source-partition'
import {compileColdSourceMaterial,parseOperatingFuelCohorts,radialCohorts} from './reference-design-source-material'
import {fuelGeometry} from './reference-design-fuel-construction'
import {fuelHandlingChecks} from './reference-design-fuel-handling'
import {fixture} from './reference-design-source.test-fixture'
import type {parseNuclearObservation} from './reference-design-nuclear-observation'

// Test-only exact apparatus selection. The CLI consumes the actual wiki owner.
const apparatus:ReturnType<typeof parseNuclearObservation>={wall_m:.0005,endcap_m:.0005,diaphragm_m:.0002,
 diaphragmCentres_m:[-1.025,-.975,.948,1.052],carrierCentre_m:1,carrierLength_m:.1,carrierOD_m:.004,carrierWall_m:.0002,
 b10Areal_kg_m2:.1,ringWidth_m:.001,capsuleOD_m:.003,capsuleLength_m:.005,capsuleWall_m:.0002,barAngle_rad:1,
 barWidth_m:.0005,leadOD_m:.0001,leadRadius_m:.002325,leadAngles_rad:[Math.PI/3,Math.PI],sleeveOD_m:.0003,
 bareContactLength_m:.0001,glassDensity_kg_m3:2500,glassCp_J_kg_K:500,glassK_W_m_K:1,emitterDensity_kg_m3:15000,
 emitterCp_J_kg_K:100,emission_neutrons_s_g:2.314e12,capsuleDecayUpper_W:.1,terminal_kg:.001,terminalToRoom_W_K:1,
 heliumOriginal_Pa:200000,original_K:300,heliumMolarMass_kg_mol:.004002602,R_J_mol_K:8.31446261815324,
 contactFactors:[.5,1,2],responseRange_K:[290,900]}
const input={fuel:fixture.fuel,handling:fixture.handling,grid:{axialBands:4,fuelIntervals:8,cladIntervals:2},
 apparatus,source:{birthEmission_neutrons_s:4e9}}
const sum=(xs:number[])=>xs.reduce((a,b)=>a+b,0)
const compile=(bands=4)=>compileColdSourceMaterial(compileSourcePartition({...fixture,partition:{coreBands:bands}}),input)

describe('cold original source/material/thermal incidence',()=>{
 test('whole actual construction, finite shells and original energy owners close',()=>{
  const r=compile(),g=fuelGeometry(fixture.fuel),h=fuelHandlingChecks(fixture.handling,fixture.fuel)
  expect(r.totals.assemblies).toBe(193);expect(r.segments).toHaveLength(386);expect(r.cohorts).toHaveLength(9264)
  expect(r.cohorts.filter(q=>q.material==='fuel')).toHaveLength(6948)
  expect(r.cohorts.filter(q=>q.material==='clad')).toHaveLength(2316)
  expect(new Set(r.cohorts.map(q=>q.id)).size).toBe(r.cohorts.length)
  expect(r.totals.fuelMass_kg).toBeCloseTo(g.fuelMass_kg,6);expect(r.totals.activeCladMass_kg).toBeCloseTo(g.cladMass_kg,6)
  expect(r.cohorts.every(q=>q.referenceMass_kg>0&&q.original_K===300&&q.originalSensibleEnergy_J===0)).toBe(true)
  const first=r.cohorts.filter(q=>q.faId===r.segments[0]!.faId&&q.band===0&&q.material==='fuel')
  expect(first[0]!.radius_m).toBe(0);expect(first[8]!.radius_m).toBe(fixture.fuel.pelletDiameter_m/2)
  expect(first[0]!.referenceMass_kg/sum(first.map(q=>q.referenceMass_kg))).toBeCloseTo(1/256,14)
  expect(first[8]!.referenceMass_kg).toBeGreaterThan(0)
  const physical=r.materialIncidence.filter(q=>!['guide-bore-support','external-water-support'].includes(q.kind))
  expect(sum(physical.map(q=>q.volume_m3))).toBeCloseTo(193*h.assembly.fullDisplacement_m3,9)
  expect(sum(r.materialIncidence.filter(q=>q.kind==='guide-metal').map(q=>q.referenceMass_kg!))).toBeCloseTo(193*h.assembly.guide_kg,7)
  for(const kind of ['bottom-fitting','top-fitting','plenum-clad','plenum-sealed-space-support'] as const)
   expect(r.materialIncidence.filter(q=>q.kind===kind)).toHaveLength(193)
  expect(r.materialIncidence.filter(q=>q.kind==='guide-bore-support').every(q=>q.referenceMass_kg===undefined)).toBe(true)
 })
 test('one helium owner includes complete gap and plenum, not four copied fills',()=>{
  const r=compile(),f=fixture.fuel,ri=f.rodOuterDiameter_m/2-f.cladThickness_m,rf=f.pelletDiameter_m/2,
   gap=f.rodsPerAssembly*Math.PI*(ri**2-rf**2)*f.activeLength_m,plenum=f.rodsPerAssembly*Math.PI*ri**2*f.plenumLength_m
  expect(r.helium).toHaveLength(193);expect(new Set(r.helium.map(q=>q.faId)).size).toBe(193)
  for(const gas of r.helium){expect(gas.volume_m3).toBeCloseTo(gap+plenum,15)
   expect(gas.originalInternalEnergy_J).toBeCloseTo(1.5*f.fillPressure_Pa*(gap+plenum),9)
   expect(gas.nR_J_K*gas.original_K/gas.volume_m3).toBeCloseTo(f.fillPressure_Pa,8)}
  expect(r.materialIncidence.filter(q=>q.kind==='plenum-sealed-space-support').every(q=>q.stockId===q.faId+'/helium')).toBe(true)
 })
 test('prompt W/eta and delayed mu are distinct conservative heat transactions under nonmatching source refinement',()=>{
  const a=compile(2),b=compile(8)
  expect(a.cohorts).toEqual(b.cohorts);expect(a.segments).toEqual(b.segments);expect(a.helium).toEqual(b.helium)
  expect(b.heatIncidence.length).toBeGreaterThan(a.heatIncidence.length)
  const deposit=(r:typeof a)=>{
   const amount=new Map<string,number>(),intersection=new Map(r.fissionIncidence.map(e=>[e.segmentId+'|'+e.sourceRegionId,e])),segmentTotals=new Map<string,number>()
   // Analytic test-only uniform producing density: each retained segment owns
   //13 events/s and5 W delayed release. This is not a simulated source field.
   for(const e of r.heatIncidence){const F=13*intersection.get(e.segmentId+'|'+e.sourceRegionId)!.delayedBirthShare,
    q=17*F*e.eta
    amount.set(e.cohortId,(amount.get(e.cohortId)??0)+q);segmentTotals.set(e.segmentId,(segmentTotals.get(e.segmentId)??0)+q)
    expect('mu' in e).toBe(false)
   }
   for(const q of r.cohorts.filter(q=>q.material==='fuel')){
    amount.set(q.id,(amount.get(q.id)??0)+5*q.mu!);segmentTotals.set(q.segmentId,(segmentTotals.get(q.segmentId)??0)+5*q.mu!)
   }
   for(const s of r.segments){expect(segmentTotals.get(s.id)!).toBeCloseTo(17*13+5,10)
    expect(sum(r.cohorts.filter(q=>q.material==='fuel'&&q.segmentId===s.id).map(q=>q.mu!))).toBeCloseTo(1,13)}
   return amount
  }
  const Qa=deposit(a),Qb=deposit(b)
  for(const [id,q] of Qa)expect(Qb.get(id)!).toBeCloseTo(q,11)
 })
 test('converter uses the original carrier surface, real off-centre axial cut and exact half-circle patches',()=>{
  const p=compileSourcePartition(fixture),base=compileColdSourceMaterial(p,input),radius=apparatus.carrierOD_m/2
  expect(base.converter.radius_m).toBe(.002);expect(base.converter.filmOuterRadius_m).toBeGreaterThan(radius)
  expect(base.converter.opticalArea_m2).toBeCloseTo(2*Math.PI*radius*.1,16)
  expect(base.converter.b10Mass_kg).toBeCloseTo(2*Math.PI*radius*.1*apparatus.b10Areal_kg_m2,15)
  expect(base.converter.incidence).toHaveLength(2)
  const shifted={...p,regions:p.regions.map(r=>r.compartment==='ACTIVE'?{...r,
   z0_m:r.z0_m===1?1.02:r.z0_m,z1_m:r.z1_m===1?1.02:r.z1_m,
   volume_m3:r.volume_m3*((r.z1_m===1?1.02:r.z1_m!)-(r.z0_m===1?1.02:r.z0_m!))/(r.z1_m!-r.z0_m!)}:r)},
   moved=compileColdSourceMaterial(shifted,input)
  expect(moved.converter.incidence).toHaveLength(2)
  const areas=moved.converter.incidence.map(q=>q.area_m2).sort((a,b)=>a-b)
  expect(areas[0]!).toBeCloseTo(2*Math.PI*radius*.03,15);expect(areas[1]!).toBeCloseTo(2*Math.PI*radius*.07,15)
  const central=p.regions.filter(r=>r.compartment==='ACTIVE'&&r.box!.x0<0&&r.box!.x1>0&&r.box!.y0<0&&r.box!.y1>0),
   ids=new Set(central.map(r=>r.id)),split={...p,regions:p.regions.filter(r=>!ids.has(r.id)).concat(central.flatMap(r=>[
    {...r,id:r.id+'/west',box:{...r.box!,x1:0},volume_m3:r.volume_m3/2},
    {...r,id:r.id+'/east',box:{...r.box!,x0:0},volume_m3:r.volume_m3/2}]))},
   half=compileColdSourceMaterial(split,input)
  expect(half.converter.incidence).toHaveLength(4)
  for(const q of half.converter.incidence)expect(q.area_m2).toBeCloseTo(Math.PI*radius*.05,15)
  expect(half.totals.fuelMass_kg).toBeCloseTo(base.totals.fuelMass_kg,7)
 })
 test('missing coverage, duplicate identity and an incompatible original fail instead of normalization',()=>{
  const p=compileSourcePartition(fixture),target=p.regions.find(r=>r.id==='ACTIVE/0/0/0')!
  expect(()=>compileColdSourceMaterial({...p,regions:p.regions.filter(r=>r!==target)},input)).toThrow('Incomplete/duplicated')
  expect(()=>compileColdSourceMaterial({...p,regions:[...p.regions,target]},input)).toThrow('identities')
  expect(()=>compileColdSourceMaterial({...p,assemblies:[...p.assemblies].reverse()},input)).toThrow('identities')
  expect(()=>compileColdSourceMaterial(p,{...input,fuel:{...input.fuel,referenceTemperature_K:600 as 300}})).toThrow('300K')
  expect(()=>compileColdSourceMaterial(p,{...input,apparatus:{...apparatus,original_K:600 as 300}})).toThrow('300K')
  expect(()=>compileColdSourceMaterial(p,{...input,handling:{...input.handling,bottomFitting_kg:-10}})).toThrow('material support')
  expect(()=>compileColdSourceMaterial(p,{...input,grid:{...input.grid,axialBands:3}})).toThrow()
  const doc='```reference-operating-fuel-cohorts\n{"axialBands":4,"fuelIntervals":8,"cladIntervals":2}\n```\n'
  expect(parseOperatingFuelCohorts(doc)).toEqual(input.grid);expect(()=>parseOperatingFuelCohorts(doc+doc)).toThrow()
  expect(()=>parseOperatingFuelCohorts(doc.replace('"cladIntervals":2','"cladIntervals":0'))).toThrow()
  expect(()=>parseOperatingFuelCohorts(doc.replace('"cladIntervals":2','"cladIntervals":2,"unknown":0'))).toThrow()
  expect(()=>radialCohorts(0,0,8)).toThrow();expect(()=>radialCohorts(0,1,1.5)).toThrow()
 })
})
