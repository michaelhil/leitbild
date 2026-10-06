import {expect,test} from 'bun:test'
import {join} from 'node:path'
import {primaryWaterOwnerFiles,parsePrimaryWaterInputs,compilePrimaryWaterGeometry,waterPreparationPoints,assembleOriginalWater} from './reference-design-source-water'
import {compileSourcePartition} from './reference-design-source-partition'

const wiki=process.env.LEITBILD_REFERENCE_WIKI
const inputs=async()=>parsePrimaryWaterInputs(await Promise.all(primaryWaterOwnerFiles.map(f=>Bun.file(join(wiki!,f)).text())))
const totals=(g:ReturnType<typeof compilePrimaryWaterGeometry>)=>{
 const m=new Map<string,number>();for(const p of g.pieces)m.set(p.owner,(m.get(p.owner)??0)+p.volume_m3);return m
}
test.skipIf(!wiki)('actual primary support closes once, with no HJT carve or packing-water invention',async()=>{
 const d=await inputs(),g=compilePrimaryWaterGeometry(compileSourcePartition(d),d),t=totals(g)
 expect(t.get('DOWN')).toBeCloseTo(20,11)
 expect(g.pieces.filter(p=>p.owner==='DOWN'&&p.sourceRegionId).reduce((a,p)=>a+p.volume_m3,0)).toBeCloseTo(20*4/6,11)
 expect(t.get('Core.1.EXTERNAL')).toBeCloseTo(t.get('Core.2.EXTERNAL')!,11)
 expect(g.pieces.some(p=>p.owner.includes('POOL')||p.owner.includes('PACKING'))).toBe(false)
 expect(g.pieces.filter(p=>p.owner.startsWith('HOUSING')).every(p=>p.sourceRegionId?.startsWith('WELL/'))).toBe(true)
 const missing={...compileSourcePartition(d),regions:compileSourcePartition(d).regions.slice(1)}
 expect(()=>compilePrimaryWaterGeometry(missing,d)).toThrow('lineage')
 expect(()=>compilePrimaryWaterGeometry(compileSourcePartition(d),{...d,anchor:{...d.anchor,temperature_K:600}})).toThrow('ORIGINAL')
})
test.skipIf(!wiki)('source-only refinement changes incidence, not selected hydraulic geometry or isotope stock',async()=>{
 const d=await inputs(),coarse=compilePrimaryWaterGeometry(compileSourcePartition(d),d),
  fineInput={...d,partition:{coreBands:8}},fine=compilePrimaryWaterGeometry(compileSourcePartition(fineInput),fineInput),a=totals(coarse),b=totals(fine)
 expect([...a.keys()].sort()).toEqual([...b.keys()].sort())
 for(const [owner,V] of a)expect(b.get(owner)).toBeCloseTo(V,10)
 // Test-only constant property tuple, not native IF97 evidence.
 const sample={density_kg_m3:1000,u_J_kg:100,pressure_Pa:300000,temperature_K:300,h_J_kg:400,s_J_kg_K:1},
  x=assembleOriginalWater(coarse,waterPreparationPoints(coarse).map(()=>sample)),
  y=assembleOriginalWater(fine,waterPreparationPoints(fine).map(()=>sample))
 for(const owner of x.nativeOwners){const v=y.nativeOwners.find(q=>q.owner===owner.owner)!
  for(const k of Object.keys(owner.total) as (keyof typeof owner.total)[])
   expect(Math.abs(v.total[k]-owner.total[k])).toBeLessThan(1e-10*Math.max(1,Math.abs(owner.total[k])))
  expect(owner.total.mobileMarker_kg_eq).toBeCloseTo(.002*owner.total.water_kg,9)
  expect(owner.total.retainedN10).toBe(0);expect(owner.total.HcaptureProduct).toBe(0)
 }
 expect(()=>assembleOriginalWater(coarse,[])).toThrow('coverage')
})
