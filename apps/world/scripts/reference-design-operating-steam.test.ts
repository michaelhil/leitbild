import {expect,test} from 'bun:test'
import {generatorParameters,parseGenerator} from './reference-design-generator'
import {parseBypassControl as parseBypass} from './reference-design-bypass'
import {compileOperatingSteam,parseC12Circulating,preparedMachinePhasor,parseCondenser,parseCondenserProtection,parseGovernor,parseMsrDrains,parseNoncondensables,parseSteamActuators,
  parseReceivers,parseSteamPreparation,parseSteamStocks,prepareOperatingSteam,steamOwners} from './reference-design-operating-steam'

// Test-only owner texts in the shapes the compiler reads; the values are the
// blocks' current values, used here only to exercise the parsers.
const fence=(name:string,value:unknown)=>'```'+name+'\n'+JSON.stringify(value)+'\n```'
const blocks={
  stocks:{header_m3:120,hpAdmission_m3:10,hpExtraction_m3:20,separator_m3:100,reheaterProcess_m3:30,reheaterShell_m3:20,lpFirst_m3:500,
    lpSecond_m3:1000,reheaterWall_J_K:200000000,separatorArea_m2:5,separatorPickup_m3:[20,22.5],drainPickupFraction:0.05},
  preparation:{mainSteamLoss_Pa:20000,stopAdmissionLoss_Pa:20000,stopAdmissionShare:0.5,hpExtraction_Pa:4000000,
    separator_Pa:800000,separatorLiquid_m3:10,reheaterProcess_Pa:800000,reheaterProcess_C:260,lpFirst_Pa:200000,lpSecond_Pa:50000,
    reheaterShellPressureFactor:0.995,reheaterShellLiquid_m3:5,separatorReheaterSizing:{flow_kg_s:978.730519,inlet_Pa:800000,outlet_Pa:796000,cdA_m2:5.382216},
    preparedOpen:['MS.ISO.A','MS.ISO.B','TG.STOP','TG.ADM','TG.RH.ISO'],preparedClosed:['TG.BYP'],preparedDrainOpening:0.5},
  drains:{separatorDrain:{bias:0.5,gain_per_m:0.25,setpoint_m:2,sample_s:0.1,travel_s:2,sizingOpening:0.5},
    separatorEmergencyDrain:{travel_s:2,prepared:'CLOSED'},
    reheaterDrain:{bias:0.5,gain:2,target:0.25,sample_s:0.1,travelRate_per_s:0.2,sizingOpening:0.5}},
  actuators:{isolationMotion_W:100,openingMotion_W:100,springStockShare:0.5,holding_W:20,controllerElectronics_W:20,drainMotion_W:100,drainElectronics_W:20,
    groups:{'MS.ISO.A':'ACT.A','MS.ISO.B':'ACT.B','TG.STOP':'ACT.B','TG.ADM':'ACT.B','TG.RH.ISO':'ACT.B','TG.BYP':'ACT.B','TG.SEP.DRAIN':'ACT.A','TG.SEP.EMERGENCY':'ACT.A','TG.RH.DRAIN':'ACT.B'},
    springReturn:['TG.STOP','TG.ADM','TG.RH.ISO','TG.BYP'],retainOnSupplyLoss:['MS.ISO.A','MS.ISO.B','TG.SEP.DRAIN','TG.SEP.EMERGENCY','TG.RH.DRAIN']},
  governor:{sample_s:0.1,droop:0.05,setpointRamp_per_s:0.1,proportional:0.5,integral_per_s:0.2,base_W:1100000000,overspeed_pu:1.1},
  bypass:{bandStart_Pa:6050000,bandFull_Pa:6350000,sample_s:0.1,availableBelow_Pa:12000,headerEvidenceAge_s:0.5,
    rating:{fractionOfTotalSteam:0.5,inletPressure_Pa:6000000,fluid:'saturatedVapor',outlet:'nominalCondenser'}},
  protection:{backpressureTrip_Pa:15000,backpressurePersistence_s:0.2,unavailableTrip_s:0.5,resetBelow_Pa:10000,resetHold_s:1,
    channel:{rangeMin_Pa:0,rangeMax_Pa:50000,lag_s:0.2,sample_s:0.1,transport_s:0.1,maxAge_s:0.5}},
  condenser:{shell_m3:6000,liquid_m3:1000,vapor_m3:5000,prepared_C:40,hotwellArea_m2:200,surface_m:0,pumpEye_m:-5,manifold_m:1,manifoldCovered_m3:1200,
    wallCapacity_J_K:500000000,waterCell_m3:250,cellPrepared_C:[25.084435688,30.084435688],wallPrepared_C:[32.542217844,35.042217844],
    cellDuty_W:1000669817,condensing_C:40,sizingDensity_kg_m3:1000,sizingCp_J_kgK:4180,cellElevation_m:5,historicalCellOverAtmosphere_Pa:[225000,75000],preparedPort:{cwFlow_kg_s:47878.938608,cwInlet_C:20.084436}},
  gases:{air:{gasConstant_J_kgK:287,cv_J_kgK:718},nitrogen:{gasConstant_J_kgK:296.8,cv_J_kgK:742},energyReference_K:298.15},
} as const
type Name=keyof typeof blocks
const parsers:Record<Name,(t:string)=>unknown>={stocks:parseSteamStocks,preparation:parseSteamPreparation,drains:parseMsrDrains,
  governor:parseGovernor,bypass:parseBypass,protection:parseCondenserProtection,condenser:parseCondenser,gases:parseNoncondensables,actuators:parseSteamActuators}
