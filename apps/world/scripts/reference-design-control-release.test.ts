import {expect,test} from 'bun:test'
import {controlReleasePhysicalInput,parseColdControlRelease} from './reference-design-control-release'

const selected={configuration:'offline-paid-lift-physical-release',lift_m:.25,
 neckInertance:'plug-displacement-fixed-initial-UPPER-density',maximumInertanceDensityRelativeDeparture:.01,
 neckAreaChangeLoss:'geometric-small-area-sudden-change',
 impact:'fully-inelastic-no-grip-impulse',movingImpactHeatFraction:.5,
 receiverThermal:'adiabatic-impact-increment-only',localPressureAdmission:'serial-absolute-above-current-saturation'} as const
const document=(body:unknown=selected)=>'```reference-cold-control-release\n'+JSON.stringify(body)+'\n```\n'

/** Small compiler-only fixture: actual selected dimensions and52 distinct
 * synthetic FA identities. No liquid/property/SOURCE trajectory is simulated. */
function fixture(){
 const c={clusters:52 as const,gapArmature_kg:1,gapStroke_m:.01,gapSpring_N_m:20000,gapDamping_N_s_m:20,
  attachedJackMassPerCluster_kg:20,collarBottoms_m:[8.05,8.35],collarHeight_m:.1,
  collarID_m:.0125,collarOD_m:.025,steelDensity_kg_m3:7920,headBottom_m:4,housingTop_m:8,neckTop_m:13.6,
  housingID_m:.25,neckID_m:.05,stemDiameter_m:.012,spiderBottom_m:2.4,spiderHeight_m:.1,stemLength_m:6},
  clusterFA=Array.from({length:52},(_,i)=>'TEST.FA.'+i),
  plan={d:{control:c,attachment:{shoulderBottom_m:8.49,stubLength_m:.055,shoulderDiameter_m:.02},handling:{topFitting_kg:10},fuel:{cladDensity_kg_m3:6500}},
   motion:{clusters:clusterFA.map((_,i)=>({id:'TEST.CR.'+i}))},clusterFA,water:[{id:'LOWER'},{id:'UPPER'}],upper:1,maximumStemPose_m:1.54},
  collarVolume=52*2*Math.PI*(c.collarOD_m**2-c.collarID_m**2)*c.collarHeight_m/4,
  stocks:Parameters<typeof controlReleasePhysicalInput>[1]['material']['materialPayload']['passive']['stocks']=[
   {id:'HEAD.COLLARS',material:'steel304',volume_m3:collarVolume,mass_kg:collarVolume*c.steelDensity_kg_m3,
    original_K:300,targets:['Fe','Cr','Ni','Mn'].map(e=>({id:'HEAD.COLLARS/'+e}))},
   {id:'HEAD.JACKS',material:'steel304',volume_m3:52*20/c.steelDensity_kg_m3,mass_kg:52*20,
    original_K:300,targets:['Fe','Cr','Ni','Mn'].map(e=>({id:'HEAD.JACKS/'+e}))},
   ...clusterFA.map(id=>({id:id+'/top-fitting',material:'Zr' as const,volume_m3:10/6500,mass_kg:10,original_K:300,
    targets:[{id:id+'/top-fitting/Zr'}]}))],
  source={material:{materialPayload:{passive:{stocks}},nativeInputs:{targets:stocks.flatMap(s=>s.targets).reverse()}}}
 return {plan,source}
}

test('new release selection is strict and leaves ordinary control selection outside this helper',()=>{
 expect(parseColdControlRelease(document())).toEqual(selected)
 for(const body of [{...selected,lift_m:.004},{...selected,movingImpactHeatFraction:1},
  {...selected,neckInertance:'silent-extra-metal-mass'},{...selected,configuration:'ordinary-MANUAL'},
  {...selected,maximumInertanceDensityRelativeDeparture:1},{...selected,dragCoefficient:1.2}])
  expect(()=>parseColdControlRelease(document(body))).toThrow()
 expect(()=>parseColdControlRelease(document()+document())).toThrow()
 expect(()=>parseColdControlRelease('')).toThrow()
})

test('one finite receiver slice per actual contact, no extra material or thermal capacity',()=>{
 const {plan,source}=fixture(),before=JSON.stringify({plan,source}),p=controlReleasePhysicalInput(plan,source,selected)
 expect(p.clusters).toHaveLength(52)
 expect(new Set(p.clusters.map(q=>q.topFitting.stock)).size).toBe(52)
 expect(new Set(p.clusters.map(q=>q.upperCollar.stock)).size).toBe(1)
 expect(new Set(p.clusters.map(q=>q.upperCollar.id)).size).toBe(52)
 expect(p.clusters.reduce((s,q)=>s+q.topFitting.mass_kg,0)).toBe(520)
 expect(p.clusters.reduce((s,q)=>s+q.upperCollar.sliceMass_kg,0)).toBeCloseTo(p.clusters[0]!.upperCollar.mass_kg/2,12)
 expect(p.clusters[0]!.upperCollar.sliceMass_kg).toBeCloseTo(.29157906816130275,14)
 expect(p.clusters[0]!.upperCollar.stockFraction).toBe(1/104)
 expect(p.armature).toEqual({mass_kg:1,stroke_m:.01,spring_n_m:20000,damping_n_s_m:20})
 expect(p.minimumStemPose_m).toBe(plan.d.control.collarBottoms_m[1]!+plan.d.control.collarHeight_m-plan.d.attachment.shoulderBottom_m)
 expect(p.minimumStemPose_m).toBeCloseTo(-.04,13)
 expect(p.inertanceDensityOwner).toBe('initial-admitted-native-UPPER-chart')
 expect(JSON.stringify({plan,source})).toBe(before)
})

