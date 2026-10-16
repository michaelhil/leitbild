/** Strict ELEC S3 slice packet for the native owners (operating/src/electrical,
 * operating/src/turbine/admission.rs): generator, shaft, turbine admission →
 * torque (the declared S3 reference-drop reduction), generator breaker and
 * AC.A/AC.B routing. Every value comes from one owner's strict block or from
 * an existing named calculator over such a block (parseGenerator /
 * generatorParameters, runCycle); nothing is defaulted. Values that only the
 * runtime laws derive (currents, torques, flows) are not computed here.
 *
 * Owners whose numbers are still prose in the wiki (breaker/converter, shaft
 * drag, AC routing) are read from their drafted strict blocks; a missing
 * block refuses compilation. Fixture values (consumer demands for the routing
 * account, ROOM.B temperature) are labelled as such in the packet.
 * Usage: bun reference-design-operating-electrical.ts <wiki root> <research-python> <packet.json> */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {z} from 'zod'
import {runCycle} from './reference-design-cycle'
import {generatorParameters,parseGenerator} from './reference-design-generator'
import {ownedBlock} from './reference-design-operating-pzr'
import {parseSteamValveTravel} from './reference-design-operating-sg'

const positive=z.number().finite().positive()
export const electricalOwners={
  generator:{page:'systems/electrical/generator-and-synchronization.md'},
  switching:{page:'systems/electrical/generator-and-synchronization.md',heading:'Breaker movement and passive opening',fence:'ld01-generator-switching'},
  /** Owner decisions D2 and R6-K SW-1 (15 Oct 2026): the carrier as a continuous, smooth input (frequency and its rate held per interval), no per-boundary angle conversion. */
  carrier:{page:'systems/electrical/generator-and-synchronization.md',heading:'External carrier and operating Grid join',fence:'ld01-generator-carrier'},
  /** The field controller's field-supply-loss protection (generator OPEN plus turbine trip): its reports' timing. */
  fieldProtection:{page:'systems/electrical/generator-and-synchronization.md',heading:'Field-supply loss and control-power failure',fence:'ld01-generator-field-protection'},
  shaft:{page:'systems/steam-power/shaft-torque-and-rolling.md',heading:'Rotor and loss connection',fence:'ld01-shaft-drag'},
  distribution:{page:'systems/electrical/distribution-and-switching.md',heading:'Sources and distribution',fence:'ld01-ac-distribution'},
  cycle:{page:'systems/steam-power/cycle-basis.md'},
  admission:{page:'systems/steam-power/admission-and-protection.md'},
} as const
export const electricalPages=[electricalOwners.generator.page,electricalOwners.shaft.page,electricalOwners.distribution.page,
  electricalOwners.cycle.page,electricalOwners.admission.page] as const

const switchingSchema=z.object({breakerTravel_s:positive,breakerClosingWork_J:positive,breakerSpringStock_J:positive,
  breakerBodyCapacity_J_K:positive,breakerBodyRoomConductance_W_K:positive,breakerBodyInitial_C:z.number().finite(),
  fieldConverterEfficiency:positive.max(1)}).strict()
  .refine(s=>s.breakerSpringStock_J<=s.breakerClosingWork_J,'The stocked spring energy cannot exceed the closing work')
/** D2's selection: the native machine owner implements exactly these values and refuses a packet without them. */
const carrierSchema=z.object({angleReference:z.literal('continuousCarrier'),rateInput:z.literal('frequencyAndRatePerInterval'),
  reconciliation:z.literal('phaseErrorAsRateOverNextInterval'),boundaryConversion:z.literal('none'),rateChangeClass:z.literal('S3-D4')}).strict()
/** Whole-frame report timing on the I&C's 0.1 s frame is the runtime's check; here: positive sampling/transport,
 * an age at least one transport, and no additional qualification (the page selects none). */
const fieldProtectionSchema=z.object({reportSample_s:positive,reportTransport_s:positive,reportMaximumAge_s:positive,
  additionalQualification_s:z.literal(0),connectionReportSample_s:positive,connectionReportTransport_s:positive,
  connectionReportMaximumAge_s:positive}).strict()
  .refine(f=>f.reportMaximumAge_s>=f.reportTransport_s&&f.connectionReportMaximumAge_s>=f.connectionReportTransport_s,
    'A report\'s maximum age cannot be shorter than its transport')
/** Owner decision D1 (15 Oct 2026): the adaptive plant <-> Grid exchange, on the interval handoff's page. Read by the
 * (test-only) Grid stand-in: the exchange law is the Grid side's, the plant follows each request. */
