import {describe,expect,test} from 'bun:test'
import {parseHeadReclosure,perimeterAperture,liquidSeatRate,coldPerimeterAssessment,runHeadReclosure} from './reference-design-head-reclosure'

const directory=process.env.LEITBILD_REFERENCE_WIKI,python=process.env.LEITBILD_REFERENCE_PYTHON
if(Boolean(directory)!==Boolean(python))throw Error('Set both LEITBILD_REFERENCE_WIKI and LEITBILD_REFERENCE_PYTHON for native verification')

const b={minimumDP_Pa:10000,targetDP_Pa:15000,maximumDP_Pa:20000,window_s:60,
 maximumWaterRate_kg_s:.001,maximumWaterTransfer_kg:.06,maximumChargeRequest_kg_s:.05,
 maximumHotPressure_Pa:500000,maximumWaterTemperature_K:333.15,headDatum_m:4,dischargeCoefficient:.62,
 seatLandLength_m:.01,comparisonDefectLength_m:.1,comparisonTemperature_K:300,comparisonWellTemperature_K:298.15,
 comparisonWellPressure_Pa:199101.972070359,comparisonPrimaryTracerRatio:.001,comparisonWellTracerRatio:.002,
 comparisonPacket_kg:.00001,comparisonCouponMass_kg:100}
const document=(value:unknown)=>'```reference-head-reclosure\n'+JSON.stringify(value)+'\n```\n'
const accepted={dp:[{usable:true,low_Pa:14900,high_Pa:15100},{usable:true,low_Pa:14900,high_Pa:15100}],
 nativeDPRange_Pa:[15000,15000] as [number,number],window_s:60,waterRateBound_kg_s:.0009,absoluteWater_kg:.054,ncTransfer_kg:0,
 hotPressure_Pa:240000,waterTemperature_K:300,liquidFaces:true,numericalRateUncertainty_kg_s:.00001,
 pathsClosed:true,pendingOpposingIntent:false,supportAndDutyEstablished:true}