const page=(name:Name,value:unknown,heading:string=steamOwners[name].heading)=>
  `# Owner\n\n## Compact operating allocation (15 October 2026)\n\nText.\n\n### ${heading}\n\n${fence(steamOwners[name].fence,value)}\n\n## Next\n`
const pageFor=(name:Name,value:unknown)=>steamOwners[name].heading==='Strict blocks'?page(name,value)
  :`# Owner\n\n## ${steamOwners[name].heading}\n\nText.\n\n${fence(steamOwners[name].fence,value)}\n\n## Next\n`
/** Every leaf path of a block, for the missing-value sweep. */
const leaves=(v:unknown,path:string[]=[]):string[][]=>v!==null&&typeof v==='object'&&!Array.isArray(v)
  ?Object.entries(v as object).flatMap(([k,x])=>leaves(x,[...path,k])):[path]
const without=(v:unknown,path:string[]):unknown=>{
  const copy=structuredClone(v) as Record<string,unknown>
  let node=copy
  for(const k of path.slice(0,-1))node=node[k] as Record<string,unknown>
  delete node[path.at(-1)!]
  return copy
}

test('each C10 block parses strictly from its owning section only',()=>{
  for(const name of Object.keys(blocks) as Name[]){
    expect(parsers[name](pageFor(name,blocks[name]))).toEqual(blocks[name] as never)
    expect(()=>parsers[name](pageFor(name,blocks[name])+fence(steamOwners[name].fence,blocks[name]))).toThrow('Expected one')
    expect(()=>parsers[name](pageFor(name,{...blocks[name],extra:1}))).toThrow()
    expect(()=>parsers[name](`# Owner\n\n## Elsewhere\n\n${fence(steamOwners[name].fence,blocks[name])}\n`)).toThrow()
  }
})

test('the compiler input refuses every missing value, at every depth',()=>{
  let refused=0
  for(const name of Object.keys(blocks) as Name[])
    for(const path of leaves(blocks[name])){
      expect(()=>parsers[name](pageFor(name,without(blocks[name],path)))).toThrow()
      refused++
    }
  expect(refused).toBe(116)
  expect(()=>parseReceivers({h2Shell_Pa:199000,source:'x'})).toThrow()
})

test('the noncondensable constants reproduce the condenser owner\'s 50 kg air + 50 kg N2 illustration at 40 °C',()=>{
  // condenser-and-cooling.md#retained-noncondensables-and-vacuum-recovery: "With 50 kg air and 50 kg nitrogen,
  // pressure falls from 9.2131 ..." at 40 °C in the 6000 m³ shell with 5000 m³ shared gas; psat(40 °C) is the cycle's.
  const g=parseNoncondensables(pageFor('gases',blocks.gases)),psat=0.0073844274870695295e6,T=313.15,Vg=5000
  const p=psat+(50*g.air.gasConstant_J_kgK+50*g.nitrogen.gasConstant_J_kgK)*T/Vg
  expect(Math.abs(p-9213.1)/9213.1).toBeLessThan(1e-4)
})

