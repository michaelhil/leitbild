import { expect,test } from 'bun:test'
import { backflowBrakingTorque, parseHydraulicBasis, signedLiquidPump } from './reference-design-hydraulics.ts'
const basis={design:'LD-01' as const,gravity_m_s2:9.80665,coreInlet_m:-2,coreMid_m:0,coreOutlet_m:2,
  hotPort_m:2.5,SGturn_m:12,coldPort_m:3,SGInlet_MPaAbs:14.95,coldReturn_MPaAbs:15.2,pumpRpm:1500,pumpShapeFraction:.2}
const doc=(v:unknown)=>'```reference-hydraulics\n'+JSON.stringify(v)+'\n```\n'
test('hydraulic input keeps port and exchanger height distinct',()=>{
  expect(parseHydraulicBasis(doc(basis))).toEqual(basis)
  for(const change of [{hotPort_m:12},{SGturn_m:2},{coreMid_m:3},{pumpShapeFraction:1},{gravity_m_s2:0},{extra:'expression'}])
    expect(()=>parseHydraulicBasis(doc({...basis,...change}))).toThrow()
  expect(()=>parseHydraulicBasis(doc(basis)+doc(basis))).toThrow()
})
test('signed liquid pump preserves nominal law but starts and brakes in the physical direction',()=>{
  const rho=900,a=.01,b=2,R=5000
  for(const q of [-.1,.1])for(const omega of [-300,-1e-8,0,1e-8,300]){
    const x=signedLiquidPump(rho,q,omega,a,b,R)
    expect(x.power).toBeCloseTo(q*x.euler+x.brakePower,7)
    expect(x.brakePower).toBeGreaterThanOrEqual(0)
    expect(q*x.loss).toBeGreaterThanOrEqual(0)
    if(omega===0)expect(Math.sign(-x.torque)).toBe(Math.sign(q))
    if(q<0&&omega>0)expect(x.torque).toBeGreaterThanOrEqual(0)
    if(q>0&&omega<0)expect(x.power).toBeGreaterThan(0)
  }
  const nominal=signedLiquidPump(rho,.1,300,a,b,R)
  expect(nominal.exchangeTorque).toBe(rho*.1*(a*300-b*.1))
  expect(nominal.brakePower).toBe(0)
  expect(signedLiquidPump(rho,0,300,a,b,R).power).toBe(0)
  expect(()=>backflowBrakingTorque(NaN,1,1)).toThrow()
})