test('new opt-in numeric frame preserves physical owner/target order and carries no assigned density',()=>{
 const {plan,source}=fixture(),p=controlReleasePhysicalInput(plan,source,selected),q=p.clusters[0]!
 expect(p.fields).toHaveLength(15+52*13)
 expect(p.fields.slice(0,9)).toEqual([52,.25,p.minimumStemPose_m,1,.01,20000,20,.01,.5])
 expect(p.fields.slice(9,15)).toEqual([...p.jacks.targets,p.jacks.volume_m3,p.jacks.mass_kg])
 expect(p.fields.slice(15,28)).toEqual([q.topFitting.targets[0]!,q.topFitting.volume_m3,q.topFitting.mass_kg,300,
  ...q.upperCollar.targets,q.upperCollar.volume_m3,q.upperCollar.mass_kg,1/104,q.upperCollar.sliceMass_kg,300])
 for(const c of p.clusters){
  expect(source.material.nativeInputs.targets[c.topFitting.targets[0]!]!.id).toBe(c.faId+'/top-fitting/Zr')
  expect(c.upperCollar.targets.map(i=>source.material.nativeInputs.targets[i]!.id)).toEqual(['Fe','Cr','Ni','Mn'].map(e=>'HEAD.COLLARS/'+e))
 }
 expect(p.fields.every(Number.isFinite)).toBe(true)
 expect('density_kg_m3' in p).toBe(false)
})

test('all five actual smaller-area loss interfaces stay shaft-occupied over the signed domain',()=>{
 const {plan,source}=fixture(),p=controlReleasePhysicalInput(plan,source,selected)
 expect(p.neckInterfaces.map(q=>q.plane_m)).toEqual([8,8.05,8.05+.1,8.35,8.35+.1])
 for(const q of p.neckInterfaces){
  const ratio=Math.min(q.lowerArea_m2,q.upperArea_m2)/Math.max(q.lowerArea_m2,q.upperArea_m2)
  expect(q.contractionK).toBe(.5*(1-ratio)**.75)
  expect(q.expansionK).toBe((1-ratio)**2)
 }
 // No support-loss transition may be silently omitted by a different layout.
 for(const edit of [
  (f:ReturnType<typeof fixture>)=>{f.plan.maximumStemPose_m=1.56},
  (f:ReturnType<typeof fixture>)=>{f.plan.d.control.stemLength_m=5.9},
  (f:ReturnType<typeof fixture>)=>{f.plan.d.attachment.stubLength_m=.07},
  (f:ReturnType<typeof fixture>)=>{f.plan.d.attachment.shoulderDiameter_m=.012},
 ]){const f=fixture();edit(f);expect(()=>controlReleasePhysicalInput(f.plan,f.source,selected)).toThrow()}
})

test('missing, duplicated, substituted or inconsistent material/thermal binding refuses',()=>{
 for(const edit of [
  (f:ReturnType<typeof fixture>)=>{f.plan.clusterFA[1]=f.plan.clusterFA[0]!},
  (f:ReturnType<typeof fixture>)=>{f.plan.motion.clusters[1]!.id=f.plan.motion.clusters[0]!.id},
  (f:ReturnType<typeof fixture>)=>{f.plan.water[1]!.id='POOL'},
  (f:ReturnType<typeof fixture>)=>{f.source.material.materialPayload.passive.stocks=f.source.material.materialPayload.passive.stocks.slice(1)},
  (f:ReturnType<typeof fixture>)=>{f.source.material.materialPayload.passive.stocks=[...f.source.material.materialPayload.passive.stocks,f.source.material.materialPayload.passive.stocks[0]!]},
  (f:ReturnType<typeof fixture>)=>{f.source.material.nativeInputs.targets=f.source.material.nativeInputs.targets.slice(1)},
  (f:ReturnType<typeof fixture>)=>{f.source.material.materialPayload.passive.stocks=f.source.material.materialPayload.passive.stocks.map((s,i)=>i===2?{...s,mass_kg:20}:s)},
  (f:ReturnType<typeof fixture>)=>{f.source.material.materialPayload.passive.stocks=f.source.material.materialPayload.passive.stocks.map((s,i)=>i===0?{...s,volume_m3:s.volume_m3/2}:s)},
  (f:ReturnType<typeof fixture>)=>{f.source.material.materialPayload.passive.stocks=f.source.material.materialPayload.passive.stocks.map((s,i)=>i===0?{...s,original_K:301}:s)},
  (f:ReturnType<typeof fixture>)=>{f.source.material.materialPayload.passive.stocks=f.source.material.materialPayload.passive.stocks.map((s,i)=>i===2?{...s,material:'steel304' as const}:s)},
 ]){const f=fixture();edit(f);expect(()=>controlReleasePhysicalInput(f.plan,f.source,selected)).toThrow()}
})

test('no negative shoulder travel, overlapping collars or added armature mass can enter',()=>{
 for(const edit of [
  (f:ReturnType<typeof fixture>)=>{f.plan.d.attachment.shoulderBottom_m=8.4},
  (f:ReturnType<typeof fixture>)=>{f.plan.d.control.collarBottoms_m=[8.35,8.05]},
  (f:ReturnType<typeof fixture>)=>{f.plan.d.control.collarBottoms_m=[8.05,8.1]},
  (f:ReturnType<typeof fixture>)=>{f.plan.d.control.gapArmature_kg=20},
  (f:ReturnType<typeof fixture>)=>{f.plan.d.control.collarID_m=.026},
 ]){const f=fixture();edit(f);expect(()=>controlReleasePhysicalInput(f.plan,f.source,selected)).toThrow()}
})