describe('Original bounded head reclosure—not execution or seal certification',()=>{
 test('one strict owner record and coherent cold objective',()=>{
  expect(parseHeadReclosure(document(b))).toEqual(b)
  expect(()=>parseHeadReclosure(document({...b,window_s:-1}))).toThrow()
  expect(()=>parseHeadReclosure(document({...b,extra:true}))).toThrow()
  expect(()=>parseHeadReclosure(document({...b,maximumDP_Pa:14000}))).toThrow()
  expect(()=>parseHeadReclosure(document(b)+document(b))).toThrow()
 })
 test('actual curtain/defect union does not double the same aperture',()=>{
  const A=16.75,p=2*Math.sqrt(Math.PI*A)
  expect(perimeterAperture(A,A,0,.1,0)).toBe(0)
  expect(perimeterAperture(A,A,0,.1,.001)).toBeCloseTo(.0001,14)
  expect(perimeterAperture(A,A,.001,.1,.001)).toBeCloseTo(p*.001,14)
  expect(perimeterAperture(A,A,.0005,.1,.001)).toBeCloseTo(p*.0005+.00005,14)
  expect(perimeterAperture(A,A,100,.1,.001)).toBe(A)
  expect(()=>perimeterAperture(A,A,0,p+1,.001)).toThrow()
 })
 test('explicit conjunction accepts only an assessed full cold window',()=>{
  expect(coldPerimeterAssessment(b,accepted).objectiveEstablished).toBe(true)
  expect(coldPerimeterAssessment(b,{...accepted,window_s:59.9}).objectiveEstablished).toBe(false)
  expect(coldPerimeterAssessment(b,{...accepted,hotPressure_Pa:500001}).objectiveEstablished).toBe(false)
  expect(coldPerimeterAssessment(b,{...accepted,waterTemperature_K:333.151}).objectiveEstablished).toBe(false)
 })
 test('finite seat viscosity, sign and dissipation—not an orifice microgap',()=>{
  const q={dp_Pa:20000,density_kg_m3:997,viscosity_Pa_s:.000854,width_m:.1,height_m:3e-6,land_m:.01,Cd:.62},r=liquidSeatRate(q)
  expect(r.massRate_kg_s).toBeLessThan(.000001)
  expect(r.viscousDrop_Pa+r.entryDrop_Pa).toBeCloseTo(q.dp_Pa,8)
  expect(r.dissipation_W).toBeGreaterThan(0)
  expect(liquidSeatRate({...q,dp_Pa:-q.dp_Pa}).massRate_kg_s).toBe(-r.massRate_kg_s)
  expect(liquidSeatRate({...q,height_m:0}).massRate_kg_s).toBe(0)
  expect(liquidSeatRate({...q,dp_Pa:0}).massRate_kg_s).toBe(0)
  expect(liquidSeatRate({...q,height_m:40e-6}).massRate_kg_s).toBeGreaterThan(.001)
  expect(()=>liquidSeatRate({...q,viscosity_Pa_s:0})).toThrow()
  expect(()=>liquidSeatRate({...q,height_m:1e-300})).toThrow('not numerically resolvable')
  expect(()=>liquidSeatRate({...q,height_m:1e300})).toThrow('not numerically resolvable')
 })
 test('equality, masked charge and unresolved accuracy do not prove a seat',()=>{
  expect(coldPerimeterAssessment(b,{...accepted,nativeDPRange_Pa:[0,0]}).objectiveEstablished).toBe(false)
  expect(coldPerimeterAssessment(b,{...accepted,nativeDPRange_Pa:[9999,15000]}).objectiveEstablished).toBe(false)
  expect(coldPerimeterAssessment(b,{...accepted,waterRateBound_kg_s:.002,absoluteWater_kg:.12}).objectiveEstablished).toBe(false)
  expect(coldPerimeterAssessment(b,{...accepted,numericalRateUncertainty_kg_s:.00011}).objectiveEstablished).toBe(false)
  expect(coldPerimeterAssessment(b,{...accepted,absoluteWater_kg:.061}).objectiveEstablished).toBe(false)
 })
 test('trapped phase/stale intervals/lost duty/pending opposing intent withhold conclusion',()=>{
  for(const q of [{liquidFaces:false},{ncTransfer_kg:.00001},{supportAndDutyEstablished:false},
   {pendingOpposingIntent:true},{pathsClosed:false},{dp:[{usable:false,low_Pa:14900,high_Pa:15100},accepted.dp[1]!]},
   {dp:[{usable:true,low_Pa:9900,high_Pa:10100},accepted.dp[1]!]}])
   expect(coldPerimeterAssessment(b,{...accepted,...q}).objectiveEstablished).toBe(false)
  expect(()=>coldPerimeterAssessment(b,{...accepted,absoluteWater_kg:NaN})).toThrow()
 })
 test.skipIf(!directory)('explicit native viscous/nozzle limits and finite signed packets',async()=>{
  const r=await runHeadReclosure(directory!,python!)
  expect(r.nativeRateComparisons.find((q:any)=>q.heightScale===.99&&q.dp_Pa===20000).rate_kg_s).toBeLessThan(.001)
  expect(r.nativeRateComparisons.find((q:any)=>q.heightScale===1.01&&q.dp_Pa===20000).rate_kg_s).toBeGreaterThan(.001)
  expect(r.nativeLimits.find((q:any)=>q.name==='large-gap').native.viscous).toBeLessThan(10)
  expect(r.nativeLimits.find((q:any)=>q.name==='low-drive').native.m).toBeGreaterThan(0)
  expect(r.nativeLimits.find((q:any)=>q.name==='zero-land').native.m).toBe(r.nativeLimits.find((q:any)=>q.name==='zero-land').curtain_kg_s)
  expect(r.finitePackets[0].packetTracer_kgEq).toBe(1e-8)
  expect(r.finitePackets[1].packetTracer_kgEq).toBe(2e-8)
  expect(r.finitePackets[0].donorAfterPressure_Pa).toBeLessThan(r.finitePackets[0].donor.p)
  expect(r.assessmentCases.filter((q:{result:{objectiveEstablished:boolean}})=>q.result.objectiveEstablished)).toHaveLength(1)
  expect(r.assessmentCases).toHaveLength(9)
 },30000)
})
