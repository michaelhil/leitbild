import {expect,test} from 'bun:test'
import {compileFuelCooling,compileFuelCoolingMaterial,compilePrimaryIncidence,parseOperatingFuelGap,parseColdConditioningPreparation} from './reference-design-fuel-cooling'
import {compilePrimaryWaterGeometry,parsePrimaryWaterInputs,primaryWaterOwnerFiles} from './reference-design-source-water'
import {join} from 'node:path'
import {coolingCommonTimes,coolingStateHeader,coolingStatesComplete,coolingEventStatesComplete,coolingEnergyCoordinates,coolingMobileCapturePolicy,coolingMobileDevelopmentPolicy,coolingAbsorberGuidePolicy,absorberGuideAdmission,coolingActuationSupplyPolicy,actuationSupplyAdmission,fuelCoolingAdmission,fuelCoolingPriorSeconds,qualifyFuelCooling} from './reference-design-fuel-cooling-qualification'

test('event retention requires each arm and exact post-transaction time/coordinate inventory',()=>{
 const events={normal:{events:[{timeS:42.75},{timeS:47.75}]},tighter:{events:[{timeS:42.75},{timeS:47.75}]}},
  states=(['normal','tighter'] as const).flatMap(arm=>events[arm].events.map((e,i)=>({
   path:`/artifacts/input.${arm}.event-${i}.bin`,magic:'LDPTCM01',coordinates:7,time:e.timeS})))
 expect(coolingEventStatesComplete(states,7,events)).toBe(true)
 expect(coolingEventStatesComplete(states.slice(1),7,events)).toBe(false)
 expect(coolingEventStatesComplete([...states,states[0]!],7,events)).toBe(false)
 expect(coolingEventStatesComplete(states.map((s,i)=>i===0?{...s,time:42.74}:s),7,events)).toBe(false)
 expect(coolingEventStatesComplete(states,8,events)).toBe(false)
})

test('finite ACT evidence requires complete continued state, actual work and exact copied history',()=>{
 const point={timeS:300,energyJ:1832835,sourceJ:2608695.652174,deliveredJ:556200,prhrDeliveredJ:6255,
  otherDeliveredJ:549945,lossJ:309660.652174,thermalReceivedJ:315915.652174,
  outputClosed:true,cause:null,chargerAvailable:true,batteryAvailable:true,outputHealthy:true,
  opening:1,springEnergyJ:0,holding:false,closing:false,nextEventS:7700,eventCursor:4},
  arm={final:point,events:[{...point,timeS:90}],copyChecks:{passed:true,checks:1,maximumDifference:0},
   maximumEnergyDefectJ:0,maximumThermalReceiptDefectJ:0},
  receipt={kind:'finite-actuation-supply-pair',passed:true,policy:coolingActuationSupplyPolicy,
   finiteSupplyEnergyConserved:true,thermalReceiptMatched:true,actualSupportLossReleased:true,
   restorationDidNotReplay:true,poweredCloseRecharged:true,commandedReopenAchieved:true,retainedCopiesMatched:true,
   normal:arm,tighter:arm,maximumPairedEnergyDifferenceJ:0}
 expect(actuationSupplyAdmission.safeParse(receipt).success).toBe(true)
 for(const changed of [undefined,{...receipt,passed:false},{...receipt,policy:'supplied-healthy-support'},
  {...receipt,restorationDidNotReplay:false},{...receipt,poweredCloseRecharged:undefined},
  {...receipt,normal:{...arm,final:{...point,timeS:299}}},
  {...receipt,normal:{...arm,final:{...point,nextEventS:299}}},
  {...receipt,normal:{...arm,final:{...point,energyJ:-1}}},
  {...receipt,normal:{...arm,copyChecks:{passed:true,checks:0,maximumDifference:0}}},
  {...receipt,normal:{...arm,copyChecks:{passed:true,checks:1,maximumDifference:1}}},
  {...receipt,normal:{...arm,maximumThermalReceiptDefectJ:NaN}},
  {...receipt,normal:{...arm,final:{...point,prhrDeliveredJ:undefined}}}])
  expect(actuationSupplyAdmission.safeParse(changed).success).toBe(false)
})

