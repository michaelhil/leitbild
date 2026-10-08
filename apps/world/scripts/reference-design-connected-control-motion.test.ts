import {expect,test} from 'bun:test'
import {auditAttainedControlMaterialGeometry,auditConnectedControlMotion,compileConnectedControlMotion,connectedControlMotionInput,controlMotionBulkGeometry,
 controlMotionReturnPaths,controlMotionSteelTemperature,controlMotionStemPassages} from './reference-design-connected-control-motion'
import {controlMotionNativeSourceIdentities} from './reference-design-connected-control-motion'
import type {Hydraulic,Water} from './reference-design-operating-network'

test('motion return compiler keeps exact existing serial segments rather than a mean K',()=>{
 const ids=['LOWER->CORE.1','CORE.1->CORE.2','CORE.2->UPPER','LOWER->GUIDE.EMPTY','GUIDE.EMPTY->UPPER',
  'LOWER->GUIDE.THIMBLE','GUIDE.THIMBLE->UPPER'],hydraulic:Hydraulic[]=ids.map((id,i)=>({id,from:i,to:i+1,
   from_elevation_m:i,to_elevation_m:i+1,basis:'physical fixture',segments:[{kind:i<3?3:4,length_m:i+1,
    area_m2:i+2,diameter_m:i+3,roughness_m:1e-6,fixedLoss:i,gridMultiplierOrAnnularDarcyCoefficient:2*i}]})),
  paths=controlMotionReturnPaths({hydraulic})
 expect(paths.map(p=>p.segments.length)).toEqual([3,2,2])
 expect(paths.flatMap(p=>p.segments)).toEqual(hydraulic.flatMap(p=>p.segments))
 paths[0]!.segments[0]!.fixedLoss=99
 expect(hydraulic[0]!.segments[0]!.fixedLoss).toBe(0)
 expect(()=>controlMotionReturnPaths({hydraulic:hydraulic.slice(1)})).toThrow('passage')
 expect(()=>controlMotionReturnPaths({hydraulic:[...hydraulic,hydraulic[0]!]})).toThrow('passage')
})

test('mixed finite return ownership preserves complete water volume and first moment',()=>{
 const names=['LOWER','UPPER','CORE.1','CORE.2','GUIDE.EMPTY','GUIDE.THIMBLE'],
  water:Water[]=names.map((id,i)=>({id,volume_m3:i<4?i+1:8,elevation_m:i<4?i-2:0,
   markerRatio:.002,temperature_K:300,owners:[id]})),
  guides=(['EMPTY','THIMBLE']as const).map(id=>({id,count:2,singleArea_m2:1,singleVolume_m3:4,
   bottom_m:-2,top_m:2,meanElevation_m:0})),b=controlMotionBulkGeometry({water},guides)
 expect(b.lower.volume_m3+b.upper.volume_m3).toBe(water.reduce((s,w)=>s+w.volume_m3,0))
 expect(b.lower.moment_m4+b.upper.moment_m4).toBe(water.reduce((s,w)=>s+w.volume_m3*w.elevation_m,0))
 expect(b.lower.parts).toEqual(['LOWER','CORE.1','GUIDE.EMPTY/lower','GUIDE.THIMBLE/lower'])
 expect(()=>controlMotionBulkGeometry({water:water.slice(1)},guides)).toThrow('water')
 expect(()=>controlMotionBulkGeometry({water},guides.map(g=>({...g,count:3})))).toThrow('coverage')
})

test('actual pressure housing and collars retain fixed disjoint axial supports',()=>{
 const c={headBottom_m:4,housingTop_m:8,neckTop_m:13.6,housingID_m:.25,neckID_m:.05,
  collarID_m:.0125,collarHeight_m:.1,collarBottoms_m:[8.05,8.35]},rows=controlMotionStemPassages(c)
 expect(rows.length).toBe(6)
 expect(rows.filter(r=>r.outer_radius_m===.00625).map(r=>r.top_m-r.bottom_m)).toEqual([.09999999999999964,.09999999999999964])
 expect(rows[0]).toEqual({bottom_m:4,top_m:8,outer_radius_m:.125})
 expect(rows.at(-1)!.top_m).toBe(13.6)
 for(let i=1;i<rows.length;i++)expect(rows[i]!.bottom_m).toBe(rows[i-1]!.top_m)
 expect(()=>controlMotionStemPassages({...c,collarBottoms_m:[7.9,8.35]})).toThrow('collar')
 expect(()=>controlMotionStemPassages({...c,collarBottoms_m:[8.05,8.10]})).toThrow('collar')
 expect(()=>controlMotionStemPassages({...c,collarHeight_m:NaN})).toThrow('collar')
})

