import { expect, test } from 'bun:test'
import { parseTurning, turningExchange, turningParameters } from './reference-design-turning'
const basis={ratio:100,motorInertia_kg_m2:.5,motorDrag_Nm_per_rad_s:.10132118364233778,
  target_rpm:3,clutchTorque_Nm:15000,slipScale_rad_s:.02,driveGain_Nm_per_rad_s:10,
  driveTorqueLimit_Nm:120,efficiency:.95,energizedLoss_W:250,motorBudget_W:10000,
  bodyCapacity_J_K:1000000,oilConductance_W_K:1000,stroke_s:.5}
const owner='```reference-turning\n'+JSON.stringify(basis)+'\n```\n'
const shaft={inertia:445813.2080262862,drag:20.264236728467555}
test('strict turning record and actual finite steady slip',()=>{
  const b=parseTurning(owner),p=turningParameters(b,shaft),x=turningExchange(b,p.motorSpeed,p.shaftSpeed,1)
  expect(x.shaftTorque).toBeCloseTo(shaft.drag*p.shaftSpeed,8)
  expect(x.heat_W).toBeGreaterThan(0)
  expect(()=>parseTurning(owner+owner)).toThrow()
  expect(()=>turningParameters(parseTurning(owner.replace('15000','1')),shaft)).toThrow()
})
test('clutch is passive in backdrive, reversal and actual release',()=>{
  const b=parseTurning(owner)
  for (const motor of [-30,0,30]) for (const shaft of [-1,0,1,150]) {
    const x=turningExchange(b,motor,shaft,1)
    expect(x.heat_W).toBeGreaterThanOrEqual(0)
    expect(x.motorTorque*motor+x.shaftTorque*shaft+x.heat_W).toBeCloseTo(0,8)
  }
  expect(turningExchange(b,30,150,0).shaftTorque).toBeCloseTo(0,12)
  expect(()=>turningExchange(b,0,0,2)).toThrow()
})