export const exchangeOwner={page:'model/operating-scale-realization.md',heading:'Selected electrical interval handoff',fence:'ld01-electrical-exchange'} as const
const exchangeSchema=z.object({quietInterval_s:positive,windowInterval_s:positive,refinementInterval_s:positive,
  windowDeclaredBy:z.literal('Grid'),receipt:z.literal('IDAS quadrature')}).strict()
  .refine(x=>x.refinementInterval_s<x.windowInterval_s&&x.windowInterval_s<x.quietInterval_s,'Exchange intervals must be ordered refinement < window < quiet')
const shaftSchema=z.object({dragPowerAtReference_W:positive,referenceSpeed_rpm:positive}).strict()
const bus=z.enum(['AC.A','AC.B'])
const distributionSchema=z.object({incomingTravel_s:positive,transferOpenInterval_s:positive,motorDropout_s:positive,
  qualification:z.object({voltageMin_pu:positive,voltageMax_pu:positive,frequencyMin_Hz:positive,frequencyMax_Hz:positive,
    qualify_s:positive,disqualify_s:positive}).strict()
    .refine(q=>q.voltageMin_pu<q.voltageMax_pu&&q.frequencyMin_Hz<q.frequencyMax_Hz,'Qualification bands must be ordered'),
  conversionNoLoadLoss_W:positive,conversionLoadLossFraction:positive.lt(1),sourceBudget_W:positive,busBudget_W:positive,
  motorConsumers:z.record(z.string().regex(/^LD01\./),bus).refine(c=>Object.keys(c).length>0,'At least one motor consumer'),
  fieldConverterBus:bus}).strict()

export const parseSwitching=(generatorPage:string)=>switchingSchema.parse(ownedBlock(generatorPage,electricalOwners.switching.heading,electricalOwners.switching.fence))
export const parseCarrier=(generatorPage:string)=>carrierSchema.parse(ownedBlock(generatorPage,electricalOwners.carrier.heading,electricalOwners.carrier.fence))
export const parseFieldProtection=(generatorPage:string)=>fieldProtectionSchema.parse(ownedBlock(generatorPage,electricalOwners.fieldProtection.heading,electricalOwners.fieldProtection.fence))
export const parseExchange=(handoffPage:string)=>exchangeSchema.parse(ownedBlock(handoffPage,exchangeOwner.heading,exchangeOwner.fence))
export const parseShaftDrag=(shaftPage:string)=>shaftSchema.parse(ownedBlock(shaftPage,electricalOwners.shaft.heading,electricalOwners.shaft.fence))
export const parseDistribution=(distributionPage:string)=>distributionSchema.parse(ownedBlock(distributionPage,electricalOwners.distribution.heading,electricalOwners.distribution.fence))

type Cycle=Awaited<ReturnType<typeof runCycle>>
const intervalPoints=[['main_steam','HP_bleed'],['HP_bleed','HP_separator_inlet'],['LP_reheat_inlet','LP_bleed'],
  ['LP_bleed','LP_lowest_bleed'],['LP_lowest_bleed','LP_exhaust']] as const

