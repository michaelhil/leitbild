/** Strict S2 SG secondary section of the joined packet, for the native owner
 * (operating/src/sg.rs, the joined spine's `Secondary` block). Every value
 * comes from one owner's strict block; the Rust block derives the relief
 * area and the feed enthalpy with its runtime laws, and takes its prepared
 * stocks from the joined packet's thermal secondaries. No property, law or
 * state is computed here, and nothing is defaulted.
 *
 * `prepareOperatingSecondary` is the one section compiler the joined packet
 * composes under its top-level `secondary` key. `prepareSgProbe` compiles the
 * separate probe section of zero-time receipts and isolated probes only.
 * Usage: bun reference-design-operating-sg.ts <wiki root> <section.json> */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {z} from 'zod'
import {parseBalanceBasis} from './reference-design-balance'
import {parseBypassControl,parseBypassNoLoad} from './reference-design-bypass'
import {parseCycleBasis} from './reference-design-cycle'
import {parseHydraulicBasis} from './reference-design-hydraulics'
import {parseOperatingHotReference} from './reference-design-operating-fluid'
import {ownedBlock} from './reference-design-operating-pzr'
import {foldedGeometry,parsePrimaryMechanics} from './reference-design-primary-mechanics'
import {parseSgContact,sgContactOwner,sgContactSection,sgTubeBundle} from './reference-design-sg-contact-law'

const positive=z.number().finite().positive()
const exposureSchema=z.object({bottom_m:positive,top_m:positive,crownTop_m:positive,upperZoneArea_m2:positive}).strict()
  .refine(e=>e.bottom_m<e.crownTop_m&&e.crownTop_m<e.top_m,'The crown must lie inside the contact span')
const pickupSchema=z.object({pickupBottom_m:positive,pickupTop_m:positive}).strict()
  .refine(p=>p.pickupBottom_m<p.pickupTop_m,'The pickup span must be ordered')
const boundariesSchema=z.object({steamDemand_kg_s:z.object({A:positive,B:positive}).strict(),
  steamDonor:z.literal('pickupGas'),feedRule:z.literal('inventoryHolding')}).strict()
const travelSchema=z.object({sgIsolation_s:positive,turbineStop_s:positive,reheaterIsolation_s:positive,
  admission_s:positive,bypass_s:positive}).strict()
/** R12-B2: one relief, then one safety valve per SG, each with its own
 * absolute settings, and the declared SG design pressure. */
const valveSettingSchema=z.object({role:z.enum(['relief','safety']),crackPressure_Pa:positive,fullLiftPressure_Pa:positive,
  reseatPressure_Pa:positive}).strict()
const reliefSchema=z.object({valves:z.array(valveSettingSchema),designPressure_Pa:positive,
  liftLag_s:positive,seatLagTimeConstants:positive,backPressure_Pa:positive,descendingSwitch:z.literal('inletAtFullLift'),
  rating:z.object({fractionOfNominalFlow:positive.max(1),nominalFlow_kg_s:positive,fluid:z.literal('saturatedVapor'),
    inletPressure_Pa:positive}).strict()}).strict()
  .superRefine((r,c)=>{
    for(const v of r.valves)
      if(!(r.backPressure_Pa<v.reseatPressure_Pa&&v.reseatPressure_Pa<v.crackPressure_Pa&&v.crackPressure_Pa<v.fullLiftPressure_Pa))
        c.addIssue({code:'custom',message:'Relief needs receiver < reseat < crack < full lift'})
    if(r.valves.map(v=>v.role).join()!=='relief,safety')c.addIssue({code:'custom',message:'One relief, then one safety valve per SG'})
    else if(!(r.valves[0]!.crackPressure_Pa<r.valves[1]!.crackPressure_Pa&&r.valves[1]!.crackPressure_Pa<=r.designPressure_Pa))
      c.addIssue({code:'custom',message:'The relief cracks below the safety valve, the safety valve at or below design pressure'})
    if(!r.valves.every(v=>v.fullLiftPressure_Pa<=1.1*r.designPressure_Pa))
      c.addIssue({code:'custom',message:'Every full lift within 110% of the design pressure'})
    if(!(r.rating.inletPressure_Pa>r.backPressure_Pa))c.addIssue({code:'custom',message:'Relief rating inlet must exceed the receiver'})
  })

