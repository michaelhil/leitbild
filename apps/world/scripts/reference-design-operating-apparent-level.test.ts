import {expect,test} from 'bun:test'
import {composeApparentLevel} from './reference-design-operating-apparent-level'

// Test-only shapes in the form the composer reads; not plant evidence.
const section={scope:'C08',distribution:{nominalSubmergedVolume_m3:12,nominalPressure_Pa:6e6,nominalSteamFlow_kg_s:819.778818,
  maximumSubmergedVolume_m3:24,distributionTime_s:2,preparedDistribution:.25},
  indication:{indicatedLevelArea_m2:12,nrSpan_m:[4,9] as [number,number],nrLag_s:.5},provenance:{sourceSha256:'x',consumed:[]}}
const stock=(id:string,liquid=72)=>({id,pressure_pa:6.36314e6,liquid_volume_m3:liquid,volume_m3:120,mass_kg:1,energy_j:1})
const packet=(liquid=72)=>({scope:'Joined.',thermal:{secondaries:[stock('A',liquid),stock('B',liquid)]},
  secondary:{steamGenerators:[{id:'A'},{id:'B'}],relief:{},provenance:{}},provenance:{}})

test('the section is added as secondary.apparentLevel and nothing else changes but the scope',()=>{
  const input=packet(),out=composeApparentLevel(input,section as never)
  expect(out.secondary.apparentLevel).toEqual(section)
  const {apparentLevel,...rest}=out.secondary
  expect(rest).toEqual(input.secondary)
  expect(out.thermal).toEqual(input.thermal)
  expect(out.scope).toBe('Joined. With the C08 compact apparent level (one vapor-distribution state per SG) composed.')
  expect(input.secondary).not.toHaveProperty('apparentLevel')
})

test('a second composition, other SG stocks or a prepared gas volume off the balance refuse',()=>{
  expect(()=>composeApparentLevel(composeApparentLevel(packet(),section as never),section as never)).toThrow('already composes')
  expect(()=>composeApparentLevel(packet(70),section as never)).toThrow('submerged volume')
  const swapped={...packet(),thermal:{secondaries:[stock('B'),stock('A')]}}
  expect(()=>composeApparentLevel(swapped,section as never)).toThrow('follow the secondary section')
})
