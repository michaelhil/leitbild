import {beforeAll,expect,test} from 'bun:test'
import {join} from 'node:path'
import {compileFuelCooling} from './reference-design-fuel-cooling'
import {compilePrhrCooling,nativePrhrCoolingFrame,parsePrhrColdPreparation} from './reference-design-prhr-cooling'
const wiki=process.env.LEITBILD_REFERENCE_WIKI,owned=wiki?test:test.skip
let p:Awaited<ReturnType<typeof compileFuelCooling>>,docs:string[]
beforeAll(async()=>{if(!wiki)return
 p=await compileFuelCooling(wiki,{prhr:true})
 docs=await Promise.all(['systems/passive-cooling/residual-heat-exchanger.md','systems/passive-cooling/reservoir-and-containment.md',
  'systems/support-services/thermal-water-and-air.md','model/operating-fluid-model.md'].map(n=>Bun.file(join(wiki,n)).text()))
})
owned('PRHR joins disjoint existing HOT tap owners without duplicating primary inventory',()=>{
 const n=p.network,g=n.prhr!,baselineHot=15,
  hot=n.water.filter(w=>w.id.startsWith('HOT.A.')),
  tee=n.water[p.pressure.primary]!
 expect(hot.reduce((s,w)=>s+w.volume_m3,0)).toBeCloseTo(baselineHot,12)
 expect(hot.map(w=>w.id)).toEqual(['HOT.A.BEFORE','HOT.A.J','HOT.A.AFTER'])
 expect(tee.id).toBe('HOT.A.J')
 expect(n.water.filter(w=>w.id.startsWith('PRHR.')).reduce((s,w)=>s+w.volume_m3,0)).toBeCloseTo(g.totals.waterVolume_m3,12)
 const j=n.hydraulic.find(e=>e.id==='HOT.A.J->HOT.A.AFTER')!,
  after=n.water.find(w=>w.id==='HOT.A.AFTER')!,sg=n.hydraulic.find(e=>e.id==='HOT.A.AFTER->SG.A.PRIMARY.1')!
 expect(j.segments[1]!.length_m).toBeCloseTo(after.volume_m3/j.segments[1]!.area_m2,12)
 expect(sg.segments.length).toBe(1)
 expect(sg.segments[0]!.diameter_m).not.toBe(j.segments[1]!.diameter_m)
})
owned('compiler retains separate actual primary, bank, reservoir and room preparations',()=>{
 const n=p.network,c=p.prhr!
 expect(n.water.find(w=>w.id==='PRHR.SEAT.UP')!.temperature_K).toBe(p.conditioning.liquidTemperature_K)
 expect(n.water.find(w=>w.id==='PRHR.SEAT.DOWN')!.temperature_K).toBe(293.15)
 expect(c.wst.initial_temperature_k).toBe(288.15)
 expect(c.gasBoundary.temperature_k).toBe(298.15)
 expect(c.actuator.spring_energy_j).toBe(2500)
 expect(c.actuator.room_capacity_j_k).toBe(200e6)
 expect(c.actuator.stroke_s).toBe(5)
 expect(c.prep).toMatchObject({start_s:0,blocked:false,holdSupported:true,closingSupported:true})
})
owned('all finite steel paths are real contact geometry with each rotating face counted once',()=>{
 const c=p.prhr!,n=p.network,g=n.prhr!,disc=c.liquid.filter(l=>l.weight!==0)
 expect(disc.length).toBe(4)
 for(const s of g.disc){const contacts=disc.filter(l=>n.solids[l.solid]!.id===s.id)
  expect(contacts.map(l=>l.weight).sort()).toEqual([1,2])
  expect(contacts[0]!.area).toBe(contacts[1]!.area)
 }
 expect(c.pool.length).toBe(14)
 expect(c.gas.length).toBe(5)
 expect(c.pool.reduce((sum,q)=>sum+q.area,0)).toBeCloseTo(
  g.parts.filter(q=>q.immersed).reduce((sum,q)=>sum+Math.PI*q.outsideDiameter_m*q.length_m*q.parallel,0),10)
 expect(c.pool.every(q=>q.half_resistance>0 && q.bank_factor===g.contact.bankFactor)).toBe(true)
 const farLower=c.liquid.find(q=>n.water[q.water]!.id==='PRHR.LOWER.2')!
 expect(n.hydraulic[farLower.flow_edge]!.id).toBe('PRHR.LOWER.2->PRHR.RETURN.BANK')
 expect(n.heat.filter(h=>h.kind===0).length).toBe(19)
})
owned('axial molecular transfer is not duplicated on the return mixing intervals',()=>{
 const c=p.prhr!,key=(q:{from:number;to:number})=>[q.from,q.to].sort((a,b)=>a-b).join('/'),
  axial=new Set(c.axial.map(key))
 expect(c.mixing.length).toBe(3)
 expect(c.mixing.every(q=>!axial.has(key(q)))).toBe(true)
 expect(c.axial.filter(q=>q.seat).length).toBe(1)
 expect(c.mixing.reduce((s,q)=>s+q.separation,0)).toBeCloseTo(p.network.prhr!.geometry.coldConnector.length_m,12)
 expect(c.mixing.every(q=>p.network.water[q.sg_water]!.id==='SG.A.PRIMARY.4')).toBe(true)
 expect(c.mixing.every(q=>p.network.hydraulic[q.sg_flow_edge]!.id==='SG.A.PRIMARY.3->SG.A.PRIMARY.4')).toBe(true)
})
owned('strict optional apparatus frame never silently supplies healthy support or geometry',()=>{
 expect(nativePrhrCoolingFrame(undefined)).toEqual([0])
 const fields=nativePrhrCoolingFrame(p.prhr)
 expect(fields[0]).toBe(1);expect(fields.every(Number.isFinite)).toBe(true)
 expect(()=>parsePrhrColdPreparation(docs[3]!.replace('"blocked":false','"blocked":false,"mystery":1'))).toThrow()
 expect(()=>parsePrhrColdPreparation(docs[3]!.replace('"holdSupported":true,',''))).toThrow()
 expect(()=>compilePrhrCooling(p.network,docs[0]!.replace('Es=2500','Es=missing'),docs[1]!,docs[2]!,docs[3]!)).toThrow()
 expect(()=>compilePrhrCooling(p.network,docs[0]!,docs[1]!,docs[2]!.replace('each with200MJ/K','each withmissingMJ/K'),docs[3]!)).toThrow()
})