const root='world/packs/process-plant/reference-designs/ld-01/'
/** Strict blocks that lie under an owning heading. */
export const sgOwners={
  exposure:{page:'systems/steam-generation/thermodynamics.md',heading:'Secondary exposure and local metal storage',fence:'ld01-sg-exposure'},
  pickup:{page:'systems/steam-generation/thermodynamics.md',heading:'Upper pickup, overfill and actual exported material',fence:'ld01-sg-pickup'},
  contact:sgContactOwner,
  boundaries:{page:'systems/steam-generation/thermodynamics.md',heading:'Emergent full-power SG pressure',fence:'ld01-s2-sg-boundaries'},
  relief:{page:'systems/steam-power/admission-and-protection.md',heading:'Turbine trip and reset semantics',fence:'ld01-sg-relief'},
  travel:{page:'systems/steam-power/admission-and-protection.md',heading:'Flow law and nominal sizing',fence:'ld01-steam-valve-travel'},
} as const
export const sectionPages=['systems/steam-generation/thermodynamics.md','systems/steam-power/admission-and-protection.md',
  'numerical-basis.md','systems/steam-power/cycle-basis.md','model/primary-hydraulic-basis.md',
  'systems/primary-coolant/mechanical-energy-and-geometry.md'] as const
export const probePages=['systems/steam-generation/thermodynamics.md','numerical-basis.md','model/operating-hot-reference.md',
  'systems/primary-coolant/mechanical-energy-and-geometry.md'] as const
export type SectionSources={thermodynamics:string,admission:string,balance:string,cycle:string,hydraulics:string,mechanics:string}
export type ProbeSources={thermodynamics:string,balance:string,hot:string,mechanics:string}
const SGS=['A','B'] as const

export const parseSgRelief=(admission:string)=>reliefSchema.parse(ownedBlock(admission,sgOwners.relief.heading,sgOwners.relief.fence))
export const parseSgBoundaries=(thermodynamics:string)=>
  boundariesSchema.parse(ownedBlock(thermodynamics,sgOwners.boundaries.heading,sgOwners.boundaries.fence))
export const parseSteamValveTravel=(admission:string)=>travelSchema.parse(ownedBlock(admission,sgOwners.travel.heading,sgOwners.travel.fence))
export {parseSgContact}

/** The two-zone contact coordinate (S3-D26) of `ld01-sg-exposure` for the
 * selected free volume: above the crown the free volume has the upper
 * zone's area; the bundle zone below the crown holds the rest of the
 * selected volume, uniformly over its height. */
export function sgExposure(thermodynamics:string,volume_m3:number){
  const e=exposureSchema.parse(ownedBlock(thermodynamics,sgOwners.exposure.heading,sgOwners.exposure.fence))
  const bundleZoneVolume_m3=volume_m3-(e.top_m-e.crownTop_m)*e.upperZoneArea_m2
  if(!(bundleZoneVolume_m3>0))throw Error('The upper zone leaves no bundle-zone volume below the crown')
  return {bottom_m:e.bottom_m,crownTop_m:e.crownTop_m,top_m:e.top_m,bundleZoneVolume_m3,upperZoneArea_m2:e.upperZoneArea_m2}
}
/** The folded tube path the contact map wets: `reference-hydraulics` inlet
 * port, crest and outlet port, `reference-primary-mechanics` developed
 * length, realizable as straight legs and a semicircular crown. The
 * exposure's bundle zone must span exactly the fold's start to its crest. */
export function sgFold(hydraulics:string,mechanics:string,exposure:ReturnType<typeof sgExposure>){
  const hb=parseHydraulicBasis(hydraulics),developedLength_m=parsePrimaryMechanics(mechanics).sgDevelopedLength_m
  foldedGeometry(developedLength_m,hb.hotPort_m,hb.SGturn_m,hb.coldPort_m)
  if(exposure.bottom_m!==hb.hotPort_m||exposure.crownTop_m!==hb.SGturn_m)
    throw Error('The exposure bundle zone must span the fold start to its crest')
  return {developedLength_m,inlet_m:hb.hotPort_m,crest_m:hb.SGturn_m,outlet_m:hb.coldPort_m}
}
/** Liquid volume whose contact surface is at `height`. */
const contactLiquid=(x:ReturnType<typeof sgExposure>,height:number)=>height<=x.crownTop_m
  ?x.bundleZoneVolume_m3*(height-x.bottom_m)/(x.crownTop_m-x.bottom_m)
  :x.bundleZoneVolume_m3+(height-x.crownTop_m)*x.upperZoneArea_m2

