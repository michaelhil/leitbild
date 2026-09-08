import { expect,test } from 'bun:test'
import { allocateLoss,inletScales,oldTraceProjection,parseInletBasis } from './reference-design-cmt-inlet.ts'

const basis={pipeDiameter_m:.2,slotRadius_m:.5,slotGap_m:.05,slotElevation_m:11.9,tankTop_m:12,
  tankArea_m2:10,topProbeElevation_m:11.25,referenceFlow_kg_s:25,totalReferenceLoss_Pa:2000,exitLossCoefficient:1}
const doc=(b:unknown)=>'```reference-cmt-inlet\n'+JSON.stringify(b)+'\n```'
test('inlet geometry is strict, finite and fits below roof above existing probe',()=>{
  expect(parseInletBasis(doc(basis))).toEqual(basis)
  for(const b of [{...basis,slotElevation_m:12},{...basis,slotGap_m:0},{...basis,mixingRate:.1},
    {...basis,slotRadius_m:2},{...basis,tankArea_m2:Infinity}])expect(()=>parseInletBasis(doc(b))).toThrow()
})
test('density matching and zero or reverse flow do not manufacture penetration',()=>{
  expect(inletScales(25,750,750,.1,.05).inertialBuoyancyLength_m).toBeNull()
  expect(inletScales(0,750,1000,.1,.05).signedRichardson).toBeNull()
  expect(inletScales(-25,750,1000,.1,.05).direction).toBe('outflow')
  expect(inletScales(25,1000,750,.1,.05).buoyancy).toBe('denser_inlet')
  expect(()=>inletScales(25,0,1000,.1,.05)).toThrow()
})
test('momentum/area and inertial/buoyancy identities use actual numeric states',()=>{
  const a=inletScales(25,750,1000,.1,.05),b=inletScales(25,750,1000,.2,.05)
  expect(a.velocity_m_s).toBeCloseTo(1/3,12)
  expect(a.reducedGravity_m_s2).toBeCloseTo(2.4516625,12)
  expect(a.dynamicHead_Pa).toBeCloseTo(41.666666667,8)
  expect(b.inertialBuoyancyLength_m! / a.inertialBuoyancyLength_m!).toBeCloseTo(.25,12)
  expect(a.densimetricFroude!**2*a.signedRichardson!).toBeCloseTo(1,12)
})
test('loss budget is allocated once and cannot have negative remaining line loss',()=>{
  const a=allocateLoss(750,25,.1,1,2000)
  expect(a.exitReferenceLoss_Pa+a.remainingLineReferenceLoss_Pa).toBe(2000)
  expect(()=>allocateLoss(750,25,.001,1,2000)).toThrow()
  expect(()=>allocateLoss(750,25,.1,1,a.exitReferenceLoss_Pa)).toThrow()
})
test('historical comparison removes only the five new output fields',()=>{
  expect(oldTraceProjection([{t_s:0,balanceToTankFlow_kg_s:1,balanceDensity_kg_m3:750,topCellDensity_kg_m3:1000,
    tankInletMass_kg:2,inletStateVolume_m3:.1,inletFlow_kg_s:3}])).toEqual([{t_s:0,inletFlow_kg_s:3}])
})
