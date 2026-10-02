import {expect,test} from 'bun:test'
import {checkRcpPhase,distributedRcpSource,gasVolumeFraction,localRcpSource,parseRcpPhase} from './reference-design-rcp-phase-continuation'
const basis={passageVolume_m3:8 as const,passageDiameter_m:.70 as const,mixedDegradationDepth:.5 as const,
  mixedDegradationChallenges:[0,.75] as [0,.75],sourceWeight:'uniform-passage-length' as const,
  material:'native-common-velocity-steam-air-nitrogen' as const}
const doc=(v:unknown)=>'```reference-rcp-phase-continuation\n'+JSON.stringify(v)+'\n```\n'
test('one frozen source/material record, no silent coefficient variants',()=>{
  expect(parseRcpPhase(doc(basis))).toEqual(basis)
  for(const change of [{passageVolume_m3:16},{mixedDegradationDepth:.75},{material:'liquid-only'},{extra:1}])
    expect(()=>parseRcpPhase(doc({...basis,...change}))).toThrow()
  expect(()=>parseRcpPhase(doc(basis)+doc(basis))).toThrow()
})
test('fixed phase/quadrant/partition discriminator passes',()=>{
  const x=checkRcpPhase(basis)
  expect(x.cases).toBe(1125)
  expect(x.maxNormalizedIdentity).toBeLessThanOrEqual(1e-12)
  expect(x.nonuniform.internalProduction_W).toBeGreaterThanOrEqual(0)
})
test('absent liquid still passes native gas and retains torque; zero work axes',()=>{
  const c={a:.01,b:2,resistance:5000}
  const gas=localRcpSource({rho:2,alphaG:1,q:-.1},0,c,.5)
  expect(gas.G).toBe(1);expect(gas.rise).toBeGreaterThan(0)
  expect(gas.torque).toBeGreaterThan(0);expect(gas.power).toBe(0)
  expect(localRcpSource({rho:2,alphaG:1,q:0},300,c,.5).torque).toBe(0)
  expect(gasVolumeFraction(0,8)).toBe(1)
})
test('invalid material and passage partition are rejected, not clipped',()=>{
  for(const volumes of [[0,0],[-1,1],[1,NaN]])
    expect(()=>gasVolumeFraction(...volumes as [number,number])).toThrow()
  const c={a:.01,b:2,resistance:5000}
  for(const material of [{rho:0,alphaG:0,q:1},{rho:2,alphaG:1.01,q:1}])
    expect(()=>localRcpSource(material,0,c,.5)).toThrow()
  expect(()=>distributedRcpSource([{weight:.5,material:{rho:2,alphaG:1,q:1}}],0,c,.5,basis)).toThrow()
})
