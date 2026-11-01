import {expect,test} from 'bun:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {bypassNoLoad,compileOperatingSecondary,compileSgProbe,parseSgBoundaries,parseSgRelief,parseSteamValveTravel,
  prepareOperatingSecondary,prepareSgProbe,probePages,sectionPages} from './reference-design-operating-sg'

// Test-only owner texts in the shapes the compiler reads; not plant evidence.
const fence=(name:string,value:unknown)=>'```'+name+'\n'+JSON.stringify(value)+'\n```'
const relief:ReturnType<typeof parseSgRelief>={valves:[{role:'relief',crackPressure_Pa:7947559,fullLiftPressure_Pa:8147559,reseatPressure_Pa:7747559},
  {role:'safety',crackPressure_Pa:8271613,fullLiftPressure_Pa:8595666,reseatPressure_Pa:8071613}],designPressure_Pa:8273709,liftLag_s:.1,seatLagTimeConstants:10,
  backPressure_Pa:101325,descendingSwitch:'inletAtFullLift',
  rating:{fractionOfNominalFlow:.6,nominalFlow_kg_s:819.818983,fluid:'saturatedVapor',inletPressure_Pa:7000000}}
const travel={sgIsolation_s:2,turbineStop_s:.3,reheaterIsolation_s:.3,admission_s:1,bypass_s:2}
const noLoad={mode:'noLoadPressureAfterTurbineTrip',noLoadAverageTemperature_K:564.816667,noLoadPressure_Pa:7623997}
const control={bandStart_Pa:6413140,bandFull_Pa:6713140,sample_s:.1,availableBelow_Pa:12000,headerEvidenceAge_s:.5,
  rating:{fractionOfTotalSteam:.5,inletPressure_Pa:6000000,fluid:'saturatedVapor',outlet:'nominalCondenser'}}
const admission=(r:unknown=relief,t:unknown=travel)=>'# Admission\n\n## Flow law and nominal sizing\n\n'+fence('ld01-steam-valve-travel',t)
  +'\n\n## Normal control and bypass\n\nText.\n\n'+fence('ld01-bypass-no-load',noLoad)
  +'\n\n## Turbine trip and reset semantics\n\n'+fence('ld01-sg-relief',r)
  +'\n\n## Compact operating allocation (15 October 2026)\n\n'+fence('ld01-bypass-control',control)+'\n\n## Required verification and evidence\n'
const boundaries={steamDemand_kg_s:{A:819.9495,B:819.9455},steamDonor:'pickupGas',feedRule:'inventoryHolding'} as const

test('relief, travel and S2 boundaries parse from their owners only, strictly',()=>{
  expect(parseSgRelief(admission())).toEqual(relief)
  expect(parseSteamValveTravel(admission()).turbineStop_s).toBe(.3)
  const edit=(from:string,to:string)=>admission().replace(from,to)
  expect(()=>parseSgRelief(edit('"reseatPressure_Pa":7747559','"reseatPressure_Pa":7990000'))).toThrow('reseat')
  // R12-B2: order, roles, design pressure and 110 %.
  expect(()=>parseSgRelief(edit('"role":"relief"','"role":"safety"'))).toThrow('One relief')
  expect(()=>parseSgRelief(edit('"designPressure_Pa":8273709','"designPressure_Pa":8000000'))).toThrow()
  expect(()=>parseSgRelief(edit('"fullLiftPressure_Pa":8595666','"fullLiftPressure_Pa":9200000'))).toThrow('110%')
  expect(()=>parseSgRelief(edit('"inletAtFullLift"','"holdLiftOnReversal"'))).toThrow()
  expect(()=>parseSgRelief(edit('"liftLag_s":0.1','"liftLag_s":0.1,"area_m2":0.05'))).toThrow()
  expect(()=>parseSgRelief(edit('## Turbine trip and reset semantics','## Elsewhere'))).toThrow()
  expect(()=>parseSgRelief(admission()+'\n'+fence('ld01-sg-relief',relief))).toThrow()
  expect(()=>parseSteamValveTravel(edit('"turbineStop_s":0.3','"turbineStop_s":0'))).toThrow()
  expect(()=>parseSgRelief(edit('"seatLagTimeConstants":10,',''))).toThrow()
  // R12-B1: the no-load mode takes its band width and rating fraction from ld01-bypass-control.
  expect(bypassNoLoad(admission())).toEqual({mode:'noLoadPressureAfterTurbineTrip',noLoadAverageTemperature_K:564.816667,
    noLoadPressure_Pa:7623997,bandWidth_Pa:300000,fractionOfNominalSteam:.5})
  expect(()=>bypassNoLoad(edit('"mode":"noLoadPressureAfterTurbineTrip"','"mode":"atPowerBand"'))).toThrow()
  expect(()=>bypassNoLoad(edit('## Normal control and bypass','## Elsewhere'))).toThrow()
  const thermo='## Emergent full-power SG pressure\n\n'+fence('ld01-s2-sg-boundaries',boundaries)+'\n\n## Next\n'
  expect(parseSgBoundaries(thermo)).toEqual(boundaries)
  expect(()=>parseSgBoundaries(thermo.replace('"pickupGas"','"bulkMixture"'))).toThrow()
  expect(()=>parseSgBoundaries(thermo.replace('"inventoryHolding"','"fcvManual"'))).toThrow()
  expect(()=>parseSgBoundaries(thermo.replace(',"B":819.9455',''))).toThrow()
})

