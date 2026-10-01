import {describe,expect,test} from 'bun:test'
import {chargeSampleInterval,parseNuclearWindow,pulseWindowEvidence} from './reference-design-nuclear-observation-window'
const record={window_s:60,alpha:.01,theta:.1,minimumExcessCount:400,backgroundRange_s:[0,2],deadtime_s:1e-6,maximumOccupancy:.1,sample_s:.1,noiseBound_A:1e-12,commissionOffsetBound_A:1e-12,saturation_A:.01}
const doc='```reference-nuclear-observation-window\n'+JSON.stringify(record)+'\n```',policy=parseNuclearWindow(doc)
describe('obtained NI window arithmetic, not acquisition realization',()=>{
 test('one exact authored policy',()=>{
  expect(policy.window_s).toBe(60)
  expect(()=>parseNuclearWindow(doc+doc)).toThrow()
  expect(()=>parseNuclearWindow(doc.replace('"alpha":0.01','"alpha":0.05'))).toThrow()
  expect(()=>parseNuclearWindow(doc.replace('"window_s":60','"window_s":60,"extra":1'))).toThrow()
 })
 test('obtained cold-like count fixture and two martingale tails',()=>{
  const N=1762,E=59.998238,r=pulseWindowEvidence(policy,{acceptedCounts:N,live_s:E,elapsed_s:60}),c=Math.log(200)
  expect(.1*N-Math.expm1(.1)*r.compensatorLower).toBeCloseTo(c,11)
  expect(-.1*N+(1-Math.exp(-.1))*r.compensatorUpper).toBeCloseTo(c,11)
  expect(r.excessLower).toBeCloseTo(r.compensatorLower-2*E,10)
  expect(r.windowPassesArithmetic).toBe(true)
  expect(r.totalRateLower_s).toBeLessThan(N/E)
  expect(r.totalRateUpper_s).toBeGreaterThan(N/E)
 })
 test('zero/background, partial and saturated windows withhold evidence',()=>{
  expect(pulseWindowEvidence(policy,{acceptedCounts:0,live_s:60,elapsed_s:60}).windowPassesArithmetic).toBe(false)
  expect(pulseWindowEvidence(policy,{acceptedCounts:60,live_s:59.99994,elapsed_s:60}).excessLower).toBe(0)
  expect(pulseWindowEvidence(policy,{acceptedCounts:1762,live_s:29.998238,elapsed_s:30}).windowPassesArithmetic).toBe(false)
  const sat=pulseWindowEvidence(policy,{acceptedCounts:59998200,live_s:.0018,elapsed_s:60})
  expect(sat.entireBandOccupancy).toBeGreaterThan(.1)
  expect(sat.windowPassesArithmetic).toBe(false)
  expect(()=>pulseWindowEvidence(policy,{acceptedCounts:1000,live_s:1,elapsed_s:60})).toThrow()
  expect(()=>pulseWindowEvidence(policy,{acceptedCounts:1000,live_s:60,elapsed_s:60})).toThrow()
  expect(()=>pulseWindowEvidence(policy,{acceptedCounts:1,live_s:0,elapsed_s:60})).toThrow()
  expect(()=>pulseWindowEvidence(policy,{acceptedCounts:1.5,live_s:60,elapsed_s:60})).toThrow()
  expect(()=>pulseWindowEvidence(policy,{acceptedCounts:1,live_s:61,elapsed_s:60})).toThrow()
 })
 test('current bounds obtained filtered charge, with no positive floor',()=>{
  const cold=chargeSampleInterval(policy,1.13e-13),normal=chargeSampleInterval(policy,.000135141)
  expect(cold.lower_A).toBeLessThan(0)
  expect(cold.upper_A).toBeGreaterThan(0)
  expect(normal.upper_A-normal.lower_A).toBeCloseTo(4e-12,16)
  expect(normal.unsaturated).toBe(true)
  expect(chargeSampleInterval(policy,.01).unsaturated).toBe(false)
  expect(()=>chargeSampleInterval(policy,NaN)).toThrow()
  const underlying=1.13e-13,extreme=chargeSampleInterval(policy,underlying+policy.noiseBound_A+policy.commissionOffsetBound_A)
  expect(extreme.lower_A).toBeCloseTo(underlying,25)
  expect(extreme.upper_A).toBeGreaterThan(underlying)
  const plausibleFault=chargeSampleInterval(policy,100e-12)
  expect(plausibleFault.unsaturated).toBe(true)
  expect(plausibleFault.lower_A).toBeGreaterThan(0) // Actual zero input is not a hidden helper argument/quality veto.
 })
})