test('finite BODY/guide evidence rejects wrong-zero, unresolved cooling and malformed receipts',()=>{
 const receipt={kind:'absorber-guide-pair',passed:true,policy:coolingAbsorberGuidePolicy,hosts:1036,
  powerLocalRatio:0,powerSUMABSRatio:0,paidEnergyRatio:0,developedAllCaptureFamilies:true,
  familyOrder:['BODY-B10','BODY-304-and-Mn','GUIDE-Zr'],normalFamilyPowerW:[1,2,3],tighterFamilyPowerW:[1,2,3],
  normalPaidJ:2,tighterPaidJ:2,normalExportJ:0,tighterExportJ:0,
  normalFiniteRecipientPowerW:1,tighterFiniteRecipientPowerW:1,
  guideThermalWitness:{host:52,normalChangeK:6,tighterChangeK:6,resolved:true}}
 expect(absorberGuideAdmission.safeParse(receipt).success).toBe(true)
 for(const changed of [undefined,{}, {...receipt,passed:false},{...receipt,policy:'old'},
  {...receipt,developedAllCaptureFamilies:false},{...receipt,normalFamilyPowerW:[1,0,3]},
  {...receipt,normalFiniteRecipientPowerW:0},{...receipt,paidEnergyRatio:1.01},
  {...receipt,guideThermalWitness:{...receipt.guideThermalWitness,resolved:false}}])
  expect(absorberGuideAdmission.safeParse(changed).success).toBe(false)
})

test('a corrected attempt must debit the unsuccessful prior work against the same allowance',()=>{
 const prior={passed:false,allowanceSeconds:180,elapsedSeconds:6.166466292,noWholePlantReadinessCredit:true}
 expect(fuelCoolingPriorSeconds(prior)).toBe(prior.elapsedSeconds)
 for(const bad of [{...prior,passed:true},{...prior,elapsedSeconds:180},{...prior,elapsedSeconds:NaN},
  {...prior,allowanceSeconds:120},{...prior,allowanceSeconds:240}])expect(()=>fuelCoolingPriorSeconds(bad)).toThrow()
})

test('retained coupled checkpoints and polynomial observations have distinct exact frames',()=>{
 for(const [magic,width]of [['LDPTST01',16],['LDPTCM01',8]] as const){
  const bytes=new Uint8Array(24+width*3),view=new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode(magic));view.setBigUint64(8,3n,true);view.setFloat64(16,300,true)
  expect(coolingStateHeader(bytes)).toEqual({magic,coordinates:3,time:300})
  expect(()=>coolingStateHeader(bytes.subarray(1))).toThrow()
  view.setFloat64(16,NaN,true);expect(()=>coolingStateHeader(bytes)).toThrow()
 }
 expect(()=>coolingStateHeader(new Uint8Array(0))).toThrow()
 for(const [magic,width]of [['LDCOOL01',16],['LDCCOM01',8],['LDRCST01',16],['LDRCCM01',8]] as const){
  const bytes=new Uint8Array(24+width*3),view=new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode(magic));view.setBigUint64(8,3n,true);view.setFloat64(16,300,true)
  expect(()=>coolingStateHeader(bytes)).toThrow('Invalid')
 }
})

