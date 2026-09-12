import {expect,test} from 'bun:test'
import {parseDistributedFuelInput} from './reference-design-distributed-fuel'
import {fuelGeometry,parseFuelConstruction} from './reference-design-fuel-construction'

const basis={design:'LD-01-fresh-fuel-reference',assemblies:193,latticeSide:17,rodsPerAssembly:264,
  guidesPerAssembly:25,pitch_m:.0126,rodOuterDiameter_m:.0095,cladThickness_m:.00057,
  pelletDiameter_m:.0082,guideOuterDiameter_m:.0122,activeLength_m:4,plenumLength_m:.25,
  fillPressure_Pa:2e6,referenceTemperature_K:300,fuelDensityFraction:.95,fuelTheoreticalDensity_kg_m3:10960,
  cladDensity_kg_m3:6551,power_W:3e9,coolantPressures_MPa:[15.2,15.1,15],coolantTemperatures_K:[563.15,578.15,593.15]}
const doc='```reference-fuel-construction\n'+JSON.stringify(basis)+'\n```'
const sample=(half:0|1)=>({half,referenceLength_m:2,heat_W:1.5e9,p_Pa:15e6,T_K:570+half*15,rho_kg_m3:720-half*30,z_m:half*2-1})
const fixture=()=>({accepted:true,sourceSha256:'a'.repeat(64),calculationSha256:'b'.repeat(64),inputSha256:'c'.repeat(64),
  coreGeometry:fuelGeometry(parseFuelConstruction(doc)),coreActiveLength_m:4,result:{
  coreFlow_kg_s:18000,sourceHalfHeat_W:[1.5e9,1.5e9],coreFaces:[{T_K:563},{T_K:578},{T_K:593}],
  coreThermalQuadrature:{'2':[sample(0),sample(1)],'4':[sample(0),sample(1)],'8':[sample(0),sample(1)]}}})
test('steady spatial handoff carries actual heat and reference length, not outlet-only material slices',()=>{
  const out=parseDistributedFuelInput(doc,fixture())
  expect(out.primary.result.coreFlow_kg_s).toBe(18000)
  expect(out.geometry.fuelMass_kg).toBeGreaterThan(100000)
  expect(out.primary.result.coreThermalQuadrature['8'][0]!.T_K).toBe(570)
})
test('invalid or incomplete upstream evidence cannot become a new fuel reference',()=>{
  for(const mutate of [
    (a:ReturnType<typeof fixture>)=>{a.accepted=false},
    (a:ReturnType<typeof fixture>)=>{a.sourceSha256=''},
    (a:ReturnType<typeof fixture>)=>{a.sourceSha256='x'.repeat(64)},
    (a:ReturnType<typeof fixture>)=>{a.coreGeometry.rods+=1},
    (a:ReturnType<typeof fixture>)=>{a.coreActiveLength_m=5},
    (a:ReturnType<typeof fixture>)=>{a.result.sourceHalfHeat_W[0]=a.result.sourceHalfHeat_W[0]!+1},
    (a:ReturnType<typeof fixture>)=>{a.result.coreFlow_kg_s=0},
    (a:ReturnType<typeof fixture>)=>{a.result.coreThermalQuadrature['4'][0]!.referenceLength_m=1.9},
    (a:ReturnType<typeof fixture>)=>{a.result.coreThermalQuadrature['2'][1]!.heat_W+=1},
    (a:ReturnType<typeof fixture>)=>{a.result.coreThermalQuadrature['8'].reverse()},
    (a:ReturnType<typeof fixture>)=>{a.result.coreThermalQuadrature['8'][0]!.T_K=NaN},
  ]) {const bad=fixture();mutate(bad);expect(()=>parseDistributedFuelInput(doc,bad)).toThrow()}
})