/** The guard volumes from the contact coordinate: the crown's first
 * uncovery and the pickup's first coverage, with the map they come from. */
function guards(thermodynamics:string,volume_m3:number){
  const exposure=sgExposure(thermodynamics,volume_m3),
    pickup=pickupSchema.parse(ownedBlock(thermodynamics,sgOwners.pickup.heading,sgOwners.pickup.fence))
  if(!(exposure.crownTop_m<pickup.pickupBottom_m&&pickup.pickupTop_m<=exposure.top_m))
    throw Error('Pickup outside the upper zone of the contact span')
  return {crown_m3:contactLiquid(exposure,exposure.crownTop_m),pickup_m3:contactLiquid(exposure,pickup.pickupBottom_m),exposure}
}

/** The G1 stand-in's post-trip modes: R4-DUMP's Tavg mode after the reactor
 * and turbine trips with forced circulation, and R12-B1's no-load pressure mode after the
 * turbine trip without it, with the selected band width and rating fraction
 * of `ld01-bypass-control` (one numeric owner each). */
export function bypassNoLoad(admission:string){
  const noLoad=parseBypassNoLoad(admission),control=parseBypassControl(admission)
  return {mode:noLoad.mode,noLoadAverageTemperature_K:noLoad.noLoadAverageTemperature_K,noLoadPressure_Pa:noLoad.noLoadPressure_Pa,
    bandWidth_Pa:control.bandFull_Pa-control.bandStart_Pa,fractionOfNominalSteam:control.rating.fractionOfTotalSteam,
    tavgInput:noLoad.tavgInput,tavgDeadBand_K:noLoad.tavgDeadBand_K,tavgBandWidth_K:noLoad.tavgBandWidth_K,
    withoutForcedCirculation:noLoad.withoutForcedCirculation}
}

/** The joined packet's `secondary` section: per SG (the thermal
 * secondaries' A/B order) its volume, constant demand, guard volumes and
 * valves; the relief characteristic, seat and rating; the feed boundary; the
 * STOP travel of the trip ramp; and the contact law's exchange area and wall
 * constants for the joined solids' films. */
export function compileOperatingSecondary(d:SectionSources){
  const boundaries=parseSgBoundaries(d.thermodynamics),relief=parseSgRelief(d.admission),travel=parseSteamValveTravel(d.admission),
    balance=parseBalanceBasis(d.balance),cycle=parseCycleBasis(d.cycle),g=guards(d.thermodynamics,balance.secondaryVolume_m3),
    prepared=balance.secondaryLiquidVolume_m3,feedPressure=cycle.feedHeaderPressure_MPaAbs*1e6
  if(balance.steamGenerators!==2||cycle.steamGenerators!==2)throw Error('Two steam generators expected')
  if(!(g.crown_m3<prepared&&prepared<g.pickup_m3))throw Error('Prepared liquid volume outside the crown/pickup guard band')
  const bypass=bypassNoLoad(d.admission)
  if(!(bypass.noLoadPressure_Pa+bypass.bandWidth_Pa<relief.valves[0]!.crackPressure_Pa))
    throw Error('The bypass must open fully below the SG relief crack (R12-B1, R12-B2)')
  return {scope:'S2 SG secondaries: one bulk-equilibrium volume per SG with the constant A/B demand and its STOP ramp, the inventory-holding feed and a spring relief and a spring safety valve per SG (R12-B2), and after the trip the bypass post-trip modes (R4-DUMP Tavg mode with forced circulation, R12-B1 no-load pressure mode without; G1 stand-in); Rust owns the laws and derivations, the joined solids the metal and films',
    steamGenerators:SGS.map(id=>({id,volume_m3:balance.secondaryVolume_m3,steamDemand_kg_s:boundaries.steamDemand_kg_s[id],
      crownLiquidVolume_m3:g.crown_m3,pickupLiquidVolume_m3:g.pickup_m3,
      reliefs:relief.valves.map((_,i)=>({id:`SG.${id}.RELIEF.${i+1}`}))})),
    relief:{valves:relief.valves,designPressure_Pa:relief.designPressure_Pa,
      liftLag_s:relief.liftLag_s,seatLagTimeConstants:relief.seatLagTimeConstants,backPressure_Pa:relief.backPressure_Pa,descendingSwitch:relief.descendingSwitch,
      rating:{massFlow_kg_s:relief.rating.fractionOfNominalFlow*relief.rating.nominalFlow_kg_s,inletPressure_Pa:relief.rating.inletPressure_Pa,
        fluid:relief.rating.fluid}},
    feed:{rule:boundaries.feedRule,pressure_Pa:feedPressure,temperature_K:cycle.feedInlet_C+273.15},
    steamAdmission:{stopTravel_s:travel.turbineStop_s},
    bypass,
    contact:sgContactSection(d.thermodynamics,parsePrimaryMechanics(d.mechanics).sgDevelopedLength_m),
    exposure:{fold:sgFold(d.hydraulics,d.mechanics,g.exposure),bundleZoneVolume_m3:g.exposure.bundleZoneVolume_m3,
      upperZoneArea_m2:g.exposure.upperZoneArea_m2}}
}

