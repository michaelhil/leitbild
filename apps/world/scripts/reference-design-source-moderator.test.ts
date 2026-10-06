import {describe,expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {compileModeratorInputs,nativeModeratorFixture,parseConfigurationModerator} from './reference-design-source-moderator'
// Boundary fixtures only; these are not a second LD-01 coefficient library.
const seven=Array(7).fill(1),matrix=Array.from({length:7},()=>Array(7).fill(.01)),
 material={units:'cm^-1',fuel:{absorption:seven,fission:Array(7).fill(.1),nu:Array(7).fill(2.4),chi:[1,0,0,0,0,0,0],scatter:matrix},
  water:{absorption:seven,scatter:matrix}},
 kinetics={energies_eV:[2e6,7e5,1e3,1,.25,.05,.0253],neutronMass_kg:1.67492749804e-27,
  delayedFractions:[.00021,.00142,.00127,.00257,.00075,.00027],halfLives_s:[55.7,22.7,6.2,2.3,.61,.23],fD:1},
 response={referenceDensity_kg_m3:1000,boron10:{referenceCrossSection_barn:3835,referenceEnergy_eV:.0253,captureGroups:[3,4,5,6,7]},
  captureEmission_MeV:{water:{charged:0,photon:2.2245662},boron10:{charged:2.34274,photon:.45026}}},
 block=(name:string,value:unknown)=>'```'+name+'\n'+JSON.stringify(value)+'\n```\n',
 document=block('reference-configuration-material',material)+block('reference-configuration-kinetics',kinetics)+block('reference-configuration-water-response',response),
 region={id:'R',compartment:'ACTIVE',volume_m3:1,envelopeLength_m:1,box:{x0:0,x1:1,y0:0,y1:1},z0_m:0,z1_m:1},
 partition={result:{regions:[region]}},sha=(s:string)=>createHash('sha256').update(s).digest('hex'),
 amount={volume_m3:.25,water_kg:250,Htarget:1e25,HcaptureProduct:0,mobileN10:1e22},
 water={passed:true,partitionSHA256:sha(JSON.stringify(partition.result)),result:{preparation:'ORIGINAL cold2000 IF97 primary source support',
  sourceIncidence:[{owner:'PRIMARY',sourceRegionId:'R',amount}],nativeOwners:[{owner:'PRIMARY',represented:amount}]}}
describe('actual primary moderator/mobile compilation',()=>{
 test('one shared SI table, group speed and capture emission authority',()=>{
  const r=parseConfigurationModerator(document)
  expect(r.law.absorption[0]).toBe(100);expect(r.law.scatter[0]![1]).toBe(1)
  expect(r.law.boron_sigma.slice(0,2)).toEqual([0,0])
  expect(r.law.boron_sigma[6]!/3835e-28).toBeCloseTo(1,14)
  expect(r.law.boron_sigma[2]!/(3835e-28*Math.sqrt(.0253/1000))).toBeCloseTo(1,14)
  expect(r.law.hydrogen_emission[0]).toBe(0)
  expect(r.law.hydrogen_emission[1]).toBe(2.2245662*1.602176634e-13)
  expect(r.law.boron_emission[0]).toBe(2.34274*1.602176634e-13)
 })
 test('actual retained native stocks, source lineage and liquid cold preparation',()=>{
  const r=compileModeratorInputs(partition,water,parseConfigurationModerator(document))
  expect(r.stocks[0]).toEqual({water_mass:250,liquid_volume:.25,hydrogen_target:1e25,hydrogen_product:0,mobile_boron10:1e22})
  expect(r.completeReactorOperator).toBe(false);expect(r.emissionIsDepositedHeat).toBe(false)
  expect(r.missingPhysicalContributions.length).toBeGreaterThan(0)
  expect(r.counts).toEqual({regions:1,nativeOwners:1,intersections:1,neutronCoordinates:7})
  expect(nativeModeratorFixture(r).trim().split(/\s+/).every(v=>Number.isFinite(Number(v)))).toBe(true)
 })
 test('ambiguous/invalid selected response fails, never falls back to hardcoded constants',()=>{
  expect(()=>parseConfigurationModerator(document+block('reference-configuration-water-response',response))).toThrow()
  expect(()=>parseConfigurationModerator(document.replace('"referenceDensity_kg_m3":1000','"referenceDensity_kg_m3":0'))).toThrow()
  expect(()=>parseConfigurationModerator(document.replace('"captureGroups":[3,4,5,6,7]','"captureGroups":[3,3]'))).toThrow()
  expect(()=>parseConfigurationModerator(document.replace('"referenceEnergy_eV":0.0253','"referenceEnergy_eV":0'))).toThrow()
 })
 test('missing, duplicated, wrong-region or unqualified native stock cannot normalize',()=>{
  const record=parseConfigurationModerator(document)
  expect(()=>compileModeratorInputs(partition,{...water,passed:false},record)).toThrow()
  expect(()=>compileModeratorInputs({...partition,result:{regions:[{...region,volume_m3:2}]}},water,record)).toThrow('lineage')
  expect(()=>compileModeratorInputs(partition,{...water,result:{...water.result,sourceIncidence:[]}},record)).toThrow('stock')
  expect(()=>compileModeratorInputs(partition,{...water,result:{...water.result,
   sourceIncidence:[...water.result.sourceIncidence,...water.result.sourceIncidence]}},record)).toThrow('duplicated')
  expect(()=>compileModeratorInputs(partition,{...water,result:{...water.result,
   sourceIncidence:[{owner:'UNKNOWN',sourceRegionId:'R',amount}]}},record)).toThrow()
  expect(()=>compileModeratorInputs(partition,{...water,result:{...water.result,
   sourceIncidence:[{owner:'PRIMARY',sourceRegionId:'UNKNOWN',amount}]}},record)).toThrow()
  expect(()=>compileModeratorInputs(partition,{...water,result:{...water.result,
   nativeOwners:[{owner:'PRIMARY',represented:{...amount,water_kg:300}}]}},record)).toThrow('stock')
  expect(()=>compileModeratorInputs(partition,{...water,result:{...water.result,
   sourceIncidence:[{owner:'PRIMARY',sourceRegionId:'R',amount:{...amount,water_kg:0}}]}},record)).toThrow()
 })
})
