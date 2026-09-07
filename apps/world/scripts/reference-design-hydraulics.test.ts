import { expect,test } from 'bun:test'
import { parseHydraulicBasis } from './reference-design-hydraulics.ts'
const basis={design:'LD-01' as const,gravity_m_s2:9.80665,coreInlet_m:-2,coreMid_m:0,coreOutlet_m:2,
  hotPort_m:2.5,SGturn_m:12,coldPort_m:3,SGInlet_MPaAbs:14.95,coldReturn_MPaAbs:15.2,pumpRpm:1500,pumpShapeFraction:.2}
const doc=(v:unknown)=>'```reference-hydraulics\n'+JSON.stringify(v)+'\n```\n'
test('hydraulic input keeps port and exchanger height distinct',()=>{
  expect(parseHydraulicBasis(doc(basis))).toEqual(basis)
  for(const change of [{hotPort_m:12},{SGturn_m:2},{coreMid_m:3},{pumpShapeFraction:1},{gravity_m_s2:0},{extra:'expression'}])
    expect(()=>parseHydraulicBasis(doc({...basis,...change}))).toThrow()
  expect(()=>parseHydraulicBasis(doc(basis)+doc(basis))).toThrow()
})