test('finite steel heat uses the actual nonlinear caloric owner and unchanged original temperature',()=>{
 const law={density_kg_m3:7920,cpConstant_J_kg_K:469.4448,cpLinear_J_kg_K2:.13480848,
  datum_K:300,minimum_K:290,maximum_K:1600}
 for(const [original,target,mass]of [[300,301,20],[400,700,5],[900,800,4]]as const){
  const q=mass*(target-original)*(law.cpConstant_J_kg_K+law.cpLinear_J_kg_K2*(target+original)/2)
  expect(controlMotionSteelTemperature(law,original,mass,q)).toBeCloseTo(target,12)
 }
 expect(controlMotionSteelTemperature(law,300,20,0)).toBe(300)
 expect(()=>controlMotionSteelTemperature(law,300,0,2)).toThrow('recipient')
 expect(()=>controlMotionSteelTemperature(law,300,1,1e9)).toThrow('applicability')
 expect(()=>controlMotionSteelTemperature(law,NaN,1,2)).toThrow('recipient')
})

test('native source provenance is discovered, deterministic and includes build plus execution owners',async()=>{
 const rows=await controlMotionNativeSourceIdentities()
 expect(rows.map(q=>q.path)).toEqual(rows.map(q=>q.path).sort())
 expect(new Set(rows.map(q=>q.path)).size).toBe(rows.length)
 for(const path of ['Cargo.toml','Cargo.lock','build.rs','examples/control-motion.rs','src/absorber_fleet.rs','src/guide_motion_water.rs'])
  expect(rows.some(q=>q.path===path)).toBe(true)
 expect(rows.every(q=>/^[a-f0-9]{64}$/.test(q.sha256))).toBe(true)
 expect(await controlMotionNativeSourceIdentities()).toEqual(rows)
})

