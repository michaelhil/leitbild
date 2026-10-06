import {beforeAll,describe,expect,test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {compileOriginalPassiveGeometry,parsePassiveMaterialLaw} from './reference-design-source-passive'
import {parsePrimaryWaterInputs,primaryWaterOwnerFiles} from './reference-design-source-water'
import {compileSourcePartition} from './reference-design-source-partition'
import {compileSourceFaces} from './reference-design-source-faces'
import {compileColdSourceMaterial,parseOperatingFuelCohorts} from './reference-design-source-material'
import {parseNuclearObservation} from './reference-design-nuclear-observation'
import {parseColdNuclear} from './reference-design-cold-nuclear'

// Actual owners are opt-in, never replaced by synthetic production inputs.
// A standalone checkout must import and skip this suite without loading files.
const wiki=process.env.LEITBILD_REFERENCE_WIKI,
 sum=(xs:number[])=>xs.reduce((s,x)=>s+x,0)
let d:ReturnType<typeof parsePrimaryWaterInputs>,partition:ReturnType<typeof compileSourcePartition>,
 sourceOwner:string,material:ReturnType<typeof compileColdSourceMaterial>,
 faces:ReturnType<typeof compileSourceFaces>['faces'],actual:ReturnType<typeof compileOriginalPassiveGeometry>
describe.skipIf(!wiki)('actual ORIGINAL passive source payload',()=>{
 beforeAll(()=>{
  const read=(name:string)=>readFileSync(join(wiki!,name),'utf8')
  d=parsePrimaryWaterInputs(primaryWaterOwnerFiles.map(read));partition=compileSourcePartition(d)
  sourceOwner=read('systems/reactor/configuration-source-and-history.md')
  material=compileColdSourceMaterial(partition,{fuel:d.fuel,handling:d.handling,
   grid:parseOperatingFuelCohorts(read('systems/reactor/radial-energy-transient.md')),
   apparatus:parseNuclearObservation(read('systems/instrumentation/nuclear-observation-apparatus.md')),
   source:{birthEmission_neutrons_s:parseColdNuclear(read('systems/reactor/cold-source-and-startup.md')).source.birthEmission_neutrons_s}})
  faces=compileSourceFaces(partition,d.gates,[0,0]).faces
  actual=compileOriginalPassiveGeometry(partition,d,material,faces,sourceOwner)
 })
 test('receiving free water and exact moments close actual occupied envelopes once',()=>{
  expect(actual.receivingPieces.every(p=>p.volume_m3>0&&Number.isFinite(p.momentZ_m4))).toBe(true)
  expect(new Set(actual.receivingPieces.map(p=>p.owner+'|'+p.sourceRegionId)).size).toBe(actual.receivingPieces.length)
  for(const bay of actual.bayClosure){
   const rows=actual.receivingPieces.filter(p=>p.owner===bay.owner)
   expect(sum(rows.map(r=>r.volume_m3))).toBeCloseTo(bay.freeVolume_m3,9)
   expect(sum(rows.map(r=>r.momentZ_m4))).toBeCloseTo(bay.momentZ_m4,9)
   expect(bay.freeVolume_m3+bay.excludedVolume_m3).toBeCloseTo(bay.grossVolume_m3,9)
  }
  expect(actual.bayClosure[1]!.excludedVolume_m3).toBe(0)
  // A coarse receiver containing several real axial cuts must not assume its
  // gross midpoint remains the centroid after displacement.
  const changed=actual.receivingPieces.find(p=>{
   const r=partition.regions.find(r=>r.id===p.sourceRegionId)!
   return Math.abs(p.momentZ_m4/p.volume_m3-(r.z0_m!+r.z1_m!)/2)>1e-4
  })
  expect(changed).toBeDefined()
 })
 test('finite material targets and represented/uncredited volumes are not field-cell copies',()=>{
  expect(new Set(actual.stocks.map(s=>s.id)).size).toBe(actual.stocks.length)
  expect(new Set(actual.stocks.flatMap(s=>s.targets.map(t=>t.id))).size).toBe(actual.stocks.flatMap(s=>s.targets).length)
  for(const s of actual.stocks){expect(s.mass_kg).toBeGreaterThan(0);expect(s.volume_m3).toBeGreaterThan(0)
   for(const t of s.targets){expect(t.atoms).toBe(t.referenceAtoms);expect(t.productAtoms).toBe(0);expect(t.atoms).toBeGreaterThan(0)}
  }
  for(const row of actual.stockCoverage)expect(row.representedVolume_m3+row.uncreditedOutsideVolume_m3).toBeCloseTo(row.totalVolume_m3,9)
  const barrel=actual.stockCoverage.find(s=>s.stockId==='BARREL')!
  expect(barrel.representedVolume_m3/barrel.totalVolume_m3).toBeCloseTo(2/3,12)
  expect(actual.stocks.filter(s=>s.captureMode==='unsupported-cylinder')).toHaveLength(52)
  expect(actual.stocks.filter(s=>s.id.endsWith('/guide-metal'))).toHaveLength(193)
 })
 test('head is bulk steel plus physical hole current; no invented optical head',()=>{
  const c=d.control,head=actual.stocks.find(s=>s.id==='HEAD.SLAB')!
  expect(head.volume_m3).toBeCloseTo((c.headGrossArea_m2-c.clusters*Math.PI*(c.housingID_m/2)**2)*c.headThickness_m,12)
  expect(head.captureMode).toBe('volume')
  expect(sum(actual.headBulkAdmission.map(p=>p.holeArea_m2))).toBeCloseTo(c.clusters*Math.PI*(c.housingID_m/2)**2,12)
  expect(sum(actual.headBulkAdmission.map(p=>p.holeArea_m2+p.steelArea_m2))).toBeCloseTo(c.headGrossArea_m2,12)
  expect(actual.opticalFaces.some(p=>p.supportId==='HEAD.MOUTH')).toBe(false)
  expect(head.thermalRecipientId).toBe('HEAD.ATTACHED')
 })
 test('optical capture and bulk scatter/capture are separated at the actual inventories',()=>{
  const byId=new Map(actual.stocks.map(s=>[s.id,s]))
  for(const s of actual.nativeBulk.stocks){
   const owner=byId.get(s.id)!
   if(owner.captureMode!=='volume')expect(s.targets).toHaveLength(0)
   if(s.id.startsWith('GATE.'))expect(s.scatter.every(x=>x===0)).toBe(true)
   else expect(s.scatter.every(x=>x>0)).toBe(true)
  }
  for(const f of actual.opticalFaces){expect(f.layers).toHaveLength(f.supportId.startsWith('GATE.')?1:3)
   for(const layer of f.layers)for(const column of layer.columns){
    expect(column.atoms_per_m2).toBeGreaterThan(0)
    expect(actual.stocks.some(s=>s.captureMode==='optical'&&s.targets.some(t=>t.id===column.targetId))).toBe(true)
   }
  }
  const ordinary=actual.stocks.filter(s=>s.captureMode==='volume').flatMap(s=>s.targets)
  expect(actual.nativeBulk.targets.map(t=>t.id)).toEqual(ordinary.map(t=>t.id))
  expect(actual.captureRecipientLinks).toHaveLength(actual.stocks.flatMap(s=>s.targets).length)
  expect(actual.captureRecipientLinks.every(r=>r.bindingEmission_J.every(Number.isFinite))).toBe(true)
  expect(actual.emissionIsDepositedHeat).toBe(false);expect(actual.completeReactorOperator).toBe(false)
 })
 test('missing/duplicated original or law inputs refuse instead of normalization or fake optical layers',()=>{
  expect(()=>compileOriginalPassiveGeometry({...partition,regions:partition.regions.slice(1)},d,material,faces,sourceOwner)).toThrow('lineage')
  expect(()=>compileOriginalPassiveGeometry(partition,d,{...material,materialIncidence:material.materialIncidence.filter(r=>r.stockId!==partition.assemblies[0]!.id+'/guide-metal')},faces,sourceOwner)).toThrow('Missing original Zr')
  expect(()=>compileOriginalPassiveGeometry(partition,d,material,faces.filter(f=>f.support?.id!=='GATE.WELL'),sourceOwner)).toThrow('closed gate')
  expect(()=>parsePassiveMaterialLaw(sourceOwner.replace('"scatterMapping":"within-group elastic in all seven groups"','"scatterMapping":"unselected"'))).toThrow()
  expect(()=>parsePassiveMaterialLaw(sourceOwner.replace('7.6461716 / 7.9394277 / 8.9992797 / 7.2704420','7.6461716'))).toThrow()
 })
})