/** Probe inputs of zero-time receipts and isolated probes only: the selected
 * hot preparation, the prepared SG primary cell held with the supplied
 * per-SG flows, and the tube path's diameter and segments; its wall
 * constants are the section's `contact`. */
export function compileSgProbe(d:ProbeSources,primaryMassFlow_kg_s:{A:number,B:number}){
  if(![primaryMassFlow_kg_s.A,primaryMassFlow_kg_s.B].every(m=>Number.isFinite(m)&&m>0))throw Error('Positive primary flows required')
  const balance=parseBalanceBasis(d.balance),hot=parseOperatingHotReference(d.hot),
    mechanics=parsePrimaryMechanics(d.mechanics),contact=parseSgContact(d.thermodynamics),
    n=hot.sgMetalSegments,L=mechanics.sgDevelopedLength_m,bundle=sgTubeBundle(contact,L)
  return {preparation:{secondaryPressure_Pa:balance.secondaryPressure_MPaAbs*1e6,liquidVolume_m3:balance.secondaryLiquidVolume_m3,
      metalColdTemperature_K:balance.coreInlet_C+273.15},
    // The SG primary cell: the hot reference's pressure, its 290 °C start
    // and the tube film's flow area (X4.5, `ld01-sg-contact`).
    primary:{pressure_Pa:hot.primaryPressure_Pa,temperature_K:balance.coreInlet_C+273.15,
      inletTemperature_K:balance.coreOutlet_C+273.15,flowArea_m2:bundle.filmFlowArea_m2,massFlow_kg_s:SGS.map(id=>primaryMassFlow_kg_s[id])},
    tube:{thermalDiameter_m:bundle.thermalDiameter_m},
    segments:Array.from({length:n},(_,i)=>({developedStart_m:i*L/n,developedEnd_m:(i+1)*L/n,
      exchangeArea_m2:bundle.exchangeArea_m2/n,capacity_J_K:balance.wallCapacity_MJ_K*1e6/n}))}
}

const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
async function read(wikiRoot:string,pages:readonly string[]){
  const docs=await Promise.all(pages.map(p=>Bun.file(join(wikiRoot,root,p)).text()))
  return {docs,provenance:{sourceSha256:hash(await Bun.file(import.meta.path).text()),
    consumed:pages.map((p,i)=>({name:root+p,sha256:hash(docs[i]!)}))}}
}

/** The joined packet's `secondary` section, read from a wiki checkout. */
export async function prepareOperatingSecondary(wikiRoot:string){
  const {docs,provenance}=await read(wikiRoot,sectionPages),
    [thermodynamics,admission,balance,cycle,hydraulics,mechanics]=docs as [string,string,string,string,string,string]
  return {...compileOperatingSecondary({thermodynamics,admission,balance,cycle,hydraulics,mechanics}),provenance}
}

/** The probe section, read from a wiki checkout, with declared flows. */
export async function prepareSgProbe(wikiRoot:string,primaryMassFlow_kg_s:{A:number,B:number}){
  const {docs,provenance}=await read(wikiRoot,probePages),
    [thermodynamics,balance,hot,mechanics]=docs as [string,string,string,string]
  return {...compileSgProbe({thermodynamics,balance,hot,mechanics},primaryMassFlow_kg_s),provenance}
}

if(import.meta.main){
  const [wiki,output,...rest]=Bun.argv.slice(2)
  if(!wiki||!output||rest.length)throw Error('Usage: reference-design-operating-sg <wiki root> <section.json>')
  await Bun.write(output,JSON.stringify(await prepareOperatingSecondary(wiki),null,2)+'\n')
}
