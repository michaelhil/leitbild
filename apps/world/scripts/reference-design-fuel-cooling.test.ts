import {expect,test} from 'bun:test'
import {compileFuelCooling,compileFuelCoolingMaterial,compilePrimaryIncidence,parseOperatingFuelGap} from './reference-design-fuel-cooling'
import {compilePrimaryWaterGeometry,parsePrimaryWaterInputs,primaryWaterOwnerFiles} from './reference-design-source-water'
import {join} from 'node:path'
import {coolingStateHeader,fuelCoolingAdmission,fuelCoolingPriorSeconds,qualifyFuelCooling} from './reference-design-fuel-cooling-qualification'

test('a corrected attempt must debit the unsuccessful prior work against the same allowance',()=>{
 const prior={passed:false,allowanceSeconds:180,elapsedSeconds:6.166466292,noWholePlantReadinessCredit:true}
 expect(fuelCoolingPriorSeconds(prior)).toBe(prior.elapsedSeconds)
 for(const bad of [{...prior,passed:true},{...prior,elapsedSeconds:180},{...prior,elapsedSeconds:NaN},
  {...prior,allowanceSeconds:120},{...prior,allowanceSeconds:240}])expect(()=>fuelCoolingPriorSeconds(bad)).toThrow()
})

test('retained coupled checkpoints and polynomial observations have distinct exact frames',()=>{
 for(const [magic,width]of [['LDCOOL01',16],['LDCCOM01',8]] as const){
  const bytes=new Uint8Array(24+width*3),view=new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode(magic));view.setBigUint64(8,3n,true);view.setFloat64(16,300,true)
  expect(coolingStateHeader(bytes)).toEqual({magic,coordinates:3,time:300})
  expect(()=>coolingStateHeader(bytes.subarray(1))).toThrow()
  view.setFloat64(16,NaN,true);expect(()=>coolingStateHeader(bytes)).toThrow()
 }
 expect(()=>coolingStateHeader(new Uint8Array(0))).toThrow()
})

