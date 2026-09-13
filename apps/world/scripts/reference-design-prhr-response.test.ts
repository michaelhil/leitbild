import {expect,test} from 'bun:test'
import {responseRates,settledExchange,responseCase} from './reference-design-prhr-response'
const b={diameter_m:.5,length_m:11,rise_m:8.04,roughness_m:.000015,initialCoreFraction:.5,mixingCoefficient:.01,turbulentPrandtl:.85,entranceCoefficient:.1}
// Explicit fixed-property fixtures, not an admitted thermal preparation.
const c={temperature_K:560,density_kg_m3:750,viscosity_Pas:.0001,conductivity_W_mK:.6,cp_J_kgK:5000}
const a={temperature_K:300,density_kg_m3:990,viscosity_Pas:.0008,conductivity_W_mK:.6,cp_J_kgK:4200}
test('unequal-density mass pairing exposes rather than hides missing work',()=>{
  for(const q of [-100,0,100])for(const main of [0,9.8]){
    const r=responseRates(b,c,a,q,main)
    const defect=r.kineticCoefficient*q*r.qdot-(r.buoyantWork_W+r.teeWork_W-r.dissipation_W)
    expect(Math.abs(defect-r.missingProjectedWork_W)).toBeLessThan(1e-8)
    if(q!==0){expect(Math.abs(r.netVolume_m3_s)).toBeGreaterThan(0);expect(Math.abs(r.missingProjectedWork_W)).toBeGreaterThan(0)}
  }
})
test('equal-density rest and finite-motion limiting case need no invented work',()=>{
  expect(Math.abs(settledExchange(b,c,c,0))).toBeLessThan(1e-12)
  for(const q of [-100,0,100])expect(Math.abs(responseRates(b,c,c,q,9.8).missingProjectedWork_W)).toBe(0)
  const result=responseCase(b,c,c,.01)
  expect(result.maximumUnclosedWorkResidual_J).toBeLessThan(1e-6)
  expect(result.atIntervention_kg_s).toBeGreaterThan(0)
  expect(result.finalFlow_kg_s).toBeGreaterThan(0)
  expect(result.first5sGrossMass_kg).toBeLessThan(result.instantaneousFirst5sGrossMass_kg)
})
test('prescribed intervention must be exactly resolved in this reference',()=>{
  expect(()=>responseCase(b,c,a,.003)).toThrow()
})
