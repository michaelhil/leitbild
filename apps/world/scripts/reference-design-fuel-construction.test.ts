import { expect,test } from 'bun:test'
import { parseFuelConstruction } from './reference-design-fuel-construction.ts'
const input:ReturnType<typeof parseFuelConstruction>={design:'LD-01-fresh-fuel-reference',assemblies:193,
  latticeSide:17,rodsPerAssembly:264,guidesPerAssembly:25,pitch_m:.0126,rodOuterDiameter_m:.0095,
  cladThickness_m:.00057,pelletDiameter_m:.0082,guideOuterDiameter_m:.0122,activeLength_m:4,
  plenumLength_m:.25,fillPressure_Pa:2e6,referenceTemperature_K:300,fuelDensityFraction:.95,
  fuelTheoreticalDensity_kg_m3:10960,cladDensity_kg_m3:6551,power_W:3e9,
  coolantPressures_MPa:[15.2,15.1,15],coolantTemperatures_K:[563.15,578.15,593.15]}
const doc=(v:unknown)=>'```reference-fuel-construction\n'+JSON.stringify(v)+'\n```\n'
test('fresh construction has explicit complete nonoverlapping geometry',()=>{
  expect(parseFuelConstruction(doc(input))).toEqual(input)
  for(const bad of ['',doc(input)+doc(input),doc({...input,extra:1}),doc({...input,pelletDiameter_m:.009}),
    doc({...input,guideOuterDiameter_m:.013}),doc({...input,rodOuterDiameter_m:.013}),
    doc({...input,guidesPerAssembly:24}),doc({...input,assemblies:0}),doc({...input,fillPressure_Pa:0}),
    doc({...input,coolantTemperatures_K:[590,580,600]}),doc({...input,fuelDensityFraction:.9})])
    expect(()=>parseFuelConstruction(bad)).toThrow()
})
