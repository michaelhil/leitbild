import {describe,expect,test} from 'bun:test'
import {parsePrhrMixing,prhrScalarMixing,prhrLiquidFilm,prhrLiquidPoolConvection,prhrDiscContactWeights,type MixingWater} from './reference-design-prhr-mixing'
const basis={coefficient:.01,turbulentPrandtl:.85,turbulentSchmidt:1,penetrationBores:1,preparedBank_C:[25,150] as [number,number]}
const geo={diameter_m:.5,length_m:11,rise_m:8.04,start_m:0,end_m:.5}
const water=(T:number,rho:number,c=0):MixingWater=>({temperature_K:T,density_kg_m3:rho,potentialDensity_kg_m3:rho,viscosity_Pas:.0002,cp_J_kgK:4300,conductivity_W_mK:.65,concentration:c})
describe('PRHR selected scalar mixing, not paired advective streams',()=>{
 test('strict consumed input and geometry',()=>{
  expect(parsePrhrMixing('```reference-prhr-mixing\n'+JSON.stringify(basis)+'\n```')).toEqual(basis)
  expect(()=>parsePrhrMixing('')).toThrow()
  expect(()=>prhrScalarMixing(basis,water(400,900),water(500,800),{...geo,end_m:12},0)).toThrow()
  expect(()=>prhrScalarMixing(basis,water(400,900,-.1),water(500,800),geo,0)).toThrow()
  expect(()=>prhrScalarMixing(basis,{...water(400,900),viscosity_Pas:0},water(500,800),geo,0)).toThrow()
 })
 test('finite viscous onset and inherited inertial limit, without a material-mixing floor',()=>{
  const a={...water(293.15,1000,1),viscosity_Pas:.001},lambda=32*.001/1000/geo.diameter_m
  const evaluate=(contrast:number)=>prhrScalarMixing(basis,a,{...a,potentialDensity_kg_m3:1000+contrast,concentration:0},geo,0)
  expect(evaluate(0).equivalentScalarTurnover_kg_s).toBe(0)
  // A small representable density contrast resolves the linear viscous branch.
  const contrast=1e-8,c=evaluate(contrast),rho=(2000+contrast)/2
  const actualContrast=(1000+contrast)-1000,drive=9.80665*geo.diameter_m*actualContrast*geo.rise_m/geo.length_m/rho
  expect(c.buoyantVelocity_m_s**2+lambda*1000/rho*c.buoyantVelocity_m_s).toBeCloseTo(drive,20)
  expect(c.buoyantVelocity_m_s/(drive/(lambda*1000/rho))).toBeGreaterThan(.98)
  // The right-side scalar slope is finite even with a nonzero concentration contrast.
  const scalarSlope=basis.coefficient*geo.diameter_m*(Math.PI*geo.diameter_m**2/4)/(geo.end_m-geo.start_m)*9.80665*geo.diameter_m*geo.rise_m/geo.length_m/lambda
  expect(c.scalarFromAToC_kg_s/actualContrast/scalarSlope).toBeGreaterThan(.98)
  expect(c.scalarFromAToC_kg_s/actualContrast/scalarSlope).toBeLessThan(1)
  const high=evaluate(100),highDrive=9.80665*geo.diameter_m*100*geo.rise_m/geo.length_m/1050
  expect(high.buoyantVelocity_m_s/Math.sqrt(highDrive)).toBeGreaterThan(.999)
  expect(high.buoyantVelocity_m_s).toBeLessThan(Math.sqrt(highDrive))
  const viscous=prhrScalarMixing(basis,{...a,viscosity_Pas:.002},{...a,viscosity_Pas:.002,potentialDensity_kg_m3:1000+contrast,concentration:0},geo,0)
  expect(viscous.buoyantVelocity_m_s).toBeLessThan(c.buoyantVelocity_m_s)
 })
 test('molecular heat remains, stable stratification has no buoyant mixing',()=>{
  const r=prhrScalarMixing(basis,water(400,900,1),water(500,800),geo,0)
  expect(r.eddyDiffusivity_m2_s).toBe(0);expect(r.equivalentScalarTurnover_kg_s).toBe(0)
  expect(r.heatFromAToC_W).toBeLessThan(0);expect(r.thermalEntropyProduction_W_K).toBeGreaterThan(0)
  const unstable=prhrScalarMixing(basis,water(500,800,1),water(400,900),geo,0)
  expect(unstable.buoyantVelocity_m_s).toBeGreaterThan(0);expect(unstable.scalarFromAToC_kg_s).toBeGreaterThan(0)
 })
 test('main reversal symmetric; actual thermal reversal and equal temperature respected',()=>{
  const a=water(400,900,1),b=water(500,800)
  expect(prhrScalarMixing(basis,a,b,geo,10)).toEqual(prhrScalarMixing(basis,a,b,geo,-10))
  const equalT=prhrScalarMixing(basis,water(400,900,1),{...water(400,950),potentialDensity_kg_m3:900},geo,10)
  expect(equalT.heatFromAToC_W).toBe(0);expect(equalT.buoyantVelocity_m_s).toBe(0)
  expect(equalT.scalarFromAToC_kg_s).toBeGreaterThan(0)
  const reversed=prhrScalarMixing(basis,b,a,{...geo,rise_m:-geo.rise_m},0)
  const forward=prhrScalarMixing(basis,a,b,geo,0)
  expect(reversed.heatFromAToC_W).toBe(-forward.heatFromAToC_W)
 })
 test('forced penetration average is geometry-integrated, not a nodal coefficient',()=>{
  const a=water(400,900),b=water(400,900)
  const all=prhrScalarMixing(basis,a,b,{...geo,start_m:0,end_m:11},10)
  const left=prhrScalarMixing(basis,a,b,{...geo,start_m:0,end_m:.5},10)
  const right=prhrScalarMixing(basis,a,b,{...geo,start_m:.5,end_m:11},10)
  expect(left.forcedPenetrationMean*.5+right.forcedPenetrationMean*10.5).toBeCloseTo(all.forcedPenetrationMean*11,14)
  expect(all.thermalConductance_W_K).toBeGreaterThan(0)
 })
 test('signed water and pool contacts do not suppress reverse heat or add equal-temperature heat',()=>{
  const w={density_kg_m3:900,viscosity_Pas:.0002,conductivity_W_mK:.65,cp_J_kgK:4300,expansion_K_1:.001}
  for(const v of[0,1,-1,100]){
   const cool=prhrLiquidFilm(w,w,w,.5,v,423,422),warm=prhrLiquidFilm(w,w,w,.5,v,422,423)
   expect(cool.heatFluxFromWater_W_m2).toBe(-warm.heatFluxFromWater_W_m2)
   expect(cool.h_W_m2K).toBeGreaterThan(0)
   expect(prhrLiquidFilm(w,w,w,.5,v,423,423).heatFluxFromWater_W_m2).toBe(0)
  }
  expect(prhrLiquidFilm(w,w,w,.5,100,423,422).highReExtrapolation).toBe(true)
  expect(prhrLiquidPoolConvection(w,.06,301,300,.5)).toBe(-prhrLiquidPoolConvection(w,.06,300,301,.5))
  expect(prhrLiquidPoolConvection(w,.06,300,300,.5)).toBe(0)
  for(const x of[0,.25,.5,1]){
   const weights=prhrDiscContactWeights(x)
   expect(weights.upstreamMaterialFace.reduce((a,b)=>a+b)).toBe(1)
   expect(weights.downstreamMaterialFace.reduce((a,b)=>a+b)).toBe(1)
  }
  expect(prhrDiscContactWeights(0).upstreamMaterialFace).toEqual([1,0])
  expect(prhrDiscContactWeights(1).upstreamMaterialFace).toEqual([.5,.5])
 })
})