test('only a complete physically developed refined pair can receive admission',()=>{
 const outcome={kind:'source-cooling-pair',passed:true,lastAdmittedTime:300,dimension:7,differential:4,
  normal:{passed:true,lastAdmittedTime:300,commonSamples:14},tighter:{passed:true,lastAdmittedTime:300,commonSamples:14},
  settings:{accuracyPolicy:'cold-source-nuclear-heat',mobileCapturePolicy:coolingMobileCapturePolicy,mobileCaptureDevelopmentPolicy:coolingMobileDevelopmentPolicy,provisional:true,horizon:300,referenceAllATOLandRTOLDivisor:10,
   carrierCoordinates:'hydrogen-product,direct-boron10,boron-product',
   carrierComparisonPolicy:'closed-mobile-generated-products-separate-H-B;local-remaining-targets;local-product-distribution-diagnostic',
   pressureCoordinates:'finite-pool-cushion-and-surge-forward-DAE;direct-liquid-B10-and-phase-H-products',
   pressureResponseResolutionPa:1,pressureChangeRelativeBudget:0.005,surgeHydraulicModel:'finite-storage-two-algebraic-resistances',
   surgeGravityModel:'owned-bulk-density-hydrostatic-face-heads',
   surgeReductionScope:'sound-filtered-slow-support;no-inertial-waveform-credit',surgeFlowResolutionKgS:1e-5,
   pressureChartHeightScope:'hydrostatic-equivalent-1Pa;P-T-coupled-correction-and-metal-caloric-admitted',
   fuelPowerErrorWeights:'sparse-current-response-proportional-budget-cap',fuelPowerResolutionW:1e-12,
   barrelPowerErrorWeights:'sparse-current-bulk-capture-Mn-proportional-budget-cap',barrelPowerResolutionW:1e-12,
   capturePowerErrorWeights:'sparse-current-fuel-capture-and-temperature-proportional-budget-cap',capturePowerResolutionW:1e-12,
   capturePowerWeightScope:'emitted-per-intersection;held-route-fractions-at-most-one;all-five-recipient-channels-independently-paired',
   costGuard:'aggregate-native-and-external-wall-deadlines;accepted-step-count-diagnostic',
   nonlinearClosure:'stock-Newton-and-current-physical-network-pressure-charts',linearWeightedL2Budget:0.0165,
   algebraicLTE:'excluded-from-temporal-control;retained-in-Newton-physical-closure-and-output-pair',
   solverEnergyCoordinate:coolingEnergyCoordinates.base,energyDefectATOLJ:0.01/Math.sqrt(7),
   perRowErrorWeights:'source-carrier-barrel-binding-receipts-relative-consequences;network-thermal-absolute-only;energy-defect-absolute'},
  gates:{fullPairComparisonEvaluated:true,developedThermalResponse:true,developedSourceResponse:true,developedMobileCaptureResponse:true,
   developedBarrelResponse:true,barrelPairRatio:0,barrelPowerPairRatio:0,
   capturePowerLocalRatio:0,capturePowerSUMABSRatio:0,capturePaidEnergyRatio:0,
   mobileCapturePowerLocalRatio:0,mobileCapturePowerSUMABSRatio:0,mobileCapturePaidEnergyRatio:0,
   developedPressureResponse:true,pressurePairRatio:0,pressureMaterialPairRatio:0,pressureChartRatio:0,pressureFlowClosureRatio:0,
   sourceLocalRatio:0,sourceFamilyRatio:0,sourceObservableRatio:0,sourceNCOperatorRatio:0,
   thermalPairRatio:0,networkPairRatio:0,depositionPairRatio:0,carrierPairRatio:0},
  pairedComparisons:Array.from({length:14},()=>({})),fuelTemperatureFeedbackDiagnostic:{},
  mobileCaptureReceipts:{policy:coolingMobileCapturePolicy,routeCount:3,wallOriginCount:2,speciesOrder:['H','B'],
   channelOrder:['emitted','charged-liquid','liquid-photon','installed-wall','beyond-installed-wall-export','unrepresented-wall-boundary-export'],
   normalPaidSpeciesJ:[1,2],tighterPaidSpeciesJ:[1,2],normalExclusiveExportsJ:[.1,.2],tighterExclusiveExportsJ:[.1,.2],
   normalSpeciesPowerTotalsW:Array(12).fill(1),tighterSpeciesPowerTotalsW:Array(12).fill(1),
   normalFiniteRecipientPowerW:1,tighterFiniteRecipientPowerW:1}}
 expect(fuelCoolingAdmission.safeParse(outcome).success).toBe(true)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,solverEnergyCoordinate:coolingEnergyCoordinates.prhr}}).success).toBe(true)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,carrierCoordinates:undefined}}).success).toBe(false)
 for(const field of ['passed','fullPairComparisonEvaluated','developedThermalResponse','developedSourceResponse','developedBarrelResponse','developedPressureResponse','developedMobileCaptureResponse']){
  const changed=structuredClone(outcome)
  if(field==='passed')changed.passed=false
  else (changed.gates as Record<string,unknown>)[field]=false
  expect(fuelCoolingAdmission.safeParse(changed).success).toBe(false)
 }
 for(const field of ['sourceLocalRatio','sourceFamilyRatio','sourceObservableRatio','sourceNCOperatorRatio',
  'thermalPairRatio','networkPairRatio','depositionPairRatio','carrierPairRatio','barrelPairRatio','barrelPowerPairRatio',
  'capturePowerLocalRatio','capturePowerSUMABSRatio','capturePaidEnergyRatio',
  'mobileCapturePowerLocalRatio','mobileCapturePowerSUMABSRatio','mobileCapturePaidEnergyRatio',
  'pressurePairRatio','pressureMaterialPairRatio','pressureChartRatio','pressureFlowClosureRatio'])for(const value of [1.01,NaN,Infinity,-1]){
   const changed=structuredClone(outcome);(changed.gates as Record<string,unknown>)[field]=value
   expect(fuelCoolingAdmission.safeParse(changed).success).toBe(false)
  }
 expect(fuelCoolingAdmission.safeParse({...outcome,tighter:null}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,pairedComparisons:outcome.pairedComparisons.slice(1)}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,referenceAllATOLandRTOLDivisor:1}}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,carrierComparisonPolicy:undefined}}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,carrierComparisonPolicy:'local-product-paid-energy'}}).success).toBe(false)
 for(const policy of ['cold-source-fuel-binding','cold-source-cooling-1','cold-source-cooling-2','cold-source-cooling-3','cold-source-cooling-4','cold-source-cooling-5','cold-source-cooling-6','cold-source-cooling-7'])
  expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,accuracyPolicy:policy}}).success).toBe(false)
 for(const energyDefectATOLJ of [0,NaN,Infinity,0.01,1])
  expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,energyDefectATOLJ}}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,solverEnergyCoordinate:'imposed-zero'}}).success).toBe(false)
 for(const fuelPowerResolutionW of [0,NaN,Infinity,1e-10])
  expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,fuelPowerResolutionW}}).success).toBe(false)
 for(const barrelPowerResolutionW of [0,NaN,Infinity,1e-10])
  expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,barrelPowerResolutionW}}).success).toBe(false)
 for(const capturePowerResolutionW of [0,NaN,Infinity,1e-10])
  expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,capturePowerResolutionW}}).success).toBe(false)
 for(const capturePowerErrorWeights of [undefined,'fission-only'])
  expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,capturePowerErrorWeights}}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,capturePowerWeightScope:undefined}}).success).toBe(false)
 for(const field of ['capturePowerLocalRatio','capturePowerSUMABSRatio','capturePaidEnergyRatio']) {
  const changed=structuredClone(outcome);delete (changed.gates as Record<string,unknown>)[field]
  expect(fuelCoolingAdmission.safeParse(changed).success).toBe(false)
 }
 for(const field of ['mobileCapturePowerLocalRatio','mobileCapturePowerSUMABSRatio','mobileCapturePaidEnergyRatio','developedMobileCaptureResponse']){
  const changed=structuredClone(outcome);delete (changed.gates as Record<string,unknown>)[field]
  expect(fuelCoolingAdmission.safeParse(changed).success).toBe(false)
 }
 for(const mobileCaptureReceipts of [undefined,{}, {...outcome.mobileCaptureReceipts,normalPaidSpeciesJ:[NaN,1]},
  {...outcome.mobileCaptureReceipts,normalFiniteRecipientPowerW:0},
  {...outcome.mobileCaptureReceipts,tighterFiniteRecipientPowerW:undefined},
  {...outcome.mobileCaptureReceipts,normalExclusiveExportsJ:[-1,0]},
  {...outcome.mobileCaptureReceipts,normalSpeciesPowerTotalsW:[1]},
  {...outcome.mobileCaptureReceipts,speciesOrder:['B','H']}])
  expect(fuelCoolingAdmission.safeParse({...outcome,mobileCaptureReceipts}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,mobileCapturePolicy:undefined}}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,barrelPowerErrorWeights:'fuel-only'}}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,fuelPowerErrorWeights:'stock-count-only'}}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,costGuard:'unlimited'}}).success).toBe(false)
 for(const settings of [
  {...outcome.settings,nonlinearClosure:undefined},
  {...outcome.settings,nonlinearClosure:'stock-Newton-only'},
  {...outcome.settings,linearWeightedL2Budget:0.0165*Math.sqrt(outcome.dimension)},
  {...outcome.settings,algebraicLTE:'suppressed'},
  {...outcome.settings,algebraicLTE:'included'},
  {...outcome.settings,surgeGravityModel:undefined},
  {...outcome.settings,surgeGravityModel:'upwind-donor-gravity'},
  {...outcome.settings,surgeReductionScope:undefined},
  {...outcome.settings,surgeHydraulicModel:'conjugate-linear-velocity-mass-metric'},
  {...outcome.settings,surgeFlowResolutionKgS:1},
 ])expect(fuelCoolingAdmission.safeParse({...outcome,settings}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,
  perRowErrorWeights:'source-relative-consequences;network-thermal-carrier-absolute-only'}}).success).toBe(false)
})

