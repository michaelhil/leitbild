import {describe,test,expect} from 'bun:test'
import {advanceDecayHistory,decayDeposition,releaseFraction,parseDecayHistory,decayHistoryGroups} from './reference-design-decay-history'

describe('offline extensive delayed energy',()=>{
 test('independent one-group constant and stopped source solution',()=>{
  const g=[{fraction:.25,lambda_s_inv:.01}],E0=[100],P=200,t=30,r=advanceDecayHistory(g,E0,P,t),
   E=100*Math.exp(-.3)+5000*(1-Math.exp(-.3)),released=100+50*t-E
  expect(r.stores_J[0]).toBeCloseTo(E,11)
  expect(r.decay_J).toBeCloseTo(released,10)
  expect(r.prompt_J).toBe(4500)
  expect(Math.abs(r.balance_J)).toBeLessThan(1e-12)
  const off=advanceDecayHistory(g,r.stores_J,0,20)
  expect(off.stores_J[0]).toBeCloseTo(E*Math.exp(-.2),11)
  expect(off.decay_J).toBeCloseTo(E*(1-Math.exp(-.2)),11)
 })
 test('very slow stores release finite positive newly born energy',()=>{
  const g=[{fraction:.1,lambda_s_inv:2.05e-14}],r=advanceDecayHistory(g,[0],3e9,1)
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
  const g=[{fraction:.1,lambda_s_inv:.01},{fraction:.05,lambda_s_inv:.00001}],long=advanceDecayHistory(g,[0,0],1000,10000),
   short=advanceDecayHistory(g,[0,0],1000,10),pause=advanceDecayHistory(g,long.stores_J,1000,0),
   one=advanceDecayHistory(g,long.stores_J,0,100),a=advanceDecayHistory(g,long.stores_J.map(E=>.2*E),0,100),
   b=advanceDecayHistory(g,long.stores_J.map(E=>.8*E),0,100)
  expect(long.final.total_W).toBeGreaterThan(short.final.total_W)
  expect(pause.stores_J).toEqual(long.stores_J)
  expect(pause.decay_J).toBe(0)
  expect(one.final.decay_W).toBeCloseTo(a.final.decay_W+b.final.decay_W,12)
  const original=[...long.stores_J];advanceDecayHistory(g,long.stores_J,200,123)
  expect(long.stores_J).toEqual(original)
 })
 test('no invalid source, dimension, fabricated store or event budget',()=>{
  const g=[{fraction:.1,lambda_s_inv:1}]
  for(const stores of [[-1],[],[NaN],[Infinity]])expect(()=>advanceDecayHistory(g,stores,1,1)).toThrow()
  for(const seconds of [-1,NaN,Infinity])expect(()=>advanceDecayHistory(g,[0],1,seconds)).toThrow()
  expect(()=>decayDeposition(g,[0],-1)).toThrow()
  expect(()=>advanceDecayHistory([{fraction:1,lambda_s_inv:1}],[0],1,1)).toThrow('budget')
  expect(()=>advanceDecayHistory([{fraction:.1,lambda_s_inv:0}],[0],1,1)).toThrow()
  expect(()=>advanceDecayHistory(g,[0],1e308,1e308)).toThrow()
 })
 test('current owner record is strict and not the historical six-store record',()=>{
  const record={eventEnergy_MeV:200,fissionProductAlpha_MeV_event_s:Array(23).fill(.001),fissionProductLambda_s_inv:Array(23).fill(.1),
   effectiveCaptureFractions:[.0025,.0023],effectiveCaptureTimeConstants_s:[2040,290000],fissionProductSensitivity:[.8,1,1.2],effectiveCaptureSensitivity:[0,.5,1]},
   doc='```reference-decay-history\n'+JSON.stringify(record)+'\n```'
  expect(decayHistoryGroups(parseDecayHistory(doc)).length).toBe(25)
  expect(()=>parseDecayHistory(doc+'\n'+doc)).toThrow()
  expect(()=>parseDecayHistory(doc.replace('"eventEnergy_MeV":200','"unused":1,"eventEnergy_MeV":200'))).toThrow()
  expect(()=>parseDecayHistory('```reference-decay-energy\n{}\n```')).toThrow()
  expect(()=>decayHistoryGroups(record,1000,1)).toThrow('budget')
  expect(()=>decayHistoryGroups(record,1,-1)).toThrow()
 })
})
