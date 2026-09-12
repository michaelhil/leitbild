import {expect,test} from 'bun:test'
import {parsePrhrMeterBasis,prhrResistance} from './reference-design-prhr-meter'
const basis={pressure_MPa:15,hot_C:320,pool_C:25,gravity_m_s2:9.80665,columnHeight_m:12,primaryConductance_W_K:2e6,poolConductance_W_K:2e6,forcedDifferential_Pa:250000,calibrationDensity_kg_m3:857.2005075123872}
const doc=(b:unknown)=>'```reference-prhr-meter\n'+JSON.stringify(b)+'\n```\n'
test('PRHR basis is strict and self-contained',()=>{
  expect(parsePrhrMeterBasis(doc(basis))).toEqual(basis)
  for(const input of [doc(basis)+doc(basis),doc({...basis,hot_C:20}),doc({...basis,unowned:1}),doc({...basis,columnHeight_m:0})])expect(()=>parsePrhrMeterBasis(input)).toThrow()
})
test('fixed meter remains fixed through opening, density and sign changes',()=>{
  for(const x of [0,.000001,.5,1])for(const dp of [-20000,0,20000])for(const rho of [600,800]) {
    const a=prhrResistance(dp,x,rho,800,350,2000,20000)
    const reversed=prhrResistance(-dp,x,rho,800,350,2000,20000)
    expect(a.flow_kg_s===-reversed.flow_kg_s).toBe(true)
    expect(a.meterDP_Pa+a.controlledDP_Pa).toBeCloseTo(dp,8)
    expect(a.meterDissipation_W).toBeGreaterThanOrEqual(0)
    expect(a.controlledDissipation_W).toBeGreaterThanOrEqual(0)
    expect(a.indicatedFlow_kg_s).toBeCloseTo(a.flow_kg_s*Math.sqrt(800/rho),10)
    if(x===0){expect(a.flow_kg_s===0).toBe(true);expect(a.meterDP_Pa===0).toBe(true)}
    else expect(a.controlledDP_Pa).toBeCloseTo(18000*a.flow_kg_s*Math.abs(a.flow_kg_s)/350**2*800/rho/x**2,7)
  }
  expect(prhrResistance(20000,1,800,800,350,2000,20000).flow_kg_s).toBe(350)
  expect(prhrResistance(20000,.5,800,800,350,2000,20000).flow_kg_s).toBeCloseTo(350/Math.sqrt(3.7),10)
})
test('invalid states reject without silent clamping or negative resistance',()=>{
  const args:[number,number,number,number,number,number,number]=[20000,1,800,800,350,2000,20000]
  for(const [index,value] of [[0,NaN],[1,1.1],[1,-.1],[2,0],[3,Infinity],[4,0],[5,0],[6,2000]]) {
    const a=[...args] as typeof args;a[index!]=value!;expect(()=>prhrResistance(...a)).toThrow()
  }
})