test('retention completeness is independent of admission and requires both distinct arm schedules',()=>{
 const states=['normal','tighter'].flatMap(arm=>[
  ...coolingCommonTimes.map((time,i)=>({path:`/evidence/input.${arm}.common-${i}.bin`,magic:'LDPTCM01',coordinates:7,time})),
  {path:`/evidence/input.${arm}.checkpoint`,magic:'LDPTST01',coordinates:7,time:300},
 ])
 // No qualification verdict is an input to retention, so failed physical
 // development cannot conceal otherwise complete diagnostic artifacts.
 expect(coolingStatesComplete(states,7)).toBe(true)
 expect(coolingStatesComplete(states,undefined)).toBe(false)
 expect(coolingStatesComplete(states.slice(1),7)).toBe(false)
 for(const change of [{path:states[1]!.path},{time:states[1]!.time},{time:.002},{time:NaN},{coordinates:8},
  {magic:'LDCCOM01'},{frameError:'invalid'}]){
  const changed=states.map(s=>({...s}));Object.assign(changed[0]!,change)
  expect(coolingStatesComplete(changed,7)).toBe(false)
 }
 const changed=states.map(s=>({...s}));changed[14]!.time=299
 expect(coolingStatesComplete(changed,7)).toBe(false)
})

test('cold gap selection is explicit, unique and physically bounded',()=>{
 const doc='```reference-operating-fuel-gap\n{"fuelEmissivity":0.7,"cladEmissivity":0.7}\n```\n'
 expect(parseOperatingFuelGap(doc)).toEqual({fuelEmissivity:.7,cladEmissivity:.7})
 for(const bad of ['',doc+doc,doc.replace('0.7','0'),doc.replace('0.7','1.1'),
  doc.replace('"cladEmissivity"','"unspecified"')])expect(()=>parseOperatingFuelGap(bad)).toThrow()
})
test('joined conditioning is explicit and does not replace source reference preparation',()=>{
 const doc='```reference-cold-conditioning-preparation\n{"liquidTemperature_K":293.15}\n```\n'
 expect(parseColdConditioningPreparation(doc)).toEqual({liquidTemperature_K:293.15})
 for(const bad of ['',doc+doc,doc.replace('293.15','0'),doc.replace('"liquidTemperature_K"','"implicit"'),
  doc.replace('293.15','293.15,"extra":300')])expect(()=>parseColdConditioningPreparation(bad)).toThrow()
})
test('qualification refuses immutable evidence overwrite before any native execution',async()=>{
 await expect(qualifyFuelCooling({wiki:'unused',partition:'unused',material:'unused',water:'unused',
  materialEvidence:'unused',binary:'unused',selectedStackManifest:'unused',output:import.meta.path})).rejects.toThrow('overwrite')
})