const wiki=process.env.LD01_WIKI_ROOT
// X4.5 geometry refit (wiki 54a078e, steam-generation/index.md's refit table): the compiled values at rt-integ-wiki fb3756a.
test.skipIf(!wiki)('actual secondary and probe sections compile once; corrupted owners fail',async()=>{
  const section=await prepareOperatingSecondary(wiki!),probe=await prepareSgProbe(wiki!,{A:9167.294305,B:9167.309151})
  expect(section.steamGenerators.map(g=>[g.id,g.steamDemand_kg_s,g.crownLiquidVolume_m3,g.pickupLiquidVolume_m3,g.reliefs.length]))
    .toEqual([['A',819.9495,54.01939830602499,127.37427330602499,2],['B',819.9455,54.01939830602499,127.37427330602499,2]])
  expect(section.feed).toEqual({rule:'inventoryHolding',pressure_Pa:7200000,temperature_K:493.15})
  expect(section.steamAdmission).toEqual({stopTravel_s:.3})
  expect(section.relief.seatLagTimeConstants).toBe(10)
  expect(section.contact).toEqual({tubeCount:8807,tubeOutsideDiameter_m:.0174752,tubeInsideDiameter_m:.0154432,foulingResistance_m2K_W:.0000158499,emissivity:.3,steelConductivity_W_mK:15,steelDensity_kg_m3:8000,steelCp_J_kgK:500,exchangeArea_m2:9670.078943833776})
  expect(section.exposure).toEqual({fold:{developedLength_m:20,inlet_m:2.5,crest_m:12,outlet_m:3},bundleZoneVolume_m3:54.01939830602498,upperZoneArea_m2:14.670975})
  expect(probe.tube).toEqual({thermalDiameter_m:.0154432})
  expect(section.relief.rating.massFlow_kg_s).toBeCloseTo(561.1185020,6)
  expect(section.provenance.consumed.map(c=>c.name.split('ld-01/')[1])).toEqual([...sectionPages])
  expect(probe.primary).toEqual({pressure_Pa:15200000,temperature_K:563.15,inletTemperature_K:593.15,flowArea_m2:1.649652499862129,massFlow_kg_s:[9167.294305,9167.309151]})
  expect(probe.segments.map(g=>[g.developedStart_m,g.developedEnd_m,g.exchangeArea_m2,g.capacity_J_K]))
    .toEqual([[0,5,2417.519735958444,37.5e6],[5,10,2417.519735958444,37.5e6],[10,15,2417.519735958444,37.5e6],[15,20,2417.519735958444,37.5e6]])
  expect(probe.provenance.consumed.map(c=>c.name.split('ld-01/')[1])).toEqual([...probePages])
  const base=join(wiki!,'world/packs/process-plant/reference-designs/ld-01'),
    read=(p:string)=>Bun.file(join(base,p)).text(),
    [thermodynamics,admissionDoc,balance,cycle,hydraulics,mechanics]=await Promise.all(sectionPages.map(read))
  const sources={thermodynamics:thermodynamics!,admission:admissionDoc!,balance:balance!,cycle:cycle!,hydraulics:hydraulics!,mechanics:mechanics!}
  expect(compileOperatingSecondary(sources)).toEqual({...section,provenance:undefined} as never)
  for(const [key,from,to] of [
    ['thermodynamics','"upperZoneArea_m2":14.670975','"upperZoneArea_m2":20'],
    ['thermodynamics','"upperZoneArea_m2":14.670975','"upperZoneArea_m2":14.670975,"horizontalArea_m2":7.5'],
    ['thermodynamics','"pickupBottom_m":17','"pickupBottom_m":19'],
    ['thermodynamics','"crownTop_m":12','"crownTop_m":16.5'],
    ['thermodynamics','"feedRule":"inventoryHolding"','"feedRule":"inventoryHolding","extra":1'],
    ['admission','"designPressure_Pa":8273709','"designPressure_Pa":8000000'],
    ['hydraulics','"hotPort_m":2.5','"hotPort_m":2.0'],
    ['hydraulics','"SGturn_m":12','"SGturn_m":12.5'],
    ['mechanics','"sgDevelopedLength_m":20.0','"sgDevelopedLength_m":40.0'],
  ] as const){
    const text=sources[key]
    expect(text.includes(from)).toBe(true)
    expect(()=>compileOperatingSecondary({...sources,[key]:text.replace(from,to)})).toThrow()
  }
  // The native opt-in tests, built explicitly with maintained properties.
  const tests=process.env.LD01_OPERATING_SG_TESTS
  if(tests){
    const temporary=await mkdtemp(join(tmpdir(),'ld01-sg-'))
    try{
      const s=join(temporary,'secondary.json'),p=join(temporary,'probe.json')
      await Bun.write(s,JSON.stringify(section));await Bun.write(p,JSON.stringify(probe))
      for(const native of tests.split(':')){
        const child=Bun.spawn([native,'--ignored','--nocapture','--test-threads','1'],{
            env:{...process.env,LD01_OPERATING_SG_SECTION:s,LD01_OPERATING_SG_PROBE:p,LD01_OPERATING_SG_Z2_OUT:join(temporary,'z2.json')},
            stdout:'pipe',stderr:'pipe'}),
          [output,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
        if(code!==0)throw Error(error+output)
        expect(output).toContain('test result: ok');console.log(error.trim())
      }
    }finally{await rm(temporary,{recursive:true,force:true})}
  }
},600000)

test('probe compile refuses nonpositive flows',()=>{
  expect(()=>compileSgProbe({thermodynamics:'',balance:'',hot:'',mechanics:''},{A:0,B:1})).toThrow('Positive primary flows')
})
