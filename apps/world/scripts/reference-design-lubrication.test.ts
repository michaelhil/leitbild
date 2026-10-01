import { expect, test } from 'bun:test'
import { lubricationParameters, parseLubrication } from './reference-design-lubrication'
import { signedLiquidPump } from './reference-design-hydraulics'
const basis = {density_kg_m3:850,heatCapacity_J_kg_K:2000,oilVolume_m3:3,coolerOilVolume_m3:.1,
  combinedCapacity_J_K:100000000,coolerConductance_W_K:5000000,waterVolume_m3:10,
  bearingResistance_Pa_s_m3:3750000,laminarPressureFraction:.2,viscosityReference_K:313.15,
  viscositySlope_K_inverse:.03,pumpSpeed_rad_s:157.07963267948966,shapeFraction:.2,
  mainFlow_m3_s:.08,standbyFlow_m3_s:.03,hydraulicEfficiency:.8,motorEfficiency:.95,
  mainDrag_W:500,standbyDrag_W:100,mainInertia_kg_m2:1,standbyInertia_kg_m2:.25,
  mainMotorBudget_W:50000,standbyMotorBudget_W:10000,mainDriveGain_N_m_per_rad_s:20,
  standbyDriveGain_N_m_per_rad_s:4,mainTorqueLimit_N_m:300,standbyTorqueLimit_N_m:60,
  mainEnergizedLoss_W:200,standbyEnergizedLoss_W:50}
const owner = '```reference-lubrication\n'+JSON.stringify(basis)+'\n```\n'
test('oil is carved from existing combined capacity, not added twice', () => {
  const b = parseLubrication(owner), p = lubricationParameters(b)
  expect(p.coolerCapacity).toBe(170000)
  expect(p.bulkCapacity+p.coolerCapacity).toBe(b.combinedCapacity_J_K)
  expect(p.main.dp).toBe(300000)
  expect(p.standby.dp).toBeCloseTo(56250,8)
  expect(() => parseLubrication(owner+owner)).toThrow()
})
test('same signed liquid pump work and finite nominal/shutoff torque', () => {
  const b = parseLubrication(owner), p = lubricationParameters(b)
  for (const a of [p.main,p.standby]) {
    const nominal = signedLiquidPump(b.density_kg_m3,a.flow,b.pumpSpeed_rad_s,a.a,a.beta,a.resistance)
    expect(nominal.rise).toBeCloseTo(a.dp,5)
    expect(nominal.power).toBeCloseTo(a.dp*a.flow/b.hydraulicEfficiency,5)
    const stopped = signedLiquidPump(b.density_kg_m3,0,b.pumpSpeed_rad_s,a.a,a.beta,a.resistance)
    expect(stopped.power).toBe(0)
    expect(stopped.rise).toBeGreaterThan(a.dp)
  }
})
