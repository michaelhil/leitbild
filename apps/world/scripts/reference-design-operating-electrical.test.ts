import {expect,test} from 'bun:test'
import {electricalOwners,exchangeOwner,parseCarrier,parseDistribution,parseExchange,parseFieldProtection,parseShaftDrag,parseSwitching,prepareOperatingElectrical} from './reference-design-operating-electrical'

// Test-only owner texts in the shapes the compiler reads; not plant evidence.
const fence=(name:string,value:unknown)=>'```'+name+'\n'+JSON.stringify(value)+'\n```'
const switching={breakerTravel_s:.3,breakerClosingWork_J:30,breakerSpringStock_J:10,breakerBodyCapacity_J_K:1e7,
  breakerBodyRoomConductance_W_K:2000,breakerBodyInitial_C:25,fieldConverterEfficiency:.95}
const drag={dragPowerAtReference_W:500000,referenceSpeed_rpm:1500}
const routing={incomingTravel_s:.1,transferOpenInterval_s:.3,motorDropout_s:1,
  qualification:{voltageMin_pu:.9,voltageMax_pu:1.1,frequencyMin_Hz:49,frequencyMax_Hz:51,qualify_s:1,disqualify_s:.2},
  conversionNoLoadLoss_W:20000,conversionLoadLossFraction:.01,sourceBudget_W:9e7,busBudget_W:4e7,
  motorConsumers:{'LD01.P.A1':'AC.A','LD01.P.A2':'AC.B'},fieldConverterBus:'AC.B'}
const page=(heading:string,name:string,value:unknown)=>`# Owner\n\n## ${heading}\n\nText.\n\n${fence(name,value)}\n\n## Next\n`
const {switching:sw,shaft:sh,distribution:di}=electricalOwners

test('drafted electrical blocks parse from their owning sections only, strictly',()=>{
  expect(parseSwitching(page(sw.heading,sw.fence,switching))).toEqual(switching)
  expect(parseShaftDrag(page(sh.heading,sh.fence,drag))).toEqual(drag)
  expect(parseDistribution(page(di.heading,di.fence,routing))).toEqual(routing as never)
  expect(()=>parseSwitching(page('Elsewhere',sw.fence,switching))).toThrow()
  expect(()=>parseSwitching(page(sw.heading,sw.fence,switching)+fence(sw.fence,switching))).toThrow()
  expect(()=>parseSwitching(page(sw.heading,sw.fence,{...switching,breakerSpringStock_J:40}))).toThrow('spring')
  expect(()=>parseSwitching(page(sw.heading,sw.fence,{...switching,extra:1}))).toThrow()
  expect(()=>parseShaftDrag(page(sh.heading,sh.fence,{dragPowerAtReference_W:500000}))).toThrow()
  expect(()=>parseDistribution(page(di.heading,di.fence,{...routing,motorConsumers:{'LD01.P.A1':'AC.C'}}))).toThrow()
  expect(()=>parseDistribution(page(di.heading,di.fence,{...routing,qualification:{...routing.qualification,voltageMin_pu:1.2}}))).toThrow('ordered')
  expect(()=>parseDistribution(page(di.heading,di.fence,{...routing,motorConsumers:{}}))).toThrow()
})

const carrier={angleReference:'continuousCarrier',rateInput:'frequencyAndRatePerInterval',reconciliation:'phaseErrorAsRateOverNextInterval',
  boundaryConversion:'none',rateChangeClass:'S3-D4'}
