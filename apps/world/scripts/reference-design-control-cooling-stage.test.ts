import {describe,expect,test} from 'bun:test'
import {parseControlCoolingStageResult} from './reference-design-control-cooling-stage'

// Deliberately small report fixtures test the inspection boundary, not physics.
const expected={waterOwners:3,clusters:2,cases:2,directionalCases:[1]}
function report(){
 const matrix={rows:7,entries:19,cj:1,seconds:.01,maxContributorScaledBackwardError:1e-16}
 const cases=[0,1].map(index=>({case:index,seconds:.1,fixedDifferentialStocksBitwisePreserved:true,
  initialization:{iterations:4,chartIterations:2,hydraulicRateIterations:2,lastAppliedChartCorrectionL2:.01,
   lastWeightedCorrectionScope:'remaining-hydraulic-state-and-all-rates',seconds:.01,lastWeightedCorrectionL2:.02,maxForwardRateResidualMixedUnits:1e-9},
  preparedZeroFlowMatrix:matrix,matrix,
  geometryJVP:index===0?null:{epsilonM:1e-5,relativeDiscrimination:3e-5,seconds:.01,
   countRHSStatus:'diagnostic-only;coefficient-and-assembly-qualification-is-separate',
   groups:[{name:'hydraulic_Pa',checkedFields:2,nonzeroAnalyticFields:1,acceptanceGate:true,maxRatio:.01,
    worstRow:1,absoluteDifference:1e-10,analytic:1,finiteDifference:1}]},
  work:{fluidPressureWorkW:1,fluidWallWorkW:2,oppositeMechanicalPowerW:-3,reciprocalDefectW:0,
   composedEnergyDefectAfterMechanicalWorkW:0,bodyFluidForcesN:[1,2],stemBuoyancyOnlyN:[1,2],stemNeckDragJoined:false},
  preparedLowerMouthSlopesPaPerKgS:[0,0],lowerMouthSlopesPaPerKgS:[1,1],
  currentAdmission:{chart:[0,0],pressureSplit:[0,0,0],bulkSpeedMPerS:0,movingWallSpeedMPerS:0,
   movingProfileSpeedBoundMPerS:0,dynamicHeadPa:0,omittedKineticEnergyBoundJ:0}}))
 return {status:'PASS',scope:'full-PRHR-SOURCE-cooling-current-stage-and-joint-consistency;not-a-trajectory',
  waterOwners:3,controlClusters:2,unknowns:42,sourceHistoryAdvanced:false,trajectoryAdmitted:false,
  mechanicalDynamicsJoined:false,stemNeckDragJoined:false,liveModelInstalled:false,elapsedS:.2,cases}
}
describe('current SOURCE/cooling qualification report boundary',()=>{
 test('accepts the actual native envelope with explicit unadvanced scope',()=>{
  const raw=report(),parsed=parseControlCoolingStageResult(raw,expected)
  expect(parsed.cases).toHaveLength(2)
  expect(parsed.trajectoryAdmitted).toBe(false)
  expect(parsed.cases[1]!.geometryJVP!.groups[0]!.acceptanceGate).toBe(true)
 })
 test('rejects incomplete invented PASS flags and failed native output',()=>{
  expect(()=>parseControlCoolingStageResult({pass:true,history_bits_unchanged:true,original_restored:true},expected)).toThrow()
  expect(()=>parseControlCoolingStageResult({...report(),status:'FAIL'},expected)).toThrow()
  const raw=report();delete (raw.cases[0] as Partial<typeof raw.cases[0]>).matrix
  expect(()=>parseControlCoolingStageResult(raw,expected)).toThrow()
 })
 test('binds water, cluster, case identities and required directional evidence',()=>{
  expect(()=>parseControlCoolingStageResult({...report(),waterOwners:4},expected)).toThrow()
  const raw=report();raw.cases.reverse()
  expect(()=>parseControlCoolingStageResult(raw,expected)).toThrow()
  const missing=report();missing.cases[1]!.geometryJVP=null
  expect(()=>parseControlCoolingStageResult(missing,expected)).toThrow()
 })
 test('rejects nonfinite work and scope inflation',()=>{
  const raw=report();raw.cases[0]!.work.reciprocalDefectW=NaN
  expect(()=>parseControlCoolingStageResult(raw,expected)).toThrow()
  expect(()=>parseControlCoolingStageResult({...report(),trajectoryAdmitted:true},expected)).toThrow()
  expect(()=>parseControlCoolingStageResult({...report(),liveModelInstalled:true},expected)).toThrow()
 })
 test('requires complete and consistent initialization phase evidence',()=>{
  const raw=report();raw.cases[0]!.initialization.chartIterations++
  expect(()=>parseControlCoolingStageResult(raw,expected)).toThrow()
  const missing=report()
  delete (missing.cases[0]!.initialization as Partial<typeof missing.cases[0]['initialization']>).lastAppliedChartCorrectionL2
  expect(()=>parseControlCoolingStageResult(missing,expected)).toThrow()
 })
})
