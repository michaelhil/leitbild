import {describe,test,expect} from 'bun:test'
import {advanceDecayHistory,decayDeposition,releaseFraction,parseDecayHistory,compileDecayHistory,type DecayHistoryKernel,type DecayHistoryRecord} from './reference-design-decay-history'

const off={fission_s_inv:0,fertileCapture_s_inv:0}
const one:DecayHistoryKernel={fissionEnergy_J:1,promptFissionEnergy_J:.75,groups:[{feed:'fission',energy_J_per_event:.25,lambda_s_inv:.01}]}
const record:DecayHistoryRecord={fissionEnergy_MeV:190,referenceFissionEnergy_MeV:200,
 fissionProductAlpha_MeV_event_s:Array(23).fill(.001),fissionProductLambda_s_inv:Array(23).fill(.1),
 effectiveCaptureEnergy_MeV:[.625,.575],effectiveCaptureTimeConstants_s:[2040,290000],referenceCaptureRatio:.8,
 fissionProductSensitivity:[.8,1,1.2],effectiveCaptureSensitivity:[0,.5,1]}

describe('offline extensive delayed energy',()=>{
 test('independent one-group constant and stopped source solution',()=>{
  const E0=[100],source={fission_s_inv:200,fertileCapture_s_inv:0},t=30,r=advanceDecayHistory(one,E0,source,t),
   E=100*Math.exp(-.3)+5000*(1-Math.exp(-.3)),released=100+50*t-E
  expect(r.stores_J[0]).toBeCloseTo(E,11)
  expect(r.decay_J).toBeCloseTo(released,10)
  expect(r.prompt_J).toBe(4500)
  expect(Math.abs(r.balance_J)).toBeLessThan(1e-12)
  const stopped=advanceDecayHistory(one,r.stores_J,off,20)
  expect(stopped.stores_J[0]).toBeCloseTo(E*Math.exp(-.2),11)
  expect(stopped.decay_J).toBeCloseTo(E*(1-Math.exp(-.2)),11)
  expect(r.captureReserve_J).toBe(0)
 })
 test('very slow stores release finite positive newly born energy',()=>{
  const k:DecayHistoryKernel={fissionEnergy_J:1,promptFissionEnergy_J:.9,groups:[{feed:'fission',energy_J_per_event:.1,lambda_s_inv:2.05e-14}]},
   r=advanceDecayHistory(k,[0],{fission_s_inv:3e9,fertileCapture_s_inv:0},1)
  expect(r.decay_J).toBeGreaterThan(0)
  expect(r.decay_J).toBeCloseTo(.1*3e9*2.05e-14/2,16)
  expect(r.stores_J[0]).toBeCloseTo(3e8,4)
  expect(releaseFraction(0)).toBe(0)
  expect(releaseFraction(1e-16)).toBe(5e-17)
  for(const x of [.000999999,.001,.1,1,100]){
   // Independent integration of (1-exp(-x*s)) over s in [0,1].
   let q=0;const N=20000
   for(let i=0;i<=N;i++)q+=(i===0||i===N?1:i%2?4:2)*(-Math.expm1(-x*i/N))
   expect(Math.abs(releaseFraction(x)-q/(3*N))).toBeLessThan(4e-12)
  }
 })
 test('history, pause, copies and parcel-summed inventory are distinct',()=>{
  const k:DecayHistoryKernel={fissionEnergy_J:1,promptFissionEnergy_J:.9,groups:[{feed:'fission',energy_J_per_event:.1,lambda_s_inv:.01},{feed:'fertileCapture',energy_J_per_event:.05,lambda_s_inv:.00001}]},
   source={fission_s_inv:1000,fertileCapture_s_inv:20},
   long=advanceDecayHistory(k,[0,0],source,10000),short=advanceDecayHistory(k,[0,0],source,10),
   pause=advanceDecayHistory(k,long.stores_J,source,0),
   whole=advanceDecayHistory(k,long.stores_J,off,100),a=advanceDecayHistory(k,long.stores_J.map(E=>.2*E),off,100),
   b=advanceDecayHistory(k,long.stores_J.map(E=>.8*E),off,100)
  expect(long.final.total_W).toBeGreaterThan(short.final.total_W)
  expect(pause.stores_J).toEqual(long.stores_J)
  expect(pause.decay_J).toBe(0)
  expect(whole.final.decay_W).toBeCloseTo(a.final.decay_W+b.final.decay_W,12)
  const original=[...long.stores_J];advanceDecayHistory(k,long.stores_J,source,123)
  expect(long.stores_J).toEqual(original)
 })
 test('no invalid source, dimension, fabricated store or event budget',()=>{
  const source={fission_s_inv:1,fertileCapture_s_inv:0}
  for(const stores of [[-1],[],[NaN],[Infinity]])expect(()=>advanceDecayHistory(one,stores,source,1)).toThrow()
  for(const seconds of [-1,NaN,Infinity])expect(()=>advanceDecayHistory(one,[0],source,seconds)).toThrow()
  for(const rate of [-1,NaN,Infinity]){
   expect(()=>decayDeposition(one,[0],{...source,fission_s_inv:rate})).toThrow()
   expect(()=>decayDeposition(one,[0],{...source,fertileCapture_s_inv:rate})).toThrow()
  }
  expect(()=>advanceDecayHistory({...one,promptFissionEnergy_J:0},[0],source,1)).toThrow('budget')
  expect(()=>advanceDecayHistory({...one,groups:[{...one.groups[0]!,lambda_s_inv:0}]},[0],source,1)).toThrow()
  expect(()=>advanceDecayHistory(one,[0],{fission_s_inv:1e308,fertileCapture_s_inv:0},1e308)).toThrow()
 })
 test('current owner record is strict and does not reinterpret historical records',()=>{
  const doc='```reference-decay-history\n'+JSON.stringify(record)+'\n```'
  expect(compileDecayHistory(parseDecayHistory(doc)).groups.length).toBe(25)
  expect(()=>parseDecayHistory(doc+'\n'+doc)).toThrow()
  expect(()=>parseDecayHistory(doc.replace('"fissionEnergy_MeV":190','"unused":1,"fissionEnergy_MeV":190'))).toThrow()
  expect(()=>parseDecayHistory('```reference-decay-energy\n{}\n```')).toThrow()
  expect(()=>parseDecayHistory(doc.replace('reference-decay-history','reference-decay-history-200-historical'))).toThrow()
  expect(()=>parseDecayHistory(doc.replace('"effectiveCaptureEnergy_MeV"','"effectiveCaptureFractions"'))).toThrow()
  expect(()=>compileDecayHistory(record,1e6,1)).toThrow('budget')
  expect(()=>compileDecayHistory(record,1,-1)).toThrow()
 })
 test('fission and fertile capture are genuinely independent event feeds',()=>{
  const k=compileDecayHistory(record),empty=Array(25).fill(0),
   f=advanceDecayHistory(k,empty,{fission_s_inv:1e15,fertileCapture_s_inv:0},100),
   c=advanceDecayHistory(k,empty,{fission_s_inv:0,fertileCapture_s_inv:2e15},100),
   together=advanceDecayHistory(k,empty,{fission_s_inv:1e15,fertileCapture_s_inv:2e15},100)
  expect(f.stores_J.slice(23)).toEqual([0,0])
  expect(c.stores_J.slice(0,23)).toEqual(Array(23).fill(0))
  expect(c.prompt_J).toBe(0)
  expect(c.fissionSource_J).toBe(0)
  expect(f.captureReserve_J).toBe(0)
  expect(c.captureReserve_J).toBeCloseTo(1.2*1.602176634e-13*2e15*100,8)
  expect(f.fissionSource_J).toBeCloseTo(190*1.602176634e-13*1e15*100,6)
  for(let i=0;i<25;i++)expect(together.stores_J[i]).toBeCloseTo(f.stores_J[i]!+c.stores_J[i]!,8)
  expect(Math.abs(together.balance_J)).toBeLessThan(1e-6)
  // Capture scaling cannot alter the separately allocated fission prompt.
  expect(compileDecayHistory(record,1,0).promptFissionEnergy_J).toBe(k.promptFissionEnergy_J)
  expect(compileDecayHistory(record,1,2).promptFissionEnergy_J).toBe(k.promptFissionEnergy_J)
 })
 test('separate source feeds preserve exact interval splitting',()=>{
  const k=compileDecayHistory(record),source={fission_s_inv:9e18,fertileCapture_s_inv:2e18},
   initial=Array.from({length:25},(_,i)=>(i+1)*1e8),whole=advanceDecayHistory(k,initial,source,30),
   first=advanceDecayHistory(k,initial,source,13),second=advanceDecayHistory(k,first.stores_J,source,17)
  for(let i=0;i<25;i++)expect(Math.abs(whole.stores_J[i]!-second.stores_J[i]!)).toBeLessThan(1e-12*whole.stores_J[i]!)
  for(const key of ['prompt_J','decay_J','source_J','captureReserve_J','fissionSource_J'] as const)
   expect(Math.abs(whole[key]-first[key]-second[key])).toBeLessThan(1e-12*whole.source_J)
 })
})
