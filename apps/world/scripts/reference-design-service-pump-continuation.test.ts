import {describe,expect,it} from 'bun:test'
import {parseServicePump,servicePumpBudget,servicePumpHead} from './reference-design-service-pump-continuation'

// Independent arithmetic input; no runtime, property package or sibling wiki is required.
const input={flow_kg_s:10,isentropicWork_J_kg:10000,speed:1,referenceFluidPower_W:125000,efficiency:.8,densityRatio:1,liquidFraction:1,metalTemperature_K:300,caseTemperature_K:300}
describe('service pump single-incidence continuation',()=>{
  it('rejects absent, repeated or nonphysical authored reference inputs',()=>{
    const basis={id:'FIXTURE',flow_kg_s:10,inletPressure_MPa:1,inletTemperature_C:40,outletPressure_MPa:2,receiverPressure_MPa:1.5,hydraulicEfficiency:.8,npshSpeed_m:1,npshFlow_m:2,existingTrainHoldup_m3:0}
    const document=(b:unknown)=>'```reference-service-pump\n'+JSON.stringify(b)+'\n```'
    expect(parseServicePump(document(basis))).toEqual(basis)
    expect(()=>parseServicePump('')).toThrow()
    expect(()=>parseServicePump(document(basis)+document(basis))).toThrow()
    expect(()=>parseServicePump(document({...basis,outletPressure_MPa:.5}))).toThrow()
    expect(()=>parseServicePump(document({...basis,hydraulicEfficiency:1.1}))).toThrow()
  })
  it('preserves native work and does not heat retained casing twice',()=>{
    const result=servicePumpBudget(input)
    expect(result.facePower).toBe(125000)
    expect(result.dischargeEnthalpyRise_J_kg).toBe(12500)
    expect(result.extra).toBe(0)
    expect(result.caseHeat).toBe(0)
    expect(result.metalHeat).toBe(0)
    expect(result.shaftPower).toBe(125000)
  })
  it('retains running deadhead work and reciprocal hot-metal heatback',()=>{
    const wet=servicePumpBudget({...input,flow_kg_s:0})
    expect(wet.shaftPower).toBe(1250)
    expect(wet.caseHeat).toBe(1250)
    expect(wet.facePower).toBe(0)
    const dry=servicePumpBudget({...input,flow_kg_s:0,liquidFraction:0,densityRatio:.01})
    expect(dry.metalHeat).toBe(12.5)
    expect(dry.caseHeat).toBe(0)
    const hot=servicePumpBudget({...input,flow_kg_s:0,speed:0,metalTemperature_K:350})
    expect(hot.caseHeat).toBe(100000)
    expect(hot.metalHeat).toBe(-100000)
    expect(hot.shaftPower).toBe(0)
  })
  it('keeps passive resistance, permits zero work and rejects unowned reverse machinery',()=>{
    expect(servicePumpHead(1e6,1,0,1,1)).toBe(-250000)
    expect(servicePumpBudget({...input,isentropicWork_J_kg:-50,speed:0}).shaftPower).toBe(0)
    expect(()=>servicePumpBudget({...input,flow_kg_s:-1})).toThrow('Invalid')
    expect(()=>servicePumpHead(1e6,1,1,-1,1)).toThrow('forward')
    expect(()=>servicePumpBudget({...input,speed:0})).toThrow('Stopped')
    for(const n of [1,.1,.01,.001]){
      const result=servicePumpBudget({...input,flow_kg_s:0,speed:n})
      expect(result.shaftPower/n).toBeCloseTo(1250*n*n,12)
    }
  })
})
