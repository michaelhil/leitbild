import {beforeAll,describe,expect,test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {prepareMovingFuelCooling,movingFuelCoolingNativeInput} from './reference-design-control-geometry'
import {compileControlSourceMotion,controlSteelHeatNativeInput,controlSourceMotionAt,parseControlSteelNuclear,nativeControlSourcePlan} from './reference-design-control-source-motion'
import {parseColdControlRelease,controlReleasePhysicalInput} from './reference-design-control-release'
import {compileSourceEvolution,sourceEvolutionOwnerFiles} from './reference-design-source-evolution'
import {axialIntervalOverlap} from './reference-design-control-material-motion'

const wiki=process.env.LEITBILD_REFERENCE_WIKI,evidence=process.env.LEITBILD_REFERENCE_EVIDENCE,
 water=process.env.LEITBILD_REFERENCE_ORIGINAL_WATER_RECEIPT
describe.skipIf(!wiki||!evidence||!water)('actual joined moving structural SOURCE compiler',()=>{
 let prepared:Awaited<ReturnType<typeof prepareMovingFuelCooling>>,old:ReturnType<typeof compileSourceEvolution>,
  heat:ReturnType<typeof controlSteelHeatNativeInput>
 beforeAll(async()=>{
  prepared=await prepareMovingFuelCooling(wiki!,evidence!,water!,{controlSteel:true})
  heat=controlSteelHeatNativeInput(prepared.plan,prepared.source)
  const read=(p:string)=>readFileSync(p,'utf8')
  old=compileSourceEvolution(read(join(evidence!,'2026-10-05/operating-source-fixed-partition.json')),
   read(join(evidence!,'2026-10-05/operating-source-cold-material-incidence.json')),read(water!),
   new Map(sourceEvolutionOwnerFiles.map(p=>[p,read(join(wiki!,p))])),
   JSON.parse(read(join(evidence!,'2026-10-06/source-composed-cylinder-converter-1.json.artifacts/material.json'))).receiving.property)
 },30_000)
 test('one augmented SOURCE owns104newMn histories and416 targets; existing fuel/water histories unchanged',()=>{
  expect(prepared.source.material.nativeInputs.targets).toHaveLength(old.material.nativeInputs.targets.length+416)
  expect(prepared.source.manganese).toHaveLength(old.manganese.length+104)
  expect(prepared.source.counts.evolvedCoordinates).toBe(old.counts.evolvedCoordinates+520)
  expect(prepared.source.history).toEqual(old.history)
  expect(prepared.source.projection).toEqual(old.projection)
  expect(prepared.source.material.materialPayload.passive.stocks.slice(0,old.material.materialPayload.passive.stocks.length))
   .toEqual(old.material.materialPayload.passive.stocks)
 })
 test('native framing preserves ordered words without using the argument stack for payload size',()=>{
  const actual=movingFuelCoolingNativeInput(prepared),words=prepared.cooling.fixture.trim().split(/\s+/)
  expect(actual[0]).toBe(words.length)
  expect(actual.slice(1,1+words.length)).toEqual(words)
  const large=Array.from({length:500_000},(_,i)=>String(i%101)),
   expanded=movingFuelCoolingNativeInput({...prepared,cooling:{...prepared.cooling,fixture:large.join(' ')}})
  expect(expanded[0]).toBe(large.length)
  expect(expanded.slice(1,1+large.length)).toEqual(large)
  expect(expanded.slice(1+large.length)).toEqual(actual.slice(1+words.length))
 })
 test('current union replaces all and only new structural ORIGINAL incidence',()=>{
  const {plan,passive,cooling}=prepared,structural=new Set(heat.hosts.map(h=>h.stock)),
   original=new Map(passive.nativeBulk.incidence.map(r=>[r.stock+'/'+r.region,r.volume])),seen=new Set<string>()
  for(const [i,r]of plan.passiveRows.entries()){
   const key=r.stock+'/'+r.region
   expect(seen.has(key)).toBe(false);seen.add(key)
   if(structural.has(r.stock)){expect(r.steelRow).toBeDefined();expect(r.geometryRow).toBe(-1)}
   else expect(r.steelRow).toBeUndefined()
   expect(cooling.passive[i]!.volume).toBeCloseTo(original.get(key)??0,12)
  }
  expect(plan.water).toHaveLength(98);expect(plan.hydraulic).toHaveLength(157)
  expect(plan.steelHosts).toHaveLength(104)
 })
 test('WELL neutron boxes route shaft heat by physical main/neck origins, never receiving-well water',()=>{
  const {plan}=prepared,pairs=new Map<string,Set<string>>()
  for(const r of plan.steelRoutes){
   expect(plan.water[r.water]!.id).toBe('UPPER')
   const key=r.host+'/'+r.source_region,origins=pairs.get(key)??new Set<string>()
   origins.add(plan.origins[r.origin]!.id);pairs.set(key,origins)
  }
  expect([...pairs.values()].some(origins=>origins.has('HOUSING.MAIN')&&origins.has('HOUSING.NECK'))).toBe(true)
  for(const [host,h]of plan.steelHosts.entries()){
   const maximum=h.kind==='stem'?plan.maximumStemPose_m:plan.maximumBodyPose_m
   for(const y of [0,.004,.271,maximum]){
   let V=0,dV=0,dJ=0
   for(const r of plan.steelRoutes.filter(r=>r.host===host))for(const s of r.spans){
    const v=axialIntervalOverlap(s.lo,s.hi,r.lo,r.hi,y,y!==maximum);V+=s.area*v[0];dV+=s.area*v[1];dJ+=s.area*v[3]
   }
   expect(V).toBeCloseTo(h.volume_m3,12);expect(dV).toBeCloseTo(0,12);expect(dJ).toBeCloseTo(h.volume_m3,12)
   }
  }
 })
 test('wire resolves each actual elemental target/Mn once and optical selection does not create geometry',()=>{
  expect(heat.fields.every(Number.isFinite)).toBe(true)
  expect(new Set(heat.hosts.flatMap(h=>h.targets)).size).toBe(416)
  expect(new Set(heat.hosts.map(h=>h.mn_owner)).size).toBe(104)
  for(const h of heat.hosts){
   expect(h.targets.map(i=>prepared.source.material.nativeInputs.targets[i]!.id)).toEqual(['Fe','Cr','Ni','Mn'].map(e=>h.id+'/'+e))
   expect(prepared.source.manganese[h.mn_owner]!.target).toBe(h.targets[3]!)
   expect(h.self_chord_m).toBe(.012)
  }
  const geometry=JSON.stringify([prepared.plan.passiveRows,prepared.plan.steelRoutes,prepared.plan.water]),
   nominal=prepared.plan.steelNuclear!
  for(const chord of [.006,.024]){
   const changed=controlSteelHeatNativeInput({...prepared.plan,steelNuclear:{...nominal,
    selection:{...nominal.selection,stemSelfChord_m:chord,spiderSelfChord_m:chord}}},prepared.source)
   expect(changed.hosts.every(h=>h.self_chord_m===chord)).toBe(true)
   expect(changed.routes).toBe(heat.routes)
  }
  expect(JSON.stringify([prepared.plan.passiveRows,prepared.plan.steelRoutes,prepared.plan.water])).toBe(geometry)
  expect(()=>controlSteelHeatNativeInput(prepared.plan,old)).toThrow('identity/order')
  expect(()=>controlSteelHeatNativeInput({...prepared.plan,steelNuclear:null},prepared.source)).toThrow('selection')
 })
 test('separated nonuniform poses preserve stem/spider histories and restore current coefficients exactly',()=>{
  const {plan}=prepared,poses=plan.motion.clusters.map(c=>({clusterId:c.id,body_y_m:0,stem_y_m:0,
   side:'increasing' as const,stem_side:'increasing' as const,contact:'seated' as const})),
   before=JSON.stringify([prepared.source.material.nativeInputs.targets,prepared.source.manganese,plan.steelHosts]),
   original=controlSourceMotionAt(plan,poses),moved=controlSourceMotionAt(plan,poses.map((p,i)=>({...p,
    body_y_m:.003+i*.00001,stem_y_m:.004+i*.00001,contact:'offseat' as const})))
  expect(moved.source.passiveVolumes).not.toEqual(original.source.passiveVolumes)
  expect(controlSourceMotionAt(plan,poses)).toEqual(original)
  expect(JSON.stringify([prepared.source.material.nativeInputs.targets,prepared.source.manganese,plan.steelHosts])).toBe(before)
 })
 test('optical boundary rejects missing/duplicated/unselected law rather than hidden defaults',()=>{
  const owner=readFileSync(join(wiki!,'systems/reactor/control-absorber-and-guide-water.md'),'utf8')
  expect(parseControlSteelNuclear(owner)).toEqual(heat.selection)
  expect(()=>parseControlSteelNuclear(owner.replace('"stemSelfChord_m":0.012','"stemSelfChord_m":0'))).toThrow()
  expect(()=>parseControlSteelNuclear(owner.replace('homogenized-round-member-mean-chord','literal-cylinder'))).toThrow()
  expect(()=>parseControlSteelNuclear(owner+'\n```reference-control-steel-nuclear\n{}\n```\n')).toThrow()
 })
 test('explicit release selection prepares signed SOURCE/heat support without changing ordinary wire or history',()=>{
  const {plan,p,passive,cylinder,source}=prepared,
   selection=parseColdControlRelease(readFileSync(join(wiki!,'systems/reactor/control-absorber-and-guide-water.md'),'utf8')),
   ordinaryWords=nativeControlSourcePlan(plan),ordinaryHistory=JSON.stringify([source.material.nativeInputs.targets,source.manganese]),
   signed=compileControlSourceMotion(plan.d,p,passive,cylinder,heat.selection,selection),
   physical=controlReleasePhysicalInput(signed,source,selection),signedHeat=controlSteelHeatNativeInput(signed,source),
   poses=signed.motion.clusters.map(c=>({clusterId:c.id,body_y_m:0,stem_y_m:0,side:'increasing' as const,
    stem_side:'increasing' as const,contact:'seated' as const})),original=controlSourceMotionAt(signed,poses)
  expect(plan.minimumStemPose_m).toBe(0)
  expect(signed.minimumStemPose_m).toBe(physical.minimumStemPose_m)
  expect(signedHeat.hosts).toEqual(heat.hosts)
  expect(physical.fields).toHaveLength(698)
  for(const y of [physical.minimumStemPose_m,physical.minimumStemPose_m/2,0]){
   const stage=controlSourceMotionAt(signed,poses.map((p,i)=>({...p,stem_y_m:y*(52-i)/52,
    stem_side:y===0?'decreasing' as const:'increasing' as const})))
   expect(stage.water).toHaveLength(98)
   expect(stage.water.reduce((s,w)=>s+w.volume_m3,0)).toBeCloseTo(original.water.reduce((s,w)=>s+w.volume_m3,0),10)
   expect(stage.mobile.liquid_chords_m.every(v=>v>0)).toBe(true)
   expect(stage.source.passiveVolumes.every(v=>v>=0)).toBe(true)
  }
  expect(()=>controlSourceMotionAt(plan,poses.map(q=>({...q,stem_y_m:physical.minimumStemPose_m})))).toThrow('pose')
  expect(controlSourceMotionAt(signed,poses)).toEqual(original)
  expect(nativeControlSourcePlan(plan)).toEqual(ordinaryWords)
  expect(JSON.stringify([source.material.nativeInputs.targets,source.manganese])).toBe(ordinaryHistory)
 })
})
