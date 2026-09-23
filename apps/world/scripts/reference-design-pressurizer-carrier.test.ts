import {expect,test} from 'bun:test'
import {pressurizerCarrierGeometry} from './reference-design-pressurizer-carrier'

test('fixed carrier owns actual disjoint rod-subtracted volume',()=>{
 const rows=pressurizerCarrierGeometry()
 expect(rows.length).toBe(10)
 expect(rows.reduce((sum,r)=>sum+r.volume_m3,0)).toBeCloseTo(59.74867258771282,10)
 expect(rows.reduce((sum,r)=>sum+r.solidVolume_m3,0)).toBeCloseTo(.25132741228718347,10)
 for(let i=0;i<10;i+=2){
  expect(rows[i]!.lateralArea_m2).toBe(rows[i+1]!.lateralArea_m2)
  expect(rows[i]!.volume_m3).toBeGreaterThan(0)
  expect(rows[i+1]!.solidVolume_m3).toBe(0)
 }
})
test('unshrouded lane interface is not a solid perimeter',()=>{
 const rows=pressurizerCarrierGeometry()
 for(const r of rows.filter(r=>r.lane==='inner'&&r.bottom_m>=3))expect(r.solidPerimeter_m).toBe(0)
 for(const r of rows.filter(r=>r.lane==='outer'))expect(r.solidPerimeter_m).toBeCloseTo(2*Math.sqrt(5*Math.PI),12)
})