test('only a complete physically developed refined pair can receive admission',()=>{
 const outcome={kind:'source-cooling-pair',passed:true,lastAdmittedTime:300,dimension:7,differential:4,
  normal:{passed:true,lastAdmittedTime:300,commonSamples:14},tighter:{passed:true,lastAdmittedTime:300,commonSamples:14},
  settings:{accuracyPolicy:'cold-source-cooling-6',provisional:true,horizon:300,referenceAllATOLandRTOLDivisor:10,
   carrierCoordinates:'hydrogen-product,direct-boron10,boron-product',
   pressureCoordinates:'finite-pool-cushion-and-surge-forward-DAE;direct-liquid-B10-and-phase-H-products',
   pressureResponseResolutionPa:1,pressureChangeRelativeBudget:0.005,surgeMomentumModel:'conjugate-linear-velocity-mass-metric',
   surgeGravityModel:'owned-bulk-density-Galerkin',
   surgeReductionScope:'observed-candidate-and-endpoint-envelope;current-chart-consequence-allocation;not-coupled-trajectory-bound',
   pressureChartHeightScope:'hydrostatic-equivalent-1Pa;P-T-coupled-correction-and-metal-caloric-admitted',
   fuelPowerErrorWeights:'sparse-current-response-proportional-budget-cap',fuelPowerResolutionW:1e-12,
   barrelPowerErrorWeights:'sparse-current-bulk-capture-Mn-proportional-budget-cap',barrelPowerResolutionW:1e-12,
   costGuard:'aggregate-native-and-external-wall-deadlines;accepted-step-count-diagnostic',
   nonlinearClosure:'stock-Newton-and-current-physical-network-pressure-charts',linearWeightedL2Budget:0.0165,algebraicLTE:'included',
   solverEnergyCoordinate:'G=sum-installed-energy-change-independent-fuel-and-barrel-release-plus-barrel-export-and-ambient-export',energyDefectATOLJ:0.01/Math.sqrt(7),
   perRowErrorWeights:'source-carrier-barrel-receipts-relative-consequences;network-thermal-absolute-only;energy-defect-absolute'},
  gates:{fullPairComparisonEvaluated:true,developedThermalResponse:true,developedSourceResponse:true,
   developedBarrelResponse:true,barrelPairRatio:0,barrelPowerPairRatio:0,
   developedPressureResponse:true,pressurePairRatio:0,pressureMaterialPairRatio:0,pressureChartRatio:0,pressureMomentumRatio:0,
   surgeReductionRatio:0,
   sourceLocalRatio:0,sourceFamilyRatio:0,sourceObservableRatio:0,sourceNCOperatorRatio:0,
   thermalPairRatio:0,networkPairRatio:0,depositionPairRatio:0,carrierPairRatio:0},
  pairedComparisons:Array.from({length:14},()=>({})),fuelTemperatureFeedbackDiagnostic:{}}
 expect(fuelCoolingAdmission.safeParse(outcome).success).toBe(true)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,carrierCoordinates:undefined}}).success).toBe(false)
 for(const field of ['passed','fullPairComparisonEvaluated','developedThermalResponse','developedSourceResponse','developedBarrelResponse','developedPressureResponse']){
  const changed=structuredClone(outcome)
  if(field==='passed')changed.passed=false
  else (changed.gates as Record<string,unknown>)[field]=false
  expect(fuelCoolingAdmission.safeParse(changed).success).toBe(false)
 }
 for(const field of ['sourceLocalRatio','sourceFamilyRatio','sourceObservableRatio','sourceNCOperatorRatio',
  'thermalPairRatio','networkPairRatio','depositionPairRatio','carrierPairRatio','barrelPairRatio','barrelPowerPairRatio',
  'pressurePairRatio','pressureMaterialPairRatio','pressureChartRatio','pressureMomentumRatio','surgeReductionRatio'])for(const value of [1.01,NaN,Infinity,-1]){
   const changed=structuredClone(outcome);(changed.gates as Record<string,unknown>)[field]=value
   expect(fuelCoolingAdmission.safeParse(changed).success).toBe(false)
  }
 expect(fuelCoolingAdmission.safeParse({...outcome,tighter:null}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,pairedComparisons:outcome.pairedComparisons.slice(1)}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,referenceAllATOLandRTOLDivisor:1}}).success).toBe(false)
 for(const policy of ['cold-source-cooling-1','cold-source-cooling-2','cold-source-cooling-3','cold-source-cooling-4','cold-source-cooling-5'])
  expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,accuracyPolicy:policy}}).success).toBe(false)
 for(const energyDefectATOLJ of [0,NaN,Infinity,0.01,1])
  expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,energyDefectATOLJ}}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,solverEnergyCoordinate:'imposed-zero'}}).success).toBe(false)
 for(const fuelPowerResolutionW of [0,NaN,Infinity,1e-10])
  expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,fuelPowerResolutionW}}).success).toBe(false)
 for(const barrelPowerResolutionW of [0,NaN,Infinity,1e-10])
  expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,barrelPowerResolutionW}}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,barrelPowerErrorWeights:'fuel-only'}}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,fuelPowerErrorWeights:'stock-count-only'}}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,costGuard:'unlimited'}}).success).toBe(false)
 for(const settings of [
  {...outcome.settings,nonlinearClosure:undefined},
  {...outcome.settings,nonlinearClosure:'stock-Newton-only'},
  {...outcome.settings,linearWeightedL2Budget:0.0165*Math.sqrt(outcome.dimension)},
  {...outcome.settings,algebraicLTE:'suppressed'},
  {...outcome.settings,surgeGravityModel:undefined},
  {...outcome.settings,surgeGravityModel:'upwind-donor-gravity'},
  {...outcome.settings,surgeReductionScope:undefined},
 ])expect(fuelCoolingAdmission.safeParse({...outcome,settings}).success).toBe(false)
 expect(fuelCoolingAdmission.safeParse({...outcome,settings:{...outcome.settings,
  perRowErrorWeights:'source-relative-consequences;network-thermal-carrier-absolute-only'}}).success).toBe(false)
})

test('cold gap selection is explicit, unique and physically bounded',()=>{
 const doc='```reference-operating-fuel-gap\n{"fuelEmissivity":0.7,"cladEmissivity":0.7}\n```\n'
 expect(parseOperatingFuelGap(doc)).toEqual({fuelEmissivity:.7,cladEmissivity:.7})
 for(const bad of ['',doc+doc,doc.replace('0.7','0'),doc.replace('0.7','1.1'),
  doc.replace('"cladEmissivity"','"unspecified"')])expect(()=>parseOperatingFuelGap(bad)).toThrow()
})
test('qualification refuses immutable evidence overwrite before any native execution',async()=>{
 await expect(qualifyFuelCooling({wiki:'unused',partition:'unused',material:'unused',water:'unused',
  materialEvidence:'unused',binary:'unused',selectedStackManifest:'unused',output:import.meta.path})).rejects.toThrow('overwrite')
})

const wiki=process.env.LEITBILD_REFERENCE_WIKI,ownerTest=wiki?test:test.skip
ownerTest('current owners close fuel/helium recipients and actual non-proportional guide incidence',async()=>{
 const p=await compileFuelCooling(wiki!)
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
  expect(b.flow_area_m2).toBe(edge.area_m2)
  expect(b.hydraulic_diameter_m).toBe(edge.diameter_m)
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
