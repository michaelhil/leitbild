import {describe,expect,test} from 'bun:test'
import {parsePrhrExchange,prhrExchange,prhrEntranceWeight,type PrhrExchangeBasis} from './reference-design-prhr-exchange'
const basis:PrhrExchangeBasis={diameter_m:.5,length_m:11,rise_m:8.04,roughness_m:.000015,initialCoreFraction:.5,mixingCoefficient:.01,turbulentPrandtl:.85,entranceCoefficient:.1}
// Supplied constitutive-test properties, not a thermodynamic profile or water-property calibration.
const hot={temperature_K:550,density_kg_m3:770,viscosity_Pas:.0001,conductivity_W_mK:.6,cp_J_kgK:5000}
const cold={temperature_K:350,density_kg_m3:975,viscosity_Pas:.0004,conductivity_W_mK:.65,cp_J_kgK:4200}
describe('Original PRHR paired-stream closure',()=>{
  test('tee forcing is localized and normalized, including a short finite pipe',()=>{
    for(const L of [11,.01]){
      const n=10000,dx=L/n
      let integral=0
      for(let i=0;i<=n;i++)integral+=(i===0||i===n?.5:1)*prhrEntranceWeight(i*dx,L,.5)*dx
      expect(integral).toBeCloseTo(1,6)
      expect(prhrEntranceWeight(0,L,.5)).toBeGreaterThan(prhrEntranceWeight(L,L,.5))
    }
    expect(()=>prhrEntranceWeight(-1,11,.5)).toThrow()
    expect(()=>prhrEntranceWeight(12,11,.5)).toThrow()
    expect(()=>prhrEntranceWeight(0,0,.5)).toThrow()
  })
  test('zero motion retains finite conduction, no invented mechanical input',()=>{
    const q=prhrExchange(basis,hot,cold,.5,0,0,0,800)
    expect(q.coreForce_N).toBe(0);expect(q.annulusForce_N).toBe(0)
    expect(q.entranceWork_W).toBe(0);expect(q.mechanicalAndHeatResidual_W).toBe(0)
    expect(q.interstreamConductance_W_K).toBeGreaterThan(0);expect(q.entropyProduction_W_K).toBeGreaterThan(0)
  })
  test('finite same-state rest, geometry and no additional volume',()=>{
    const q=prhrExchange(basis,hot,hot,.5,0,0,0,800),g=q.geometry
    expect(g.coreArea_m2+g.annulusArea_m2).toBe(g.area_m2)
    expect(g.interfacePerimeter_m).toBeCloseTo(Math.PI*.5*Math.sqrt(.5),12)
    expect(q.interstreamHeat_W).toBe(0);expect(q.entropyProduction_W_K).toBe(0)
    expect(q.differentialDrivingGradient_Pa_m).toBe(0)
  })
  test('signed exchange, source reaction and native energy cancel for both flow directions',()=>{
    for(const uc of [-.8,0,.7])for(const ua of [-.6,0,.9])for(const main of [-8,0,8])for(const coreFraction of [.25,.5,.75]){
      const q=prhrExchange(basis,hot,cold,coreFraction,uc,ua,main,800)
      expect(Math.abs(q.mechanicalAndHeatResidual_W)).toBeLessThan(1e-7)
      expect(q.interfacialDissipation_W).toBeGreaterThanOrEqual(0);expect(q.wallDissipation_W).toBeGreaterThanOrEqual(0)
      expect(q.entropyProduction_W_K).toBeGreaterThanOrEqual(0)
      expect(q.mainReactionForce_N*main+q.entranceWork_W).toBeCloseTo(0,8)
      const forceDifference=(q.coreForce_N/q.geometry.coreArea_m2-q.annulusForce_N/q.geometry.annulusArea_m2)/basis.length_m
      expect(q.entranceDifferentialGradient_Pa_m-q.differentialDragGradient_Pa_m).toBeCloseTo(forceDifference,8)
      if(uc<ua&&main!==0)expect(q.entranceWork_W).toBeLessThan(0)
    }
  })
  test('smooth zero-slip and zero-main limits without division by main velocity',()=>{
    for(const v of [-1e-12,0,1e-12]){
      const q=prhrExchange(basis,hot,cold,.5,v,-v,v,800)
      expect(Math.abs(q.shear_Pa)).toBeLessThan(1e-12)
      expect(Math.abs(q.mainReactionForce_N)).toBeLessThan(1e-20)
      expect(Number.isFinite(q.entropyProduction_W_K)).toBe(true)
    }
  })
  test('rejects malformed physical boundaries rather than silently defaulting',()=>{
    const text='```reference-prhr-exchange\n'+JSON.stringify(basis)+'\n```'
    expect(parsePrhrExchange(text)).toEqual(basis)
    expect(()=>parsePrhrExchange(text+'\n'+text)).toThrow()
    for(const bad of [{initialCoreFraction:1},{initialCoreFraction:0},{rise_m:12},{mixingCoefficient:-1},{turbulentPrandtl:0}])expect(()=>prhrExchange({...basis,...bad},hot,cold,.5,0,0,0,800)).toThrow()
    expect(()=>prhrExchange(basis,{...hot,temperature_K:0},cold,.5,0,0,0,800)).toThrow()
    expect(()=>prhrExchange(basis,hot,cold,.5,NaN,0,0,800)).toThrow()
    for(const eta of [0,1,NaN])expect(()=>prhrExchange(basis,hot,cold,eta,0,0,0,800)).toThrow()
  })
})