test('inconsistent values refuse rather than being repaired',()=>{
  expect(()=>parseSteamStocks(pageFor('stocks',{...blocks.stocks,separatorPickup_m3:[22.5,20]}))).toThrow('ordered')
  expect(()=>parseBypass(pageFor('bypass',{...blocks.bypass,bandFull_Pa:6000000}))).toThrow('ordered')
  expect(()=>parseCondenserProtection(pageFor('protection',{...blocks.protection,resetBelow_Pa:20000}))).toThrow('ordered')
  expect(()=>parseGovernor(pageFor('governor',{...blocks.governor,overspeed_pu:0.9}))).toThrow()
  expect(()=>parseSteamActuators(pageFor('actuators',{...blocks.actuators,springReturn:['TG.STOP','TG.ADM','TG.RH.ISO']}))).toThrow('exactly one')
  expect(()=>parseSteamActuators(pageFor('actuators',{...blocks.actuators,retainOnSupplyLoss:[...blocks.actuators.retainOnSupplyLoss,'TG.BYP']}))).toThrow('exactly one')
})

// The actual cycle calculation output (reference-cycle through runCycle, iapws 1.5.5), only the fields the compiler reads.
const cycle={inputSha256:'fixture',calculationSha256:'fixture',
  basis:{highBleedPressure_MPaAbs:4,separatorPressure_MPaAbs:0.8,lowBleedPressure_MPaAbs:0.2,lowestBleedPressure_MPaAbs:0.05,reheatOutlet_C:260,
    condensate_C:40,HPTurbineEfficiency:0.85,LPTurbineEfficiency:0.88,shaftMechanicalEfficiency:0.995},
  points:{main_steam:{h_kJ_kg:2784.561732103704,p_MPaAbs:6},HP_bleed:{h_kJ_kg:2718.509920711288,p_MPaAbs:4},HP_separator_inlet:{h_kJ_kg:2478.3610261949816,p_MPaAbs:0.8},
    LP_reheat_inlet:{h_kJ_kg:2972.0219105659444,p_MPaAbs:0.8},LP_bleed:{h_kJ_kg:2722.248447069538,p_MPaAbs:0.2},LP_lowest_bleed:{h_kJ_kg:2521.6393144237654,p_MPaAbs:0.05},
    LP_exhaust:{h_kJ_kg:2288.6220826457743,p_MPaAbs:0.0073844274870695295},condenser_liquid:{h_kJ_kg:167.5410472587315,p_MPaAbs:0.0073844274870695295}},
  flows:{SG_total_kg_s:1639.6379652662608,SG_each_kg_s:819.8189826331304,reheat_fraction:0.07741378197751048,high_heater_fraction:0.16981876127034656,
    separator_heater_fraction:0.04924002070293842,low_heater_fraction:0.036269360215151855,lowest_heater_fraction:0.022874688155052947,
    separator_drain_fraction:0.10660876241214139,LP_inlet_fraction:0.5969186736370632,LP_exhaust_fraction:0.5377746252668585,condenser_drains_fraction:0.4622253747331417},
  powers_MW:{turbine_thermodynamic_work:1030.6622174330623},
} as never
const texts={turbine:`# T\n\n## Compact operating allocation (15 October 2026)\n\n### Strict blocks\n\n`+
    (['stocks','preparation','drains','governor'] as const).map(n=>fence(steamOwners[n].fence,blocks[n])).join('\n\n')+'\n',
  admission:`# A\n\n## Compact operating allocation (15 October 2026)\n\n${fence('ld01-bypass-control',blocks.bypass)}\n\n${fence('ld01-condenser-protection',blocks.protection)}\n\n${fence('ld01-steam-actuators',blocks.actuators)}\n\n`+
    `## Flow law and nominal sizing\n\n${fence('ld01-steam-valve-travel',{sgIsolation_s:2,turbineStop_s:0.3,reheaterIsolation_s:0.3,admission_s:1,bypass_s:2})}\n`,
  condenser:`# C\n\n## Compact operating allocation (15 October 2026)\n\n${fence('ld01-condenser',blocks.condenser)}\n\n${fence('ld01-noncondensable-gases',blocks.gases)}\n`,
  shaft:`# S\n\n## Rotor and loss connection\n\n${fence('ld01-shaft-drag',{dragPowerAtReference_W:500000,referenceSpeed_rpm:1500})}\n`,
  casing:fence('reference-turbine-preparation',{hpCapacity_J_K:30000000,lpCapacity_J_K:150000000,hpContact_W_K:50000,lpContact_W_K:100000,roomContact_W_K:100,
    drainCdA_m2:0.0005,drainStroke_s:2,drainMotion_W:100,warmDifference_K:30,warmDuration_s:30,maximumLiquidFraction:0.01}),
  hot:fence('reference-operating-hot',{primaryPressure_Pa:15200000,achievedRodTravel_m:2.8,boronReference_ppmEq:1000,preparedBoron_ppmEq:1000,
    gapAccommodationReferenceTemperature_K:650,sgSecondaryPressure_Pa:6363140,initialLoopMassflow_kg_s:0,sgMetalSegments:4}),
  generator:fence('reference-generator',{lineVoltage_V:10000,frequency_Hz:50,polePairs:2,base_VA:1100000000,referenceShaft_W:1025508905.915,
    sizingConversion:0.985,reactance_pu:1.5,fieldCurrent_A:2000,fieldCopper_W:500000,inductanceMargin:2,fieldDump_Ohm:2,shaftInertia_s:5})}