const wiki=process.env.LEITBILD_REFERENCE_WIKI,ownerTest=wiki?test:test.skip
ownerTest('current owners close fuel/helium recipients and actual non-proportional guide incidence',async()=>{
 const p=await compileFuelCooling(wiki!)
 expect(p.conditioning.liquidTemperature_K).toBe(293.15)
 expect(p.network.anchor.temperature_K).toBe(p.conditioning.liquidTemperature_K)
 expect(p.network.referenceAnchor.temperature_K).toBe(300)
 expect(p.network.nativeInput.split(/\s+/)[7]).toBe(String(p.conditioning.liquidTemperature_K))
 expect(p.thermal.originalTemperatures.every(t=>t===300)).toBe(true)
 expect(p.pressure.surgeLiquidTemperature_K).toBe(p.conditioning.liquidTemperature_K)
 expect(p.barrel.initial_temperature_k).toBe(300)
 expect(p.thermal.bands).toHaveLength(193*4)
 expect(p.thermal.helium).toHaveLength(193)
 expect(p.thermal.thermalCoordinates).toBe(9264+193)
 expect(p.thermal.fuelRows).toHaveLength(193*4*9)
 expect(new Set(p.thermal.fuelRows).size).toBe(p.thermal.fuelRows.length)
 expect(p.thermal.bands.reduce((s,b)=>s+b.fuel_masses_kg.length+b.clad_masses_kg.length,0)).toBe(9264)
 for(const b of p.thermal.bands){
  const edge=p.network.hydraulic[b.flowEdge]!
  expect(edge.to).toBe(b.water)
  // Both q and area are the full MAIN core bundle, never one-FA area with total q.
  expect(b.flow_area_m2).toBe(edge.segments[0]!.area_m2)
  expect(b.hydraulic_diameter_m).toBe(edge.segments[0]!.diameter_m)
 }
 const down=p.primary.cells.find(c=>c.id==='DOWNCOMER')!
 expect(down.representedVolume_m3/down.totalVolume_m3).toBeCloseTo(2/3,12)
 expect(down.outsideSourceVolume_m3).toBeCloseTo(20/3,12)
 expect(p.primary.rows.filter(r=>r.cellId==='GUIDE.THIMBLE').length).toBeLessThan(
  p.primary.rows.filter(r=>r.cellId==='GUIDE.EMPTY').length)
 for(const cell of p.primary.cells)expect(cell.representedVolume_m3+cell.outsideSourceVolume_m3).toBeCloseTo(cell.totalVolume_m3,11)
 const d=parsePrimaryWaterInputs(await Promise.all(primaryWaterOwnerFiles.map(n=>Bun.file(join(wiki!,n)).text()))),
  geometry=compilePrimaryWaterGeometry(p.material.partition,d)
 expect(()=>compilePrimaryIncidence({...p.network,water:p.network.water.filter(w=>w.id!=='GUIDE.BODY')},p.material.partition,d,geometry)).toThrow('Missing')
 expect(()=>compilePrimaryIncidence({...p.network,water:p.network.water.map(w=>w.id==='DOWNCOMER'?{...w,volume_m3:1}:w)},p.material.partition,d,geometry)).toThrow('exceeds')
 expect(()=>compileFuelCoolingMaterial(p.material,{...p.network,hydraulic:p.network.hydraulic.filter(e=>e.to!==2)},
  {fuelEmissivity:.7,cladEmissivity:.7})).toThrow('unique')
},60_000)
