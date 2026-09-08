import { expect, test } from 'bun:test'
import { invertLiquid, liquidStorageJacobian } from './reference-design-properties.ts'

// Analytic compressible-liquid test equation, not a water model or runtime fallback.
// v = v0*(1 + a*(T-T0) - b*p); u follows a thermodynamically consistent Gibbs potential.
const analytic = (p: number, t: number) => {
  if (p <= 0 || p > 100e6 || t < 273.15 || t > 650) throw Error('Outside test equation domain')
  const v0=.001,a=.0003,b=5e-10,cp=4200,v=v0*(1+a*(t-300)-b*p)
  const u=cp*t+v0*(-a*t*p+b*p*p/2)
  return {rho:1/v,u,h:u+p*v,cp,alpha:v0*a/v,kappa:v0*b/v,mu:.001,k:.6}
}

test('storage Jacobian matches independent finite differences of a consistent EOS', () => {
  const p=15.5e6,t=573.15,dp=100,dt=.001,j=liquidStorageJacobian(p,t,analytic(p,t))
  const actual={rhoP:(analytic(p+dp,t).rho-analytic(p-dp,t).rho)/(2*dp),rhoT:(analytic(p,t+dt).rho-analytic(p,t-dt).rho)/(2*dt),
    uP:(analytic(p+dp,t).u-analytic(p-dp,t).u)/(2*dp),uT:(analytic(p,t+dt).u-analytic(p,t-dt).u)/(2*dt)}
  for(const key of Object.keys(j) as (keyof typeof j)[])expect(Math.abs(j[key]/actual[key]-1)).toBeLessThan(1e-6)
})

test('near-branch inversion recovers both pressure and temperature', () => {
  const target=analytic(15e6,550)
  const result=invertLiquid(analytic,target.rho,target.u,14e6,545)
  expect(Math.abs(result.p-15e6)).toBeLessThan(.01)
  expect(Math.abs(result.t-550)).toBeLessThan(1e-6)
  expect(result.iteration).toBeGreaterThan(0)
})

test('invalid or inadmissible inversions fail rather than clip into a plausible state', () => {
  expect(()=>invertLiquid(analytic,-1,1e6,15e6,550)).toThrow()
  expect(()=>invertLiquid(analytic,1,NaN,15e6,550)).toThrow()
  expect(()=>invertLiquid(analytic,100,1e8,15e6,550)).toThrow()
  expect(()=>liquidStorageJacobian(15e6,550,{...analytic(15e6,550),kappa:0})).toThrow()
})
