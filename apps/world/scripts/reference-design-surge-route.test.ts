import { expect, test } from 'bun:test'
import { logDarcyFactor, parseSurgeRoute, resolveSurgeRoute, routeElevation, routeLoss, surgeRoutePython } from './reference-design-surge-route'
const value = { source: 'LD01.HOT.A', receiver: 'LD01.PZR', sourceElevation_m: 2.5, receiverElevation_m: 6.5,
  developedLength_m: 16, firstStraight_m: 6, bendRadius_m: .45, internalDiameter_m: .3, wallThickness_m: .025,
  steelDensity_kg_m3: 7920, roughness_m: 1.5e-6, entryLoss: .5, elbowLoss: .2, exitLoss: 1 }
const block = (v: unknown) => '```reference-surge-route\n'+JSON.stringify(v)+'\n```\n'
const r = resolveSurgeRoute(parseSurgeRoute(block(value)))
test('one explicit route; impossible or unowned geometry is rejected', () => {
  expect(() => parseSurgeRoute(block(value)+block(value))).toThrow()
  for (const v of [{...value, unknown: 1}, {...value, developedLength_m: 5}, {...value, receiverElevation_m: 2.5}, {...value, bendRadius_m: .1}])
    expect(() => parseSurgeRoute(block(v))).toThrow()
})
test('route length, inventory, endpoint and gravitational datum agree', () => {
  expect(r.lengths_m.reduce((a,b)=>a+b,0)).toBeCloseTo(16,12)
  expect(r.endpoint_m[0]).toBeCloseTo(6.45,12)
  expect(r.endpoint_m[1]).toBeCloseTo(5.93628330588459,12)
  expect(routeElevation(r,0)).toBe(2.5)
  expect(routeElevation(r,16)).toBeCloseTo(6.5,12)
  expect(r.liquidVolume_m3).toBeCloseTo(Math.PI*.3**2/4*16,12)
  let sum=0
  const n=100000
  for(let i=0;i<n;i++) sum+=routeElevation(r,(i+.5)*16/n)/n
  expect(sum).toBeCloseTo(r.volumeMeanElevation_m,8)
  expect(() => routeElevation(r,16.01)).toThrow()
})
test('Darcy conversion gives exact laminar Poiseuille limit and signed finite loss', () => {
  for(const re of [1e-10,1,100,1000]) expect(Math.exp(logDarcyFactor(re,0))*re).toBeCloseTo(64,8)
  const q=1e-4,rho=750,mu=1e-4, forward=routeLoss(r,q,rho,mu), reverse=routeLoss(r,-q,rho,mu)
  expect(forward.friction_Pa).toBeCloseTo(128*mu*16*q/(Math.PI*rho*.3**4),12)
  expect(reverse.total_Pa).toBe(-forward.total_Pa)
  expect(routeLoss(r,0,rho,mu).total_Pa).toBe(0)
  for(const re of [7,2000,4000,1e5,1e8]) expect(Number.isFinite(logDarcyFactor(re,0))).toBe(true)
  expect(Math.exp(logDarcyFactor(1e5,1e-4))).toBeGreaterThan(.018)
  expect(Math.exp(logDarcyFactor(1e5,1e-4))).toBeLessThan(.019)
})
test('offline Python scalar laws agree with TypeScript without a property dependency', async () => {
  const re=[1e-10,7,100,2000,4000,1e5,1e8], distances=[0,r.risingStart_m,r.risingStart_m+.3,r.verticalStart_m,16]
  const code='import math,json\n'+surgeRoutePython+'\nr='+JSON.stringify(r)+'\nprint(json.dumps([[log_darcy_factor(x,0) for x in '+JSON.stringify(re)+'],[route_elevation(r,x) for x in '+JSON.stringify(distances)+']]))'
  const proc=Bun.spawn(['python3','-c',code],{stdout:'pipe',stderr:'pipe'})
  const out=await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  const [friction,elevation]=JSON.parse(out)
  re.forEach((x,i)=>expect(friction[i]).toBeCloseTo(logDarcyFactor(x,0),12))
  distances.forEach((x,i)=>expect(elevation[i]).toBeCloseTo(routeElevation(r,x),12))
})
