import {describe,expect,it} from 'bun:test'
import {advanceReliefLift,parseExpansion,reliefDemand} from './reference-design-ccw-expansion'
const basis={vesselVolume_m3:10,area_m2:10,floor_m:-.5,initialLiquid_m3:5,initialPressure_Pa:500000,initialTemperature_K:303.15,sideBranchCdA_m2:.01,equipmentPressure_Pa:1500000,equipmentTemperature_K:423.15,reliefOpenDifferential_Pa:1000000,reliefReseatDifferential_Pa:900000,reliefCdA_m2:.0005,reliefStroke_s:.05,outfallElevation_m:5,referenceOutfallPressure_Pa:101325}
const document=(b:unknown)=>'```reference-ccw-expansion\n'+JSON.stringify(b)+'\n```'
describe('CCW expansion selection',()=>{
  it('admits one finite typed vessel record without unowned keys',()=>{
    expect(parseExpansion(document(basis))).toEqual(basis)
    expect(()=>parseExpansion('')).toThrow()
    expect(()=>parseExpansion(document(basis)+document(basis))).toThrow()
    expect(()=>parseExpansion(document({...basis,initialLiquid_m3:10}))).toThrow()
    expect(()=>parseExpansion(document({...basis,hiddenMakeup:true}))).toThrow()
    expect(()=>parseExpansion(document({...basis,reliefReseatDifferential_Pa:1100000}))).toThrow()
  })
  it('keeps spring demand distinct from finite retained lift',()=>{
    const demand=reliefDemand(1e6,false,1e6,.9e6)
    expect(demand).toBe(true)
    const lift=advanceReliefLift(0,demand,.01,.05)
    expect(lift).toBeCloseTo(.2)
    expect(reliefDemand(.95e6,demand,1e6,.9e6)).toBe(true)
    expect(reliefDemand(.95e6,false,1e6,.9e6)).toBe(false)
    expect(reliefDemand(.9e6,true,1e6,.9e6)).toBe(false)
    expect(advanceReliefLift(lift,false,.005,.05)).toBeCloseTo(.1)
    expect(advanceReliefLift(lift,false,1,.05)).toBe(0)
    expect(advanceReliefLift(lift,true,1,.05)).toBe(1)
  })
  it('retains copied lift/demand and compares actual local backpressure',()=>{
    const state={lift:.6,demand:true},copy=structuredClone(state)
    const valveInlet=1.2e6
    expect(reliefDemand(valveInlet-.101325e6,false,1e6,.9e6)).toBe(true)
    expect(reliefDemand(valveInlet-.6e6,true,1e6,.9e6)).toBe(false)
    expect(copy).toEqual(state)
    expect(advanceReliefLift(copy.lift,copy.demand,.01,.05)).toBeCloseTo(.8)
    expect(state.lift).toBe(.6)
    expect(()=>reliefDemand(Number.NaN,false,1e6,.9e6)).toThrow()
  })
})