const receivers={h1Shell_Pa:49750,h2Shell_Pa:199000,h4Shell_Pa:3980000,source:'FIXTURE: 0.995 × (0.05/0.2/4) MPa from the turbine page preparation table, pending C09 block (A5)'}
// C12's receipt fields the compiler reads (support-zero-time-84623576f values), test-only.
const c12=parseC12Circulating({packetSha256:'86b60014fc2dbc362c2e2e0276f44a7b56742ebc3c6a264161fca49ba9055ea0',
  circulating:{headerResidualHead_Pa:299749.31579280586,condenser_kg_s:47858.930271037636,inletTotalEnthalpy_J_kg:84411.84954784776},
  provenance:{compiledPacket:{s5:{constants:{atmosphere_Pa:101325}}}}})

test('the compiled packet re-anchors D2, reproduces the arms and discloses the bypass band conflict',()=>{
  const p=compileOperatingSteam(texts,cycle,receivers,c12)
  expect(p.census).toEqual({differential:45,algebraic:19})
  expect(p.prepared.header_Pa).toBe(6343140)
  expect(p.prepared.admission_Pa).toBe(6323140)
  expect(p.prepared.junction_Pa).toBe(6333140)
  expect(p.prepared.reheaterShell_Pa).toBeCloseTo(0.995*6343140,6)
  // the shaft page's selected equivalent arms, to their printed precision
  const arms=p.branches.filter(b=>b.law==='interval').map(b=>(b as {radius_m:number}).radius_m)
  arms.forEach((r,k)=>expect(r).toBeCloseTo([1.254867953,2.392742470,2.398263717,2.149310395,2.316422680][k]!,8))
  expect(p.disclosed.bypassBandConflict).toBe(true)
  expect(p.disclosed.bypassBandDemandAtPreparation).toBeCloseTo((6343140-6050000)/300000,12)
  expect(p.condenser.walls[0]!.shellConductance_W_K).toBeCloseTo(2*1000669817/(40-25.084435688),3)
  expect(p.stores).toHaveLength(9)
  // the owner's equal split with C12's prepared head (C12 port P9)
  expect(p.condenser.cells[0]!.pressure_Pa).toBeCloseTo(326136.98684460437,6)
  expect(p.condenser.cells[1]!.pressure_Pa).toBeCloseTo(176262.32894820147,6)
  expect(p.condenser.c12Port.cwFlow_kg_s).toBe(47858.930271037636)
})

test('the compiler refuses an inconsistent cross-owner value',()=>{
  const moved={...texts,turbine:texts.turbine.replace('"hpExtraction_Pa":4000000','"hpExtraction_Pa":4100000')}
  expect(()=>compileOperatingSteam(moved,cycle,receivers,c12)).toThrow('differs from the cycle')
  const wall={...texts,condenser:texts.condenser.replace('32.542217844','32.6')}
  expect(()=>compileOperatingSteam(wall,cycle,receivers,c12)).toThrow('halfway')
  expect(()=>compileOperatingSteam(texts,cycle,{...receivers,h4Shell_Pa:7e6},c12)).toThrow('below their donors')
  // The SG pressure comes from its one numeric owner: a C10 copy is refused as an extra key.
  expect(()=>compileOperatingSteam({...texts,turbine:texts.turbine.replace('{"mainSteamLoss_Pa"','{"sgPrepared_Pa":6363140,"mainSteamLoss_Pa"')},cycle,receivers,c12)).toThrow()
  expect(compileOperatingSteam({...texts,hot:texts.hot.replace('6363140','6400000')},cycle,receivers,c12).prepared.header_Pa).toBe(6380000)
  const unlisted={...texts,turbine:texts.turbine.replace('"preparedClosed":["TG.BYP"]','"preparedClosed":[]')}
  expect(()=>compileOperatingSteam(unlisted,cycle,receivers,c12)).toThrow('exactly once')
})

