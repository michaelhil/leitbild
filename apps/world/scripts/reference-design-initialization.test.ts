import { expect,test } from 'bun:test'
import { parseInitializationBasis,unforcedTraceDrift } from './reference-design-initialization.ts'
import { replayHotAInstruments } from './reference-design-observations.ts'
const basis:ReturnType<typeof parseInitializationBasis>={design:'LD-01',volumes_m3:[20,28.5,9,9,33.5,15,15,25,25,20,20],metalCapacity_MJ_K:150,
  motorTracking_s:5,inertiaDecay_s:10,hold_s:10,holdStep_s:.25,perturbation_s:5,steps_s:[.1,.05,.025],sourcePulseFraction:.001,sourcePulse_s:1}
const doc=(v:unknown)=>'```reference-initialization\n'+JSON.stringify(v)+'\n```\n'
test('initialization accepts one finite inventory and exact event/refinement grids',()=>{
  expect(parseInitializationBasis(doc(basis))).toEqual(basis)
  expect(()=>parseInitializationBasis(doc(basis)+doc(basis))).toThrow()
  for(const change of [{volumes_m3:[20,20,9,9,33.5,15,15,25,25,20,20]},
    {volumes_m3:[-1,49.5,9,9,33.5,15,15,25,25,20,20]},
    {metalCapacity_MJ_K:0},{sourcePulse_s:5},{sourcePulse_s:1.01},
    {steps_s:[.1,.06,.025]},{sourcePulseFraction:.5},{equations:'arbitrary code'}])
    expect(()=>parseInitializationBasis(doc({...basis,...change}))).toThrow()
})
const sample=(p=15,t=300)=>({p_MPa:Array(11).fill(p) as number[],T_C:Array(11).fill(t) as number[]})
test('actual hold-trace acceptance detects intermediate drift despite returned endpoint',()=>{
  expect(unforcedTraceDrift([sample(),sample()]).accepted).toBe(true)
  const drift=unforcedTraceDrift([sample(),sample(15.001,300.01),sample()])
  expect(drift.accepted).toBe(false)
  expect(drift.pressure_MPa).toBeCloseTo(.001,10)
  expect(drift.temperature_K).toBeCloseTo(.01,10)
})
test('hold evidence cannot pass with nonfinite values, missing cells or no advancement',()=>{
  expect(()=>unforcedTraceDrift([sample()])).toThrow()
  expect(()=>unforcedTraceDrift([sample(),sample(NaN)])).toThrow()
  expect(()=>unforcedTraceDrift([sample(),{p_MPa:[15],T_C:[300]}])).toThrow()
})
test('existing HOT pressure/temperature channels have distinct lag and resolution',()=>{
  const source=Array.from({length:11},(_,i)=>({t_s:i/10,p_MPa:Array(11).fill(15+i*.001) as number[],T_C:Array(11).fill(300+i*.001) as number[]}))
  const replay=replayHotAInstruments(source)
  expect(replay.rows.at(-1)!.pressure!.value).toBeCloseTo(15.008,10)
  expect(new Set(replay.rows.map(r=>r.temperature!.value)).size).toBe(1)
  expect(replay.rows.every(r=>r.quality==='AVAILABLE')).toBe(true)
  expect(()=>replayHotAInstruments([source[0]!,source[2]!])).toThrow()
})
test('I1 interruption freezes acquisition and cannot backfill unseen history',()=>{
  const source=Array.from({length:11},(_,i)=>({t_s:i/10,p_MPa:Array(11).fill(i>=3&&i<=6?16:15) as number[],T_C:Array(11).fill(300) as number[]}))
  const replay=replayHotAInstruments(source,[.2,.8])
  expect(replay.rows[5]!.quality).toBe('UNAVAILABLE')
  expect(replay.rows[5]!.pressure).toBeNull()
  expect(replay.rows[5]!.lastAcquiredAt_s).toBe(.1)
  expect(replay.rows[8]!.reason).toBe('REACQUIRING')
  expect(replay.rows[9]!.pressure!.value).toBe(15)
  expect(()=>replayHotAInstruments(source,[.25,.8])).toThrow()
})
