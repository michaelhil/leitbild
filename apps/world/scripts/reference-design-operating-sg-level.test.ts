import {expect,test} from 'bun:test'
import {join} from 'node:path'
import {compileSgApparentLevel,parseSgDistribution,prepareSgApparentLevel,sgLevelOwners,sgLevelPages} from './reference-design-operating-sg-level'

// Test-only owner texts in the shapes the compiler reads; not plant evidence.
const fence=(name:string,value:unknown)=>'```'+name+'\n'+JSON.stringify(value)+'\n```'
const distribution={maximumSubmergedVolume_m3:24,distributionTime_s:2,nominalSteamFlow_kg_s:819.778818}
const thermodynamics=(d:unknown=distribution,heading:string=sgLevelOwners.distribution.heading)=>
  '# SG\n\n## Apparent level is not liquid inventory\n\nText.\n\n### '+heading+'\n\n'+fence('ld01-sg-distribution',d)+'\n\n## Initial state and advancement\n'
const balanceBlock={design:'LD-01',reactorHeat_MW:3000,primaryPressure_MPaAbs:15,coreInlet_C:290,coreOutlet_C:320,steamGenerators:2,
  secondaryPressure_MPaAbs:6,feedInlet_C:220,feedSourcePressure_MPaAbs:.101325,feedSource_C:40,feedPumpDischarge_MPaAbs:7.4,
  feedPumpHydraulicEfficiency:.8,feedPumpMotorEfficiency:.96,secondaryVolume_m3:120,secondaryLiquidVolume_m3:72,
  submergedVaporVolume_m3:12,equivalentLevelArea_m2:12,wallCapacity_MJ_K:150}
const balance=(b:unknown=balanceBlock)=>'# Balance\n\n'+fence('reference-balance',b)+'\n'
const instrumentation=(area=12)=>'# SG\n\n## Selected channels\n\n'+fence('ld01-sg-level-channels',{nrLag_s:.5,nrSpan_m:[4,9],indicatedLevelArea_m2:area})+'\n'

test('the distribution block parses from its owning heading only, strictly',()=>{
  expect(parseSgDistribution(thermodynamics())).toEqual(distribution)
  expect(()=>parseSgDistribution(thermodynamics(distribution,'Elsewhere'))).toThrow()
  expect(()=>parseSgDistribution(thermodynamics({...distribution,residenceTime_s:.45}))).toThrow()
  expect(()=>parseSgDistribution(thermodynamics({...distribution,distributionTime_s:0}))).toThrow()
  expect(()=>parseSgDistribution(thermodynamics({maximumSubmergedVolume_m3:24,distributionTime_s:2}))).toThrow()
  expect(()=>parseSgDistribution(thermodynamics()+'\n'+fence('ld01-sg-distribution',distribution))).toThrow()
})

test('the section takes the nominal reference and prepared distribution from the balance, and one level area',()=>{
  const s=compileSgApparentLevel({thermodynamics:thermodynamics(),balance:balance(),instrumentation:instrumentation()})
  expect(s.distribution).toEqual({nominalSubmergedVolume_m3:12,nominalPressure_Pa:6e6,nominalSteamFlow_kg_s:819.778818,
    maximumSubmergedVolume_m3:24,distributionTime_s:2,preparedDistribution:.25})
  expect(s.indication).toEqual({indicatedLevelArea_m2:12,nrSpan_m:[4,9],nrLag_s:.5})
  expect(()=>compileSgApparentLevel({thermodynamics:thermodynamics(),balance:balance(),instrumentation:instrumentation(10)}))
    .toThrow('one equivalent indicated-level area')
  expect(()=>compileSgApparentLevel({thermodynamics:thermodynamics({...distribution,maximumSubmergedVolume_m3:10}),balance:balance(),
    instrumentation:instrumentation()})).toThrow('equilibrium bound')
})

const wiki=process.env.LD01_C08_WIKI_ROOT
test.skipIf(!wiki)('the actual owners compile once; corrupted owners fail',async()=>{
  const section=await prepareSgApparentLevel(wiki!)
  expect(section.distribution).toEqual({nominalSubmergedVolume_m3:12,nominalPressure_Pa:6e6,nominalSteamFlow_kg_s:819.778818,
    maximumSubmergedVolume_m3:24,distributionTime_s:2,preparedDistribution:.25})
  expect(section.indication).toEqual({indicatedLevelArea_m2:12,nrSpan_m:[4,9],nrLag_s:.5})
  expect(section.provenance.consumed.map(c=>c.name.split('ld-01/')[1])).toEqual([...sgLevelPages])
  const base=join(wiki!,'world/packs/process-plant/reference-designs/ld-01'),
    [thermo,bal,instr]=await Promise.all(sgLevelPages.map(p=>Bun.file(join(base,p)).text()))
  const sources={thermodynamics:thermo!,balance:bal!,instrumentation:instr!}
  expect(compileSgApparentLevel(sources)).toEqual({...section,provenance:undefined} as never)
  for(const [key,from,to] of [
    ['thermodynamics','"distributionTime_s":2','"distributionTime_s":-2'],
    ['thermodynamics','"maximumSubmergedVolume_m3":24','"maximumSubmergedVolume_m3":24,"residenceTime_s":0.45'],
    ['thermodynamics','### Compact apparent-level allocation (C08, 15 October 2026)','### Apparent-level allocation'],
    ['instrumentation','"indicatedLevelArea_m2":12','"indicatedLevelArea_m2":12.5'],
    ['balance','"submergedVaporVolume_m3": 12','"submergedVaporVolume_m3": 30'],
  ] as const){
    const text=sources[key]
    expect(text.includes(from)).toBe(true)
    expect(()=>compileSgApparentLevel({...sources,[key]:text.replace(from,to)})).toThrow()
  }
})