/** The pure compilation over the owners' texts and the cycle calculator's result. */
export function compileOperatingElectrical(texts:{generator:string,shaft:string,distribution:string,admission:string},cycle:Cycle){
  const basis=parseGenerator(texts.generator),g=generatorParameters(basis)
  const switching=parseSwitching(texts.generator),carrier=parseCarrier(texts.generator),fieldProtection=parseFieldProtection(texts.generator),drag=parseShaftDrag(texts.shaft),routing=parseDistribution(texts.distribution)
  const travel=parseSteamValveTravel(texts.admission)
  const omega0=drag.referenceSpeed_rpm*2*Math.PI/60
  if(Math.abs(omega0-g.speed)>1e-12*omega0)throw Error('Shaft reference speed differs from the generator synchronous speed')
  const b=cycle.basis,f=cycle.flows,eta=[b.HPTurbineEfficiency,b.HPTurbineEfficiency,b.LPTurbineEfficiency,b.LPTurbineEfficiency,b.LPTurbineEfficiency]
  const fractions=[1-f.reheat_fraction,1-f.reheat_fraction-f.high_heater_fraction,f.LP_inlet_fraction,
    f.LP_inlet_fraction-f.low_heater_fraction,f.LP_exhaust_fraction]
  const actual=intervalPoints.map(([i,o])=>1000*(cycle.points[i].h_kJ_kg-cycle.points[o].h_kJ_kg))
  const drops=actual.map((a,i)=>a/eta[i]!)
  // the cycle's own work identity: sum(fraction * actual drop) * SG steam = thermodynamic work
  const work=fractions.reduce((s,x,i)=>s+x*actual[i]!,0)*f.SG_total_kg_s,reference=cycle.powers_MW.turbine_thermodynamic_work*1e6
  if(!(fractions.every(x=>x>0&&x<=1)&&drops.every(x=>x>0))||Math.abs(work-reference)>1e-9*reference)
    throw Error('Interval fractions do not reproduce the cycle work')
  const loadLossFraction=(1-b.shaftMechanicalEfficiency)-drag.dragPowerAtReference_W/reference
  if(!(loadLossFraction>=0&&loadLossFraction<1))throw Error('Shaft load-loss fraction outside [0,1)')
  const packet={
    slice:{
      generator:{statorInductance_H:g.statorInductance,mutual_H:g.mutual,fieldInductance_H:g.fieldInductance,
        statorResistance_ohm:g.resistance,fieldResistance_ohm:g.fieldResistance,polePairs:basis.polePairs},
      shaftInertia_kg_m2:g.inertia,
      turbine:{intervals:drops.map((d,i)=>({radius_m:Math.sqrt(2*d)/(2*omega0),efficiency:eta[i]!})),
        flowFractions:fractions,referenceDrops_J_kg:drops,
        losses:{loadLossFraction,drag_Nm_per_rad_s:drag.dragPowerAtReference_W/omega0**2}},
      breakerBody:{capacity_J_K:switching.breakerBodyCapacity_J_K,roomConductance_W_K:switching.breakerBodyRoomConductance_W_K},
      fieldConverterEfficiency:switching.fieldConverterEfficiency},
    breaker:{travel_s:switching.breakerTravel_s,closingWork_J:switching.breakerClosingWork_J,springStock_J:switching.breakerSpringStock_J},
    distribution:{incomingTravel_s:routing.incomingTravel_s,transferOpenInterval_s:routing.transferOpenInterval_s,motorDropout_s:routing.motorDropout_s,
      qualification:routing.qualification,conversionNoLoadLoss_W:routing.conversionNoLoadLoss_W,
      conversionLoadLossFraction:routing.conversionLoadLossFraction,sourceBudget_W:routing.sourceBudget_W,busBudget_W:routing.busBudget_W,
      consumers:routing.motorConsumers},
    fieldConverterBus:routing.fieldConverterBus,
    carrier,
    fieldProtection,
    boundary:{lineVoltage_V:basis.lineVoltage_V,frequency_Hz:basis.frequency_Hz,base_VA:basis.base_VA},
    prepared:{initialFlux:g.initialFlux,speed_rad_s:g.speed,angle_rad:g.angle,fieldCurrent_A:basis.fieldCurrent_A,
      fieldDemand_V:g.fieldResistance*basis.fieldCurrent_A,admittedSteam_kg_s:f.SG_total_kg_s,
      /** FIXTURE: ROOM.B belongs to the support-services thermal owner; taken at the breaker body's initial temperature. */
      room_K:switching.breakerBodyInitial_C+273.15},
    steamValveTravel:travel,
    /** FIXTURE: consumer electrical demands for the routing account only (the pump owners' laws supply them in the joined spine). */
    fixtureConsumerDemand_W:Object.fromEntries(Object.keys(routing.motorConsumers).map(k=>[k,
      k.startsWith('LD01.P.')?cycle.powers_MW.RCP_electric*1e6/4:k.startsWith('LD01.FW.P')?cycle.powers_MW.feed_pump_electric*1e6/2:0])),
  }
  return packet
}

const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
export async function prepareOperatingElectrical(wikiRoot:string,python:string){
  const root='world/packs/process-plant/reference-designs/ld-01/'
  const docs=await Promise.all(electricalPages.map(p=>Bun.file(join(wikiRoot,root,p)).text()))
  const [generator,shaft,distribution,cycleText,admission]=docs as [string,string,string,string,string]
  const cycle=await runCycle(cycleText,python)
  const packet=compileOperatingElectrical({generator,shaft,distribution,admission},cycle)
  const after=await Promise.all(electricalPages.map(p=>Bun.file(join(wikiRoot,root,p)).text()))
  if(after.some((d,i)=>d!==docs[i]))throw Error('An owner page changed during compilation')
  return {...packet,provenance:{packetSha256:hash(JSON.stringify(packet)),sourceSha256:hash(await Bun.file(import.meta.path).text()),
    cycleInputSha256:cycle.inputSha256,cycleCalculationSha256:cycle.calculationSha256,
    consumed:electricalPages.map((p,i)=>({name:root+p,sha256:hash(docs[i]!)}))}}
}

if(import.meta.main){
  const [wikiRoot,python,target,...extra]=Bun.argv.slice(2)
  if(!wikiRoot||!python||!target||extra.length)throw Error('Usage: bun reference-design-operating-electrical.ts <wiki root> <research-python> <packet.json>')
  const packet=await prepareOperatingElectrical(wikiRoot,python)
  await Bun.write(target,JSON.stringify(packet,null,2)+'\n')
  console.log(JSON.stringify({target,packetSha256:packet.provenance.packetSha256}))
}
