import { expect,test } from 'bun:test'
import { parseConnectedFuel } from './reference-design-connected-fuel.ts'
const fuel={design:'LD-01-fresh-fuel-reference',assemblies:193,latticeSide:17,rodsPerAssembly:264,guidesPerAssembly:25,
  pitch_m:.0126,rodOuterDiameter_m:.0095,cladThickness_m:.00057,pelletDiameter_m:.0082,guideOuterDiameter_m:.0122,
  activeLength_m:4,plenumLength_m:.25,fillPressure_Pa:2e6,referenceTemperature_K:300,fuelDensityFraction:.95,
  fuelTheoreticalDensity_kg_m3:10960,cladDensity_kg_m3:6551,power_W:3e9,coolantPressures_MPa:[15.2,15.1,15],coolantTemperatures_K:[563.15,578.15,593.15]}
const record={gridPositions_m:[.25,.75,1.25,1.75,2.25,2.75,3.25,3.75],blockageFraction:.35,gridLossFactor:1,inletLoss:.5,outletLoss:1}
const doc=(tag:string,v:unknown)=>'```'+tag+'\n'+JSON.stringify(v)+'\n```\n'
const fd=doc('reference-fuel-construction',fuel)
test('connected core derives geometry and validates real grid positions',()=>{
  const p=parseConnectedFuel(doc('reference-connected-fuel',record),fd)
  expect(p.geometry.coreFlowVolume_m3).toBeCloseTo(18.71812568411146,10)
  expect(p.gridsPerHalf).toBe(4)
  for(const c of [{blockageFraction:1},{gridLossFactor:0},{gridPositions_m:[.25,2]},
    {gridPositions_m:[.25,.25,2.25,2.75]},{gridPositions_m:[.25,.75,2.25]},
    {gridPositions_m:[.25,4.25]},{extra:'equations'}])
    expect(()=>parseConnectedFuel(doc('reference-connected-fuel',{...record,...c}),fd)).toThrow()
})