const wiki=process.env.LD01_STEAM_WIKI_ROOT,python=process.env.LD01_RESEARCH_PYTHON,archive=process.env.LD01_WIKI_ROOT
test.skipIf(!wiki||!python)('the actual owner pages compile; the cycle reproduces the selected arms',async()=>{
  const p=await prepareOperatingSteam(wiki!,python!,receivers,c12Receipt)
  expect(p.census).toEqual({differential:45,algebraic:19})
  expect(p.provenance.consumed).toHaveLength(8)
  expect(p.disclosed.bypassBandConflict).toBe(true)
},120000)
test.skipIf(!archive||!python)('the archived wiki refuses: its C10 numbers are still prose there',async()=>{
  await expect(prepareOperatingSteam(archive!,python!,receivers,c12Receipt)).rejects.toThrow('Expected')
},120000)

test('S4-D7: the prepared phasor is the owner\'s sizing phasor at referenceShaft and balances the turbine elsewhere',()=>{
  const basis=parseGenerator(texts.generator),g=generatorParameters(basis)
  const hw={lineVoltage_V:basis.lineVoltage_V,frequency_Hz:basis.frequency_Hz,resistance:g.resistance,statorInductance:g.statorInductance,
    mutual:g.mutual,fieldInductance:g.fieldInductance,fieldResistance:g.fieldResistance}
  // at the sizing shaft power: the owner's phasor exactly (angle, linkages, 2000 A, 250 V)
  const s0=preparedMachinePhasor(hw,basis.referenceShaft_W)
  expect(s0.fieldCurrent_A).toBeCloseTo(2000,9)
  expect(s0.fieldDemand_V).toBeCloseTo(250,9)
  expect(s0.angle_rad).toBeCloseTo(g.angle,12)
  s0.initialFlux.forEach((f,k)=>expect(Math.abs(f-g.initialFlux[k]!)).toBeLessThan(1e-12*Math.abs(g.initialFlux[k]!)+1e-15))
  // at the prototype's prepared net shaft power: the dq law (as in generatorCalculation) is steady and the torque balances
  const P=1037302510.3165614,s1=preparedMachinePhasor(hw,P)
  const V=basis.lineVoltage_V,p=basis.polePairs,we=2*Math.PI*basis.frequency_Hz,w0=we/p,{statorInductance:Ls,mutual:M,fieldInductance:Lf,resistance:Rs,fieldResistance:Rf}=g
  const D=Ls*Lf-M*M,[ld,lq,lf]=s1.initialFlux as [number,number,number],id=(Lf*ld-M*lf)/D,iq=lq/Ls,ifl=(Ls*lf-M*ld)/D
  const vd=V*Math.cos(s1.angle_rad),vq=-V*Math.sin(s1.angle_rad)
  const rates=[vd-Rs*id+p*w0*lq,vq-Rs*iq-p*w0*ld,s1.fieldDemand_V-Rf*ifl]
  rates.forEach(r=>expect(Math.abs(r)).toBeLessThan(1e-6))
  expect(Math.abs(P+p*M*ifl*iq*w0)/P).toBeLessThan(1e-12)
  expect(s1.fieldCurrent_A).toBeCloseTo(2014.829285841,6)
  expect(s1.export_W/1e6).toBeCloseTo(1021.5693815,4)
})

const c12Receipt={packetSha256:'86b60014fc2dbc362c2e2e0276f44a7b56742ebc3c6a264161fca49ba9055ea0',circulating:{headerResidualHead_Pa:299749.31579280586,condenser_kg_s:47858.930271037636,inletTotalEnthalpy_J_kg:84411.84954784776},provenance:{compiledPacket:{s5:{constants:{atmosphere_Pa:101325}}}}}
test('C12\'s port refuses a receipt without its prepared head',()=>{
  expect(()=>parseC12Circulating({...c12Receipt,circulating:{condenser_kg_s:1,inletTotalEnthalpy_J_kg:1}})).toThrow()
})