const wiki=process.env.LEITBILD_REFERENCE_WIKI,ownerTest=wiki?test:test.skip
ownerTest('actual consumed all-52 motion frame retains current finite physical owners',async()=>{
 const p=await compileConnectedControlMotion(wiki!,{burst_s:.5,hold_s:60,maximum_step_s:.1,relative:1e-6,
  position_m:1e-9,velocity_m_s:1e-9,heat_J:1e-7,water_energy_J:1e-7,marker_kg:1e-11})
 expect(p.count).toBe(52)
 expect(p.clusterIds.length).toBe(52)
 expect(new Set(p.clusterIds.map(c=>c.id)).size).toBe(52)
 expect(p.motion.joint_capacity_n).toBe(2000)
 expect(p.motion.body_mass_kg).toBeGreaterThan(30)
 expect(p.cluster.stem_volume_m3).toBeGreaterThan(Math.PI*p.cluster.stem_radius_m**2*(p.cluster.stem_top_m-p.cluster.stem_bottom_m))
 expect(p.returns.map(p=>p.id)).toEqual(['EXTERNAL.CORE','GUIDE.EMPTY','GUIDE.THIMBLE'])
 expect(p.stemPassages.length).toBe(6)
 expect(connectedControlMotionInput(p).trim().split(/\s+/).every(v=>Number.isFinite(Number(v)))).toBe(true)
 expect(p.initialSupport.initialEnergy_J).toBe(57.6e6)
 expect(p.duty.holding_w).toBe(20)
 expect(p.duty.controller_w).toBe(20)
 expect(p.anchor.elevation_m).toBe(2.5)
 expect(p.thermal.caloric.cpLinear_J_kg_K2).toBe(.13480848)
 expect(p.scope).toContain('No source/fuel evolution')
 expect(p.ownerIdentities.some(q=>q.name==='systems/reactor/fuel-transfer-grapple.md')).toBe(true)
 // Independent algebraic receipt fixture; not an asserted native trajectory.
 const g=p.cluster,A=g.rodlets*Math.PI*g.body_radius_m**2,
  ann=g.rodlets*Math.PI*(g.outer_radius_m**2-g.body_radius_m**2),rho=997,gravity=9.80665,
  shapes=(y:number)=>[
   {V:p.bulk.lower.volume_m3,J:p.bulk.lower.moment_m4},
   ...Array.from({length:p.count},()=>({V:ann*(g.top_m-g.bottom_m)+A*y,
    J:ann*(g.top_m**2-g.bottom_m**2)/2+A*(g.bottom_m*y+y*y/2)})),
   {V:p.bulk.upper.volume_m3-p.count*A*y,J:p.bulk.upper.moment_m4-p.count*(
    (g.body_volume_m3+g.spider_volume_m3+g.stem_volume_m3)*y+A*(g.bottom_m*y+y*y/2))},
  ],original=shapes(0),current=shapes(.001),mass=rho*original.reduce((s,q)=>s+q.V,0),
  originalExternal=[...original.map(q=>rho*gravity*q.J),...original.map(q=>p.anchor.markerRatio*rho*q.V)],
  currentExternal=[...current.map(q=>rho*gravity*q.J),...current.map(q=>p.anchor.markerRatio*rho*q.V)],
  total=(q:readonly number[])=>q.reduce((a,b)=>a+b,0),
  heat=Array.from({length:p.count},()=>[20,1,2]),
  supplied=p.count*((p.motion.body_mass_kg+p.motion.stem_mass_kg)*gravity*.001+23)
   +total(currentExternal.slice(0,p.count+2))-total(originalExternal.slice(0,p.count+2)),
  initial={time_s:0,motion:Array.from({length:p.count},()=>[0,0,0,0,0]),
   heat:Array.from({length:p.count},()=>[0,0,0]),external:originalExternal,
   support:[[p.initialSupport.initialEnergy_J,0,0,0],[p.initialSupport.initialEnergy_J,0,0,0]],
   exports_J:[0,0],mass_kg:mass,marker_kg:p.anchor.markerRatio*mass},
  final={...initial,time_s:p.accuracy.burst_s+p.accuracy.hold_s,motion:Array.from({length:p.count},()=>[.001,0,.001,0,.002]),heat,external:currentExternal,
   support:[[p.initialSupport.initialEnergy_J-supplied,0,supplied,0],[p.initialSupport.initialEnergy_J,0,0,0]]},
  result={status:'PASS',paired_maximum_ratio:.2,normal:{samples:[initial,final]},tighter:{samples:structuredClone([initial,final])}}
 const audit=auditConnectedControlMotion(p,result)
 expect(audit.status).toBe('PASS')
 expect(audit.arms[0]!.maximumSteelTemperature_K).toBeGreaterThan(300)
 expect(audit.arms[0]!.finalSteelTemperatures_K.length).toBe(52)
 expect(audit.sourceHistoryAdvanced).toBe(false)
 const materialAudit=await auditAttainedControlMaterialGeometry(wiki!,p,result)
 expect(materialAudit.clusters).toBe(52)
 expect(materialAudit.materialStocks).toBe(104)
 expect(new Set(materialAudit.materialStockIds).size).toBe(104)
 expect(materialAudit.arms.every(a=>a.maximumChangedIncidenceRows>0)).toBe(true)
 expect(materialAudit.scope).toContain('No neutron/source')
 const changedStart=structuredClone(result);changedStart.tighter.samples[0]!.external[0]!+=1
 expect(()=>auditConnectedControlMotion(p,changedStart)).toThrow('original finite stocks')
 const lostMarker=structuredClone(result);lostMarker.normal.samples[1]!.external[p.count+2]!+=.001
 expect(()=>auditConnectedControlMotion(p,lostMarker)).toThrow('retained stock/energy')
 const unpaidHeat=structuredClone(result);unpaidHeat.normal.samples[1]!.heat[0]![0]!+=1
 expect(()=>auditConnectedControlMotion(p,unpaidHeat)).toThrow('retained stock/energy')
 const lostMass=structuredClone(result);lostMass.normal.samples[1]!.mass_kg+=.01
 expect(()=>auditConnectedControlMotion(p,lostMass)).toThrow('retained stock/energy')
 const outside=structuredClone(result);outside.normal.samples[1]!.motion[0]![0]=-1
 expect(()=>auditConnectedControlMotion(p,outside)).toThrow('current geometry')
 const early=structuredClone(result);early.normal.samples[1]!.time_s-=1
 expect(()=>auditConnectedControlMotion(p,early)).toThrow('physical horizon')
},30000)
