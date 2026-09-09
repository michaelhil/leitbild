/** Offline LD-01 normal-alignment station budget, not a dynamic plant solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runCycle } from './reference-design-cycle.ts'

const positive = z.number().finite().positive()
const efficiency = positive.max(1)
const pump = z.object({ head_MPa: positive, hydraulicEfficiency: efficiency,
  motorEfficiency: efficiency, dragFraction: z.number().finite().nonnegative() }).strict()
const schema = z.object({
  design: z.literal('LD-01'), alignment: z.literal('full-power-RHR-isolated'),
  waterDensity_kg_m3: positive, waterCp_J_kgK: positive,
  siteWater_C: z.number().finite(), ambient_C: z.number().finite(),
  condenserOnlyRise_K: positive, CW: pump,
  CCW: pump.extend({ ratedFlow_kg_s: positive, auxiliaryBranchReference_kg_s: positive,
    supply_C: z.number().finite() }).strict(),
  SW: pump.extend({ flowA_kg_s: positive, flowB_kg_s: positive }).strict(),
  shaftMechanicalEfficiency: efficiency,
  dcLoadA_kW: positive, dcLoadB_kW: positive, converterEfficiency: efficiency,
  fanEach_kW: positive, transformerFixed_kW: positive,
  transformerLoadFraction: z.number().finite().nonnegative(),
  busEach_MW: positive, source_MW: positive,
  roomAirEach_kg_s: positive, airCp_J_kgK: positive, roomWallEach_MW_K: positive,
  CWmotorEach_MW_K: positive, serviceMotorEach_MW_K: positive,
  transformerEach_MW_K: positive,
}).strict().superRefine((b,ctx)=>{
  if(b.CCW.auxiliaryBranchReference_kg_s>b.CCW.ratedFlow_kg_s)
    ctx.addIssue({code:'custom',message:'Auxiliary branch exceeds total rated CCW flow'})
  if(b.siteWater_C>=b.CCW.supply_C)
    ctx.addIssue({code:'custom',message:'Selected CCW supply needs a colder site source'})
})

export const parseStationBasis = (document:string) => {
  const blocks=[...document.matchAll(/^```reference-station\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw new Error('Expected exactly one reference-station JSON block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
export const pumpDuty = (flow:number, head:number, rho:number, etaHyd:number, etaMotor:number, drag:number) => {
  if(![flow,head,rho,etaHyd,etaMotor,drag].every(Number.isFinite)||flow<0||head<0||rho<=0||etaHyd<=0||etaHyd>1||etaMotor<=0||etaMotor>1||drag<0)
    throw new Error('Invalid liquid pump duty')
  const hydraulic=flow/rho*head, fluid=hydraulic/etaHyd, electric=fluid*(1+drag)/etaMotor
  return { hydraulic_MW:hydraulic, fluid_MW:fluid, electric_MW:electric, motorAndDrag_MW:electric-fluid }
}

// Positive service-pump curve at rated speed against the only open branch.
// Both pump and resistance use the same reference density; it cancels here.
export const isolatedRHRFlow = (rated:number,auxiliary:number) => {
  if(!Number.isFinite(rated)||!Number.isFinite(auxiliary)||rated<=0||auxiliary<=0||auxiliary>rated)
    throw new Error('Invalid CCW branch calibration')
  const flow=Math.sqrt(1.25/(1/auxiliary**2+.25/rated**2))
  return {flow_kg_s:flow,headRatio:(flow/auxiliary)**2}
}

type Cycle = { powers_MW:Record<string,number> }
export const calculateStation = (b:ReturnType<typeof parseStationBasis>,cycle:Cycle,
  ccwAlignment?: { A: { flow_kg_s: number; head_MPa: number }; B: { flow_kg_s: number; head_MPa: number } }) => {
  const P=cycle.powers_MW
  for(const k of ['core','gross_electric','condenser','turbine_thermodynamic_work','RCP_electric','RCP_fluid','feed_pump_electric','feed_pump_fluid','condensate_pump_electric','condensate_pump_fluid'])
    if(!Number.isFinite(P[k])||P[k]!<=0)throw new Error(`Missing positive cycle power ${k}`)
  const cwFlow=P.condenser!*1e6/(b.waterCp_J_kgK*b.condenserOnlyRise_K)
  const duty=(flow:number,p:typeof b.CW,head=p.head_MPa)=>pumpDuty(flow,head,b.waterDensity_kg_m3,p.hydraulicEfficiency,p.motorEfficiency,p.dragFraction)
  const CW=duty(cwFlow,b.CW), branch=isolatedRHRFlow(b.CCW.ratedFlow_kg_s,b.CCW.auxiliaryBranchReference_kg_s)
  const alignment=ccwAlignment??{A:{flow_kg_s:branch.flow_kg_s,head_MPa:b.CCW.head_MPa*branch.headRatio},B:{flow_kg_s:branch.flow_kg_s,head_MPa:b.CCW.head_MPa*branch.headRatio}}
  if([alignment.A,alignment.B].some(v=>!Number.isFinite(v.flow_kg_s)||v.flow_kg_s<=0||!Number.isFinite(v.head_MPa)||v.head_MPa<0))throw new Error('Station steady CCW alignment needs positive flow and nonnegative head')
  const CCWA=duty(alignment.A.flow_kg_s,b.CCW,alignment.A.head_MPa),CCWB=duty(alignment.B.flow_kg_s,b.CCW,alignment.B.head_MPa)
  const SWA=duty(b.SW.flowA_kg_s,b.SW),SWB=duty(b.SW.flowB_kg_s,b.SW)
  const dcA=b.dcLoadA_kW/1000/b.converterEfficiency,dcB=b.dcLoadB_kW/1000/b.converterEfficiency
  const halfMain=(P.RCP_electric!+P.feed_pump_electric!)/2
  const busA=halfMain+P.condensate_pump_electric!+CW.electric_MW/2+CCWA.electric_MW+SWA.electric_MW+dcA+b.fanEach_kW/1000
  const busB=halfMain+CW.electric_MW/2+CCWB.electric_MW+SWB.electric_MW+dcB+b.fanEach_kW/1000
  const unitLoss=b.transformerFixed_kW/1000+b.transformerLoadFraction*(busA+busB)
  const reserveLoss=b.transformerFixed_kW/1000
  const net=P.gross_electric!-busA-busB-unitLoss-reserveLoss
  const oil=P.turbine_thermodynamic_work!*(1-b.shaftMechanicalEfficiency)
  const generator=P.turbine_thermodynamic_work!*b.shaftMechanicalEfficiency-P.gross_electric!
  if(generator<0)throw new Error('Station shaft efficiency contradicts cycle generator power')
  const halfMotors=(P.RCP_electric!-P.RCP_fluid!+P.feed_pump_electric!-P.feed_pump_fluid!)/2
  const ccwHeatA=halfMotors+P.condensate_pump_electric!-P.condensate_pump_fluid!+CCWA.fluid_MW
  const ccwHeatB=halfMotors+oil+CCWB.fluid_MW
  const cwHeat=P.condenser!+CW.fluid_MW
  const swHeatA=ccwHeatA+SWA.fluid_MW,swHeatB=ccwHeatB+generator+SWB.fluid_MW
  const outdoorMotors=CW.motorAndDrag_MW+CCWA.motorAndDrag_MW+CCWB.motorAndDrag_MW+SWA.motorAndDrag_MW+SWB.motorAndDrag_MW
  // Whole continuous DC duty becomes local heat here. No actuator pulse or
  // battery recharge is active in this explicitly selected steady alignment.
  const roomHeatA=dcA+b.fanEach_kW/1000,roomHeatB=dcB+b.fanEach_kW/1000
  const ambient=outdoorMotors+unitLoss+reserveLoss+roomHeatA+roomHeatB
  const residual=P.core!-net-cwHeat-swHeatA-swHeatB-ambient
  if(Math.abs(residual)>1e-8)throw new Error(`Station first-law residual ${residual} MW`)
  const waterRise=(heat:number,flow:number)=>heat*1e6/(flow*b.waterCp_J_kgK)
  const cwPumpRise=waterRise(CW.fluid_MW,cwFlow)
  const cwCell1=b.siteWater_C+cwPumpRise+b.condenserOnlyRise_K/2
  const cwCell2=b.siteWater_C+cwPumpRise+b.condenserOnlyRise_K
  const roomG=b.roomWallEach_MW_K+b.roomAirEach_kg_s*b.airCp_J_kgK/1e6
  return { pumps:{CW,CCW_A:CCWA,CCW_B:CCWB,SWA,SWB},
    ccwAlignment:alignment,ccwBoundary:ccwAlignment?'Explicit resolved A/B branch flow and head':'Retained aggregate RHR-isolated sizing alignment',
    flows_kg_s:{CW:cwFlow,CCW_A:alignment.A.flow_kg_s,CCW_B:alignment.B.flow_kg_s,SW_A:b.SW.flowA_kg_s,SW_B:b.SW.flowB_kg_s},
    powers_MW:{busA,busB,unitConversionLoss:unitLoss,reserveNoLoadLoss:reserveLoss,netExport:net,
      condenserSiteRejection:cwHeat,SW_A_rejection:swHeatA,SW_B_rejection:swHeatB,ambientRejection:ambient,
      CCW_A_heat:ccwHeatA,CCW_B_heat:ccwHeatB,oilLoss:oil,generatorLoss:generator,roomA:roomHeatA,roomB:roomHeatB,residual},
    margins_MW:{busA:b.busEach_MW-busA,busB:b.busEach_MW-busB,unitSource:b.source_MW-busA-busB-unitLoss},
    temperatures_C:{CW_after_pumps:b.siteWater_C+cwPumpRise,CW_cell1:cwCell1,CW_discharge:cwCell2,
      CCW_A_return:b.CCW.supply_C+waterRise(ccwHeatA,alignment.A.flow_kg_s),CCW_B_return:b.CCW.supply_C+waterRise(ccwHeatB,alignment.B.flow_kg_s),
      SW_A_discharge:b.siteWater_C+waterRise(swHeatA,b.SW.flowA_kg_s),SW_B_mixed_discharge:b.siteWater_C+waterRise(swHeatB,b.SW.flowB_kg_s),
      roomA:b.ambient_C+roomHeatA/roomG,roomB:b.ambient_C+roomHeatB/roomG,
      CWmotor_each:b.ambient_C+CW.motorAndDrag_MW/2/b.CWmotorEach_MW_K,
      CCWmotor_A:b.ambient_C+CCWA.motorAndDrag_MW/b.serviceMotorEach_MW_K,CCWmotor_B:b.ambient_C+CCWB.motorAndDrag_MW/b.serviceMotorEach_MW_K,
      SWmotor_A:b.ambient_C+SWA.motorAndDrag_MW/b.serviceMotorEach_MW_K,
      SWmotor_B:b.ambient_C+SWB.motorAndDrag_MW/b.serviceMotorEach_MW_K,
      unitTransformer:b.ambient_C+unitLoss/b.transformerEach_MW_K,
      reserveTransformer:b.ambient_C+reserveLoss/b.transformerEach_MW_K},
  }
}

export const runStation = async (document:string,cycleDocument:string,python:string) => {
  const basis=parseStationBasis(document),cycle=await runCycle(cycleDocument,python)
  if(basis.shaftMechanicalEfficiency!==cycle.basis.shaftMechanicalEfficiency)
    throw new Error('Station and cycle shaft efficiencies disagree')
  return {inputSha256:createHash('sha256').update(JSON.stringify(basis)).digest('hex'),
    calculationSha256:createHash('sha256').update(await Bun.file(import.meta.path).text()).digest('hex'),
    cycleInputSha256:cycle.inputSha256,cycleCalculationSha256:cycle.calculationSha256,
    dependencies:cycle.dependencies,basis,...calculateStation(basis,cycle)}
}
if(import.meta.main){
  const [file,cycleFile,python]=Bun.argv.slice(2)
  if(!file||!cycleFile||!python)throw new Error('Usage: bun reference-design-station.ts <station-basis.md> <cycle-basis.md> <isolated-python>')
  console.log(JSON.stringify(await runStation(await Bun.file(file).text(),await Bun.file(cycleFile).text(),python),null,2))
}
