import {describe,expect,test} from 'bun:test'
import {converterLoads,parseNuclearObservationResponse,runNuclearObservationResponse} from './reference-design-nuclear-observation-response'
const record={observation_s:60,captureUpper_MeV:2.791,wet_W_m2_K:250,gas_W_m2_K:5,warmBound_K:593.15,roomBound_K:300,contacts:[.5,1,2]}
const doc='```reference-nuclear-observation-response\n'+JSON.stringify(record)+'\n```'
describe('finite NI response comparison',()=>{
 test('one strict owner',()=>{
  expect(parseNuclearObservationResponse(doc).observation_s).toBe(60)
  expect(()=>parseNuclearObservationResponse(doc+doc)).toThrow()
  expect(()=>parseNuclearObservationResponse(doc.replace('"observation_s":60','"observation_s":60,"extra":1'))).toThrow()
  expect(()=>parseNuclearObservationResponse(doc.replace('"captureUpper_MeV":2.791','"captureUpper_MeV":2.79'))).toThrow()
 })
 test('all captures are a load diagnostic, not an obtained count',()=>{
  const converter={signalMeanOnly:true,allCaptures_s:10,omittedCaptureUpper_W:10*2.791e6*1.602176634e-19,initialN10_atoms:100,detectableEvents_s:1}
  const cold={bodyTravel_m:0,marker_ppm:2000,combinedConverter:converter},normal={marker_ppm:1000,preparation:{pressure_Pa:15200000,temperature_K:578.045678},combinedConverter:converter}
  const loads=converterLoads({result:{rows:[cold,normal]}})
  expect(loads.map(x=>x.name)).toEqual(['cold','normal']);expect(loads[0]!.capture_s).toBe(10)
  expect(loads[0]!.eventMean_s).toBe(1)
  expect(()=>converterLoads({result:{rows:[cold,{...normal,preparation:{pressure_Pa:14707562,temperature_K:578.045678}}]}})).toThrow()
  expect(()=>converterLoads({result:{rows:[{...cold,combinedConverter:{...converter,signalMeanOnly:false}},normal]}})).toThrow()
  expect(()=>converterLoads({result:{rows:[{...cold,combinedConverter:{...converter,omittedCaptureUpper_W:0}},normal]}})).toThrow()
 })
 const wiki=process.env.LEITBILD_REFERENCE_WIKI,python=process.env.LEITBILD_REFERENCE_PYTHON,paired=process.env.LEITBILD_REFERENCE_NI_SOURCE
 if(Boolean(wiki)!==Boolean(python)||paired&&(!wiki||!python))throw Error('NI thermal comparison requires WIKI, PYTHON and paired NI source receipt')
 test.skipIf(!wiki||!python||!paired)('actual finite contact network and held limits',async()=>{
  const r=await runNuclearObservationResponse(wiki!,python!,paired!),rows=r.result.rows as any[]
  expect(rows).toHaveLength(18);expect(rows.every(x=>x.withinResponse)).toBe(true)
  expect(rows.every(x=>Math.abs(x.energyDefect_J)<2e-4&&x.stationaryResidual_W<1e-6)).toBe(true)
  expect(rows.filter(x=>x.case==='normal'&&x.receiver_K===593.15)).toHaveLength(6)
  expect(rows.every(x=>Object.keys(x.stopTemperatures_K).length===Object.keys(r.result.nodeOwners).length)).toBe(true)
  expect(r.result.contacts.every((x:any)=>x.a!==x.b&&x.geometry>0)).toBe(true)
  expect(r.pairedReceiptSha256).toHaveLength(64);expect(r.inputSha256).toHaveLength(64)
 },120000)
})
