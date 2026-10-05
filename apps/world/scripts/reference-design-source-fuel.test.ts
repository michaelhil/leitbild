import {describe,expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {compileFuelInputs,nativeFuelFixture,parseConfigurationFuel} from './reference-design-source-fuel'
//Test-only schema/boundary fixtures, not a physical LD-01 coefficient library.
const table={units:'cm^-1',fuel:{absorption:[2,3,4,5,6,7,8],fission:[1,.5,.5,.5,.5,.5,.5],nu:[2.4,2.4,2.4,2.4,2.4,2.4,2.4],
 chi:[.6,.4001,0,0,0,0,0],scatter:Array.from({length:7},(_,g)=>Array.from({length:7},(_,h)=>g===h?.1:.03))},
 water:{absorption:[1,1,1,1,1,1,1],scatter:Array.from({length:7},()=>Array(7).fill(.1))}},
 kinetics={energies_eV:[2e6,7e5,1e3,1,.25,.05,.0253],neutronMass_kg:1.67492749804e-27,
 delayedFractions:[.00021,.00142,.00127,.00257,.00075,.00027],halfLives_s:[55.7,22.7,6.2,2.3,.61,.23],fD:1},
 fresh={u235HeavyMassFraction:.045,u235MolarMass_kg_mol:.2350439299,u238MolarMass_kg_mol:.2380507884,oxygenMolarMass_kg_mol:.015999}
const block=(name:string,value:unknown)=>'```'+name+'\n'+JSON.stringify(value)+'\n```\n',
 document=block('reference-configuration-material',table)+block('reference-configuration-kinetics',kinetics)
  +block('reference-configuration-added-material',{freshFuel:fresh,steel304:{unconsumed:'not validated as current material by this fuel component'}}),
 region={id:'R',compartment:'ACTIVE',volume_m3:1,envelopeLength_m:1,box:{x0:0,x1:1,y0:0,y1:1},z0_m:0,z1_m:1},
 partition={result:{regions:[region]}},sha=(s:string)=>createHash('sha256').update(s).digest('hex'),
 material={partitionIdentitySHA256:sha(JSON.stringify(partition.result)),result:{preparation:'ORIGINAL fresh seated cold300K',
  segments:[{id:'S',referenceFuelMass_kg:10}],
  cohorts:[{id:'Q0',segmentId:'S',material:'fuel',referenceMass_kg:4,original_K:300,mu:.4},
   {id:'Q1',segmentId:'S',material:'fuel',referenceMass_kg:6,original_K:300,mu:.6}],
  fissionIncidence:[{segmentId:'S',sourceRegionId:'R',compositeVolume_m3:.01,delayedBirthShare:1}],
  heatIncidence:[{cohortId:'Q0',segmentId:'S',sourceRegionId:'R',W_kg:4,eta:.4},{cohortId:'Q1',segmentId:'S',sourceRegionId:'R',W_kg:6,eta:.6}]}}
describe('owned fuel component compilation',()=>{
 test('SI conversion, rounded spectrum and six physical delayed groups have one current authority',()=>{
  const r=parseConfigurationFuel(document)
  expect(r.law.absorption[0]).toBe(200);expect(r.law.fission[0]).toBe(100)
  expect(r.law.scatter[0]![1]).toBe(3);expect(r.originalChiSum).toBe(1.0001)
  expect(r.law.chi.reduce((a,b)=>a+b,0)).toBeCloseTo(1,14)
  expect(r.law.chi[0]).toBeCloseTo(.6/1.0001,14)
  expect(r.law.beta.reduce((a,b)=>a+b,0)).toBeCloseTo(.00649,14)
  expect(r.law.decay[0]).toBeCloseTo(Math.LN2/55.7,14)
  expect(r.law.speed[0]).toBeCloseTo(Math.sqrt(2*2e6*1.602176634e-19/kinetics.neutronMass_kg),5)
 })
 test('real input shape retains immutable physical stocks and explicit missing reactor contributions',()=>{
  const r=compileFuelInputs(partition,material,parseConfigurationFuel(document),1.2e-11)
  expect(r.completeReactorOperator).toBe(false);expect(r.missingPhysicalContributions.length).toBeGreaterThan(0)
  expect(r.counts).toEqual({regions:1,segments:1,fuelCohorts:2,intersections:1,neutronCoordinates:7,precursorCoordinates:6})
  expect(r.cohorts.map(q=>q.mu)).toEqual([.4,.6]);expect(r.intersections[0]!.weights.map(q=>q.mass)).toEqual([4,6])
  expect(r.stocks[0]!.reserve).toBe(r.stocks[0]!.reference_reserve)
  expect(r.stocks[0]!.fertile).toBe(r.stocks[0]!.reference_fertile)
  const MU=1/(fresh.u235HeavyMassFraction/fresh.u235MolarMass_kg_mol+(1-fresh.u235HeavyMassFraction)/fresh.u238MolarMass_kg_mol),
   heavy=10*MU/(MU+2*fresh.oxygenMolarMass_kg_mol)
  expect(r.stocks[0]!.reserve).toBeCloseTo(heavy*fresh.u235HeavyMassFraction/fresh.u235MolarMass_kg_mol*6.02214076e23,-9)
  expect(nativeFuelFixture(r).trim().split(/\s+/).every(v=>Number.isFinite(Number(v)))).toBe(true)
 })
 test('unknown, historical-only, invalid termination and ambiguous records fail visibly',()=>{
  expect(()=>parseConfigurationFuel(document+block('reference-configuration-kinetics',kinetics))).toThrow()
  expect(()=>parseConfigurationFuel(document.replace('"fD":1','"fD":1,"generationTime_s":.00002'))).toThrow()
  expect(()=>parseConfigurationFuel(document.replace('reference-configuration-kinetics','reference-source-feedback'))).toThrow()
  expect(()=>parseConfigurationFuel(document.replace('"absorption":[2,3','"absorption":[0,3'))).toThrow()
  expect(()=>parseConfigurationFuel(document.replace('"u235HeavyMassFraction":0.045','"u235HeavyMassFraction":1'))).toThrow()
 })
 test('lineage, missing coverage, missing W/mu and wrong thermal/stock identities do not get normalized',()=>{
  const law=parseConfigurationFuel(document)
  expect(()=>compileFuelInputs({...partition,result:{regions:[{...region,volume_m3:2}]}},material,law,1)).toThrow('lineage')
  expect(()=>compileFuelInputs(partition,{...material,result:{...material.result,
   fissionIncidence:[{...material.result.fissionIncidence[0],delayedBirthShare:.5}]}},law,1)).toThrow('coverage')
  expect(()=>compileFuelInputs(partition,{...material,result:{...material.result,heatIncidence:[]}},law,1)).toThrow('thermal')
  expect(()=>compileFuelInputs(partition,{...material,result:{...material.result,
   cohorts:material.result.cohorts.map(q=>({...q,mu:undefined}))}},law,1)).toThrow('share')
  expect(()=>compileFuelInputs(partition,{...material,result:{...material.result,
   segments:[{id:'S',referenceFuelMass_kg:12}]}},law,1)).toThrow('mass mismatch')
  expect(()=>compileFuelInputs(partition,material,law,0)).toThrow('charge')
  expect(()=>compileFuelInputs(partition,{...material,result:{...material.result,
   heatIncidence:material.result.heatIncidence.map((w,i)=>i===0?{...w,eta:.5}:w)}},law,1)).toThrow('eta')
  expect(()=>compileFuelInputs(partition,{...material,result:{...material.result,
   heatIncidence:[...material.result.heatIncidence,{...material.result.heatIncidence[0],sourceRegionId:'unknown'}]}},law,1)).toThrow('Missing')
  const other={result:{regions:[region,{...region,id:'R1'}]}},
   orphan={...material,partitionIdentitySHA256:sha(JSON.stringify(other.result)),result:{...material.result,
    heatIncidence:[...material.result.heatIncidence,{...material.result.heatIncidence[0],sourceRegionId:'R1',eta:1}]}}
  expect(()=>compileFuelInputs(other,orphan,law,1)).toThrow('Orphan')
 })
})