const exchange={quietInterval_s:1,windowInterval_s:.02,refinementInterval_s:.01,windowDeclaredBy:'Grid',receipt:'IDAS quadrature'}
test('owner D2 carrier and D1 exchange blocks parse strictly from their owning sections',()=>{
  const {carrier:ca}=electricalOwners
  expect(parseCarrier(page(ca.heading,ca.fence,carrier))).toEqual(carrier as never)
  // the replaced per-boundary conversion is not an accepted selection
  expect(()=>parseCarrier(page(ca.heading,ca.fence,{...carrier,boundaryConversion:'thetaReferenceConversion'}))).toThrow()
  expect(()=>parseCarrier(page(ca.heading,ca.fence,{...carrier,extra:1}))).toThrow()
  // D2's held-frequency-only rate is superseded by SW-1 (owner R6-K)
  expect(()=>parseCarrier(page(ca.heading,ca.fence,{...carrier,rateInput:'heldPerInterval'}))).toThrow()
  expect(()=>parseCarrier(page('Elsewhere',ca.fence,carrier))).toThrow()
  expect(parseExchange(page(exchangeOwner.heading,exchangeOwner.fence,exchange))).toEqual(exchange as never)
  expect(()=>parseExchange(page(exchangeOwner.heading,exchangeOwner.fence,{...exchange,windowInterval_s:2}))).toThrow('ordered')
  expect(()=>parseExchange(page(exchangeOwner.heading,exchangeOwner.fence,{...exchange,windowDeclaredBy:'Plant'}))).toThrow()
})

const fieldProtection={reportSample_s:.1,reportTransport_s:.1,reportMaximumAge_s:.3,additionalQualification_s:0,
  connectionReportSample_s:.1,connectionReportTransport_s:.1,connectionReportMaximumAge_s:2}
test('the field controller block parses strictly from its owning section, with no qualification delay',()=>{
  const {fieldProtection:fp}=electricalOwners
  expect(parseFieldProtection(page(fp.heading,fp.fence,fieldProtection))).toEqual(fieldProtection as never)
  expect(()=>parseFieldProtection(page(fp.heading,fp.fence,{...fieldProtection,additionalQualification_s:.1}))).toThrow()
  expect(()=>parseFieldProtection(page(fp.heading,fp.fence,{...fieldProtection,reportMaximumAge_s:.05}))).toThrow('maximum age')
  expect(()=>parseFieldProtection(page(fp.heading,fp.fence,{...fieldProtection,extra:1}))).toThrow()
  expect(()=>parseFieldProtection(page('Elsewhere',fp.fence,fieldProtection))).toThrow()
})

const patched=process.env.LD01_ELEC_WIKI_ROOT,python=process.env.LD01_RESEARCH_PYTHON,archive=process.env.LD01_WIKI_ROOT
test.skipIf(!patched||!python)('the drafted blocks over the actual owners compile; the cycle reproduces the selected arms',async()=>{
  const p=await prepareOperatingElectrical(patched!,python!)
  const w0=1500*2*Math.PI/60
  expect(p.slice.generator.mutual_H).toBeCloseTo(0.0272338396,10)
  expect(p.slice.generator.fieldResistance_ohm).toBe(.125)
  // the shaft page's selected equivalent arms, to their printed precision
  p.slice.turbine.intervals.map(i=>i.radius_m).forEach((r,k)=>expect(r).toBeCloseTo([1.254867953,2.392742470,2.398263717,2.149310395,2.316422680][k]!,8))
  expect(p.slice.turbine.losses.loadLossFraction).toBeCloseTo(.005-.5/1030.662217,12)
  expect(p.slice.turbine.losses.drag_Nm_per_rad_s).toBeCloseTo(500000/w0**2,9)
  expect(p.prepared.fieldDemand_V).toBe(250)
  expect(p.distribution.consumers['LD01.FW.P2']).toBe('AC.B')
  expect(p.steamValveTravel.turbineStop_s).toBe(.3)
  expect(p.carrier).toEqual(carrier as never)
  expect(p.fieldProtection).toEqual(fieldProtection as never)
  expect(p.provenance.consumed).toHaveLength(5)
},120000)
test.skipIf(!archive||!python)('the unpatched archive refuses: the electrical numbers are still prose there',async()=>{
  await expect(prepareOperatingElectrical(archive!,python!)).rejects.toThrow('Expected one')
},120000)
