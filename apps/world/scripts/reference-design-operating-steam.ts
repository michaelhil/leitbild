/** Strict C10 packet (steam, turbine and condenser) for the Gate-1 compact
 * allocation: `turbine-and-regeneration-dynamics.md#compact-operating-allocation-15-october-2026`.
 * Every value comes from one owner's strict block, or from an existing named
 * calculator over such a block (runCycle over `reference-cycle`,
 * parseTurbinePreparation over `reference-turbine-preparation`). Nothing is
 * defaulted, and a missing, extra or inconsistent value refuses compilation.
 * Effective areas, conductances and native states are not computed here:
 * the runtime laws derive them once from the sizing points this packet
 * names, as the SG relief area is derived. The packet is consumed only by
 * the test-only Gate-1 prototype (water-ffi/tests/g1_c10_steam.rs); it is
 * not joined to the kernel.
 * Usage: bun reference-design-operating-steam.ts <wiki root> <research-python> <packet.json> <c09-receivers.json> <c12-support-receipt.json> */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {z} from 'zod'
import {runCycle} from './reference-design-cycle'
import {generatorParameters,parseGenerator} from './reference-design-generator'
import {parseShaftDrag} from './reference-design-operating-electrical'
import {parseOperatingHotReference} from './reference-design-operating-fluid'
import {ownedBlock} from './reference-design-operating-pzr'
import {parseSteamValveTravel} from './reference-design-operating-sg'
import {bypassOwners,parseBypassControl} from './reference-design-bypass'
import {parseTurbinePreparation} from './reference-design-turbine-preparation'

const compact='Compact operating allocation (15 October 2026)'
export const steamOwners={
  stocks:{page:'systems/steam-power/turbine-and-regeneration-dynamics.md',heading:'Strict blocks',fence:'ld01-steam-stocks'},
  preparation:{page:'systems/steam-power/turbine-and-regeneration-dynamics.md',heading:'Strict blocks',fence:'ld01-steam-preparation'},
  drains:{page:'systems/steam-power/turbine-and-regeneration-dynamics.md',heading:'Strict blocks',fence:'ld01-msr-drain-control'},
  governor:{page:'systems/steam-power/turbine-and-regeneration-dynamics.md',heading:'Strict blocks',fence:'ld01-governor'},
  bypass:bypassOwners.control,
  protection:{page:'systems/steam-power/admission-and-protection.md',heading:compact,fence:'ld01-condenser-protection'},
  actuators:{page:'systems/steam-power/admission-and-protection.md',heading:compact,fence:'ld01-steam-actuators'},
  condenser:{page:'systems/steam-power/condenser-and-cooling.md',heading:compact,fence:'ld01-condenser'},
  gases:{page:'systems/steam-power/condenser-and-cooling.md',heading:compact,fence:'ld01-noncondensable-gases'},
} as const
export const steamPages=['systems/steam-power/turbine-and-regeneration-dynamics.md','systems/steam-power/admission-and-protection.md',
  'systems/steam-power/condenser-and-cooling.md','systems/steam-power/shaft-torque-and-rolling.md','systems/steam-power/cycle-basis.md',
  'systems/steam-power/cold-casing-and-admission.md','model/operating-hot-reference.md','systems/electrical/generator-and-synchronization.md'] as const

const pos=z.number().finite().positive(),fraction=pos.max(1),finite=z.number().finite()
const stocksSchema=z.object({header_m3:pos,hpAdmission_m3:pos,hpExtraction_m3:pos,separator_m3:pos,reheaterProcess_m3:pos,
  reheaterShell_m3:pos,lpFirst_m3:pos,lpSecond_m3:pos,reheaterWall_J_K:pos,separatorArea_m2:pos,
  separatorPickup_m3:z.tuple([pos,pos]),drainPickupFraction:fraction}).strict()
  .refine(s=>s.separatorPickup_m3[0]<s.separatorPickup_m3[1]&&s.separatorPickup_m3[1]<s.separator_m3,'Separator pickup span must be ordered inside the vessel')
const preparationSchema=z.object({mainSteamLoss_Pa:pos,stopAdmissionLoss_Pa:pos,stopAdmissionShare:fraction,
  hpExtraction_Pa:pos,separator_Pa:pos,separatorLiquid_m3:pos,reheaterProcess_Pa:pos,reheaterProcess_C:finite,lpFirst_Pa:pos,
  lpSecond_Pa:pos,reheaterShellPressureFactor:fraction,reheaterShellLiquid_m3:pos,
  separatorReheaterSizing:z.object({flow_kg_s:pos,inlet_Pa:pos,outlet_Pa:pos,cdA_m2:pos}).strict(),
  preparedOpen:z.array(z.string()),preparedClosed:z.array(z.string()),preparedDrainOpening:fraction}).strict()
const drainsSchema=z.object({
  separatorDrain:z.object({bias:fraction,gain_per_m:pos,setpoint_m:pos,sample_s:pos,travel_s:pos,sizingOpening:fraction}).strict(),
  separatorEmergencyDrain:z.object({travel_s:pos,prepared:z.literal('CLOSED')}).strict(),
  reheaterDrain:z.object({bias:fraction,gain:pos,target:fraction,sample_s:pos,travelRate_per_s:pos,sizingOpening:fraction}).strict(),
}).strict()
const governorSchema=z.object({sample_s:pos,droop:fraction,setpointRamp_per_s:pos,proportional:pos,integral_per_s:pos,base_W:pos,overspeed_pu:pos.gt(1)}).strict()
const protectionSchema=z.object({backpressureTrip_Pa:pos,backpressurePersistence_s:pos,unavailableTrip_s:pos,resetBelow_Pa:pos,resetHold_s:pos,
  channel:z.object({rangeMin_Pa:z.number().finite().nonnegative(),rangeMax_Pa:pos,lag_s:pos,sample_s:pos,transport_s:pos,maxAge_s:pos}).strict()}).strict()
  .refine(p=>p.resetBelow_Pa<p.backpressureTrip_Pa&&p.backpressureTrip_Pa<p.channel.rangeMax_Pa,'Reset, trip and range must be ordered')
const condenserSchema=z.object({shell_m3:pos,liquid_m3:pos,vapor_m3:pos,prepared_C:pos,hotwellArea_m2:pos,surface_m:finite,pumpEye_m:finite,
  manifold_m:finite,manifoldCovered_m3:pos,wallCapacity_J_K:pos,waterCell_m3:pos,cellPrepared_C:z.tuple([pos,pos]),wallPrepared_C:z.tuple([pos,pos]),
  cellDuty_W:pos,condensing_C:pos,sizingDensity_kg_m3:pos,sizingCp_J_kgK:pos,cellElevation_m:finite,
  historicalCellOverAtmosphere_Pa:z.tuple([pos,pos]),preparedPort:z.object({cwFlow_kg_s:pos,cwInlet_C:pos}).strict()}).strict()
  .refine(c=>c.historicalCellOverAtmosphere_Pa[0]>c.historicalCellOverAtmosphere_Pa[1],'Cell 1 lies upstream of cell 2')
const valveIds=['MS.ISO.A','MS.ISO.B','TG.STOP','TG.ADM','TG.RH.ISO','TG.BYP','TG.SEP.DRAIN','TG.SEP.EMERGENCY','TG.RH.DRAIN'] as const
const actuatorsSchema=z.object({isolationMotion_W:pos,openingMotion_W:pos,springStockShare:fraction,holding_W:pos,controllerElectronics_W:pos,
  drainMotion_W:pos,drainElectronics_W:pos,groups:z.object(Object.fromEntries(valveIds.map(v=>[v,z.enum(['ACT.A','ACT.B'])]))).strict(),
  springReturn:z.array(z.enum(valveIds)),retainOnSupplyLoss:z.array(z.enum(valveIds))}).strict()
  .refine(a=>{const all=[...a.springReturn,...a.retainOnSupplyLoss];return all.length===valveIds.length&&new Set(all).size===valveIds.length},
    'Every steam valve needs exactly one supply-loss behaviour')
const gasSchema=z.object({gasConstant_J_kgK:pos,cv_J_kgK:pos}).strict()
const gasesSchema=z.object({air:gasSchema,nitrogen:gasSchema,energyReference_K:pos}).strict()
/** C09's prepared receiving shells (P5, P6). C09 owns the number; C10 reads it, never copies it into its own block. */
const receiversSchema=z.object({h1Shell_Pa:pos,h2Shell_Pa:pos,h4Shell_Pa:pos,source:z.string().min(1)}).strict()

const parse=<T extends z.ZodTypeAny>(schema:T,text:string,owner:{heading:string,fence:string})=>schema.parse(ownedBlock(text,owner.heading,owner.fence)) as z.infer<T>
export const parseSteamStocks=(t:string)=>parse(stocksSchema,t,steamOwners.stocks)
export const parseSteamPreparation=(t:string)=>parse(preparationSchema,t,steamOwners.preparation)
export const parseMsrDrains=(t:string)=>parse(drainsSchema,t,steamOwners.drains)
export const parseGovernor=(t:string)=>parse(governorSchema,t,steamOwners.governor)
export const parseCondenserProtection=(t:string)=>parse(protectionSchema,t,steamOwners.protection)
export const parseCondenser=(t:string)=>parse(condenserSchema,t,steamOwners.condenser)
export const parseNoncondensables=(t:string)=>parse(gasesSchema,t,steamOwners.gases)
export const parseSteamActuators=(t:string)=>parse(actuatorsSchema,t,steamOwners.actuators)
export const parseReceivers=(v:unknown)=>receiversSchema.parse(v)
/** C12's prepared circulating-water port (P9) from C12's own computed receipt: the residual header head,
 * the condenser flow, the cell-1 inlet total enthalpy and C12's atmosphere. C10 copies no number. */
const c12Schema=z.object({packetSha256:z.string().regex(/^[0-9a-f]{64}$/),
  circulating:z.object({headerResidualHead_Pa:pos,condenser_kg_s:pos,inletTotalEnthalpy_J_kg:pos}).passthrough(),
  provenance:z.object({compiledPacket:z.object({s5:z.object({constants:z.object({atmosphere_Pa:pos}).passthrough()}).passthrough()}).passthrough()}).passthrough()}).passthrough()
export function parseC12Circulating(receipt:unknown){
  const r=c12Schema.parse(receipt)
  return {header_Pa:r.circulating.headerResidualHead_Pa,flow_kg_s:r.circulating.condenser_kg_s,inletEnthalpy_J_kg:r.circulating.inletTotalEnthalpy_J_kg,
    atmosphere_Pa:r.provenance.compiledPacket.s5.constants.atmosphere_Pa,c12PacketSha256:r.packetSha256}
}

type Cycle=Awaited<ReturnType<typeof runCycle>>
export type SteamTexts={turbine:string,admission:string,condenser:string,shaft:string,casing:string,hot:string,generator:string}

/** S4-D7: the machine's prepared phasor at the turbine's actual prepared net shaft power, with the
 * generator owner's unity-power-factor sizing formulas and the hardware sized once at `referenceShaft`
 * (generator-and-synchronization.md#prepared-shaft-balance-with-the-compact-turbine-s4-d7-15-october-2026). Closed form:
 * `3 Rs I² + √3 V I = P_shaft`; at `P_shaft = referenceShaft` it is the owner's sizing phasor exactly.
 * The runtime evaluates it at packet load from its own prepared turbine torque. */
export function preparedMachinePhasor(h:{lineVoltage_V:number,frequency_Hz:number,resistance:number,statorInductance:number,
  mutual:number,fieldInductance:number,fieldResistance:number},shaft_W:number){
  const V=h.lineVoltage_V,we=2*Math.PI*h.frequency_Hz,X=h.statorInductance*we,Rs=h.resistance,Vph=V/Math.sqrt(3)
  if(!(shaft_W>0&&Rs>0))throw Error('Prepared shaft power and stator resistance must be positive')
  const I=(-Math.sqrt(3)*V+Math.sqrt(3*V*V+12*Rs*shaft_W))/(6*Rs)
  const emf=Math.sqrt(3)*Math.hypot(Vph+Rs*I,X*I),field=emf/(we*h.mutual)
  const delta=Math.atan2(X*I,Vph+Rs*I),id=-Math.sqrt(3)*I*Math.sin(delta),iq=-Math.sqrt(3)*I*Math.cos(delta)
  return {phaseCurrent_A:I,fieldCurrent_A:field,fieldDemand_V:h.fieldResistance*field,angle_rad:delta-Math.PI/2,
    initialFlux:[h.statorInductance*id+h.mutual*field,h.statorInductance*iq,h.mutual*id+h.fieldInductance*field],
    export_W:Math.sqrt(3)*V*I}
}
const MPa=1e6,K=(c:number)=>c+273.15,close=(a:number,b:number,rel=1e-12)=>Math.abs(a-b)<=rel*Math.max(Math.abs(a),Math.abs(b))

/** The pure compilation over the owners' texts, the cycle calculator's result and C09's receiving shells. */
export function compileOperatingSteam(texts:SteamTexts,cycle:Cycle,receivers:z.infer<typeof receiversSchema>,cw:ReturnType<typeof parseC12Circulating>){
  const stocks=parseSteamStocks(texts.turbine),prep=parseSteamPreparation(texts.turbine),drains=parseMsrDrains(texts.turbine),
    governor=parseGovernor(texts.turbine),bypass=parseBypassControl(texts.admission),protection=parseCondenserProtection(texts.admission),
    travel=parseSteamValveTravel(texts.admission),cond=parseCondenser(texts.condenser),gases=parseNoncondensables(texts.condenser),
    drag=parseShaftDrag(texts.shaft),casing=parseTurbinePreparation(texts.casing),shells=parseReceivers(receivers),
    act=parseSteamActuators(texts.admission),
    // The SG preparation pressure has one numeric owner: the prepared-hot block (S2-D18); C10 holds no copy.
    sgPrepared_Pa=parseOperatingHotReference(texts.hot).sgSecondaryPressure_Pa,
    machine=parseGenerator(texts.generator),hardware=generatorParameters(machine)
  // Prepared positions: each isolation listed once; the emergency drain's CLOSED comes from its own block (the schema's literal).
  const isolations=['MS.ISO.A','MS.ISO.B','TG.STOP','TG.ADM','TG.RH.ISO','TG.BYP']
  const listed=[...prep.preparedOpen,...prep.preparedClosed]
  if(listed.length!==isolations.length||!isolations.every(v=>listed.includes(v)))throw Error('Every prepared steam valve must be listed exactly once as open or closed')
  if(prep.preparedDrainOpening!==drains.separatorDrain.bias||prep.preparedDrainOpening!==drains.reheaterDrain.bias)
    throw Error('Prepared drain opening differs from the drain laws\' nominal opening')
  if(prep.preparedOpen.includes('MS.ISO.A')!==prep.preparedOpen.includes('MS.ISO.B'))throw Error('Both MS isolations must share one prepared position')
  const position=(id:string)=>prep.preparedOpen.includes(id)?1:0
  const actuator=(id:typeof valveIds[number])=>({actuator:act.groups[id],onSupplyLoss:act.springReturn.includes(id)?'springClose':'hold'})
  const b=cycle.basis,f=cycle.flows,pt=cycle.points,total=f.SG_total_kg_s
  // The page's retained cycle pressures must be the cycle's own (no second numeric owner).
  for(const [name,mine,theirs] of [['HP extraction',prep.hpExtraction_Pa,b.highBleedPressure_MPaAbs*MPa],['separator',prep.separator_Pa,b.separatorPressure_MPaAbs*MPa],
    ['RH process',prep.reheaterProcess_Pa,b.separatorPressure_MPaAbs*MPa],['LP first',prep.lpFirst_Pa,b.lowBleedPressure_MPaAbs*MPa],
    ['LP second',prep.lpSecond_Pa,b.lowestBleedPressure_MPaAbs*MPa]] as const)
    if(!close(mine,theirs))throw Error(`Prepared ${name} pressure ${mine} differs from the cycle's ${theirs}`)
  if(!close(prep.reheaterProcess_C,b.reheatOutlet_C))throw Error('Prepared RH process temperature differs from the cycle reheat outlet')
  if(!close(cond.prepared_C,b.condensate_C)||!close(cond.condensing_C,b.condensate_C))throw Error('Condenser preparation differs from the cycle condensate temperature')
  if(!close(cond.liquid_m3+cond.vapor_m3,cond.shell_m3))throw Error('Condenser liquid and vapour occupancy must fill the shell')
  if(!close(cond.surface_m-cond.pumpEye_m,cond.liquid_m3/cond.hotwellArea_m2))throw Error('Hotwell surface, eye and area disagree with the prepared liquid')
  if(!close(cond.manifold_m-cond.pumpEye_m,cond.manifoldCovered_m3/cond.hotwellArea_m2))throw Error('Manifold elevation and coverage volume disagree')
  cond.wallPrepared_C.forEach((w,i)=>{if(!close(w,(cond.cellPrepared_C[i]!+cond.condensing_C)/2,1e-11))throw Error('Condenser wall is not halfway between its cell and the condensing temperature')})
  if(!(prep.separatorLiquid_m3<stocks.separatorPickup_m3[0]&&prep.separatorLiquid_m3>stocks.drainPickupFraction*stocks.separator_m3))
    throw Error('Prepared separator liquid must cover the bottom drain and stay below the pickup sill')
  if(!(prep.reheaterShellLiquid_m3>stocks.drainPickupFraction*stocks.reheaterShell_m3))throw Error('Prepared RH shell liquid must cover its drain')
  // D2 re-anchoring: the same losses at the SG preparation.
  const header=sgPrepared_Pa-prep.mainSteamLoss_Pa,junction=header-prep.stopAdmissionShare*prep.stopAdmissionLoss_Pa,
    admission=header-prep.stopAdmissionLoss_Pa,rhShell=prep.reheaterShellPressureFactor*header
  if(!(admission>prep.hpExtraction_Pa))throw Error('HP admission must lie above the HP extraction')
  if(!(shells.h4Shell_Pa<rhShell&&shells.h2Shell_Pa<prep.separator_Pa))throw Error('Drain receivers must lie below their donors')
  const throttled={kind:'throttledSaturatedVapor',fromSaturationPressure_Pa:sgPrepared_Pa} as const
  const ph=(p:number,point:keyof typeof pt)=>({kind:'pressureEnthalpy',pressure_Pa:p,enthalpy_J_kg:pt[point].h_kJ_kg*1e3} as const)
  const store=(id:string,volume_m3:number,prepared:unknown,casing?:{capacity_J_K:number,contact_W_K:number})=>({id,volume_m3,prepared,...(casing?{casing}:{})})
  const hp={capacity_J_K:casing.hpCapacity_J_K,contact_W_K:casing.hpContact_W_K},lp={capacity_J_K:casing.lpCapacity_J_K,contact_W_K:casing.lpContact_W_K}
  const stores=[
    store('MS.HEADER',stocks.header_m3,{...throttled,pressure_Pa:header}),
    store('TG.HP1',stocks.hpAdmission_m3,{...throttled,pressure_Pa:admission},hp),
    store('TG.HP2',stocks.hpExtraction_m3,ph(prep.hpExtraction_Pa,'HP_bleed'),hp),
    store('TG.SEP',stocks.separator_m3,{kind:'saturatedLiquidVolume',pressure_Pa:prep.separator_Pa,liquid_m3:prep.separatorLiquid_m3}),
    store('TG.RH.PROCESS',stocks.reheaterProcess_m3,{kind:'pressureTemperature',pressure_Pa:prep.reheaterProcess_Pa,temperature_K:K(prep.reheaterProcess_C)}),
    store('TG.RH.SHELL',stocks.reheaterShell_m3,{kind:'saturatedLiquidVolume',pressure_Pa:rhShell,liquid_m3:prep.reheaterShellLiquid_m3}),
    store('TG.LP1',stocks.lpFirst_m3,ph(prep.lpFirst_Pa,'LP_bleed'),lp),
    store('TG.LP2',stocks.lpSecond_m3,ph(prep.lpSecond_Pa,'LP_lowest_bleed'),lp),
    // 40 °C saturation through the cycle calculator's own IF97 saturation pressure (no second inverse);
    // the runtime checks the native saturation temperature against the selected 40 °C.
    store('LD01.COND',cond.shell_m3,{kind:'saturatedLiquidVolume',pressure_Pa:pt.condenser_liquid.p_MPaAbs*MPa,liquid_m3:cond.liquid_m3,checkTemperature_K:K(cond.prepared_C)}),
  ]
  // Sizing flows from the cycle (the same fractions the S3 stand-in reads).
  const admitted=(1-f.reheat_fraction)*total,hp2=(1-f.reheat_fraction-f.high_heater_fraction)*total,
    lp1=f.LP_inlet_fraction*total,lp2=(f.LP_inlet_fraction-f.low_heater_fraction)*total,lp3=f.LP_exhaust_fraction*total
  const lpLoss=lp2-f.lowest_heater_fraction*total-lp3
  if(Math.abs(lpLoss)>1e-9*total)throw Error('LP interval flows do not close against the cycle extractions')
  const eta=[b.HPTurbineEfficiency,b.HPTurbineEfficiency,b.LPTurbineEfficiency,b.LPTurbineEfficiency,b.LPTurbineEfficiency]
  const points=[['main_steam','HP_bleed'],['HP_bleed','HP_separator_inlet'],['LP_reheat_inlet','LP_bleed'],['LP_bleed','LP_lowest_bleed'],['LP_lowest_bleed','LP_exhaust']] as const
  const omega0=drag.referenceSpeed_rpm*2*Math.PI/60
  const drops=points.map(([i,o],k)=>1000*(pt[i].h_kJ_kg-pt[o].h_kJ_kg)/eta[k]!)
  const flows=[admitted,hp2,lp1,lp2,lp3]
  const work=flows.reduce((s,m,k)=>s+m*eta[k]!*drops[k]!,0),reference=cycle.powers_MW.turbine_thermodynamic_work*MPa
  if(!close(work,reference,1e-9))throw Error('Interval sizing flows do not reproduce the cycle work')
  const condenserNominal_Pa=pt.LP_exhaust.p_MPaAbs*MPa
  const interval=(id:string,from:string,to:string,k:number)=>({id,from,to,law:'interval',sizingFlow_kg_s:flows[k]!,
    radius_m:Math.sqrt(2*drops[k]!)/(2*omega0),efficiency:eta[k]!,referenceDrop_J_kg:drops[k]!})
  const nozzle=(id:string,from:string,to:string,sizingFlow_kg_s:number,sizingOpening:number,extra:object={})=>({id,from,to,law:'nozzle',sizingFlow_kg_s,sizingOpening,...extra})
  const branches=[
    nozzle('MS.ISO.A','SG.A','MS.HEADER',f.SG_each_kg_s,1,{sizingInlet:{kind:'saturatedVapor',pressure_Pa:sgPrepared_Pa},sizingOutlet_Pa:header,travel_s:travel.sgIsolation_s,...actuator('MS.ISO.A')}),
    nozzle('MS.ISO.B','SG.B','MS.HEADER',f.SG_each_kg_s,1,{sizingInlet:{kind:'saturatedVapor',pressure_Pa:sgPrepared_Pa},sizingOutlet_Pa:header,travel_s:travel.sgIsolation_s,...actuator('MS.ISO.B')}),
    nozzle('TG.STOP','MS.HEADER','TG.ADM.JUNCTION',admitted,1,{sizingOutlet_Pa:junction,travel_s:travel.turbineStop_s,...actuator('TG.STOP')}),
    nozzle('TG.ADM','TG.ADM.JUNCTION','TG.HP1',admitted,1,{sizingInlet:{...throttled,pressure_Pa:junction},sizingOutlet_Pa:admission,travel_s:travel.admission_s,...actuator('TG.ADM')}),
    nozzle('TG.RH.ISO','MS.HEADER','TG.RH.SHELL',f.reheat_fraction*total,1,{sizingOutlet_Pa:rhShell,travel_s:travel.reheaterIsolation_s,...actuator('TG.RH.ISO'),check:true}),
    nozzle('TG.BYP','MS.HEADER','LD01.COND',bypass.rating.fractionOfTotalSteam*total,1,{sizingInlet:{kind:'saturatedVapor',pressure_Pa:bypass.rating.inletPressure_Pa},
      sizingOutlet_Pa:condenserNominal_Pa,travel_s:travel.bypass_s,...actuator('TG.BYP'),prepared:position('TG.BYP')}),
    interval('TG.HP.I1','TG.HP1','TG.HP2',0),interval('TG.HP.I2','TG.HP2','TG.SEP',1),interval('TG.LP.I1','TG.RH.PROCESS','TG.LP1',2),
    interval('TG.LP.I2','TG.LP1','TG.LP2',3),interval('TG.LP.I3','TG.LP2','LD01.COND',4),
    {id:'TG.SEP.RH',from:'TG.SEP',to:'TG.RH.PROCESS',law:'fixedArea',cdA_m2:prep.separatorReheaterSizing.cdA_m2,
      sizing:{flow_kg_s:prep.separatorReheaterSizing.flow_kg_s,inlet_Pa:prep.separatorReheaterSizing.inlet_Pa,outlet_Pa:prep.separatorReheaterSizing.outlet_Pa}},
    nozzle('TG.SEP.DRAIN','TG.SEP','FW.H2.SHELL',f.separator_drain_fraction*total,drains.separatorDrain.sizingOpening,
      {sizingInlet:{kind:'saturatedLiquid',pressure_Pa:prep.separator_Pa},sizingOutlet_Pa:shells.h2Shell_Pa,travel_s:drains.separatorDrain.travel_s,...actuator('TG.SEP.DRAIN'),prepared:prep.preparedDrainOpening}),
    nozzle('TG.SEP.EMERGENCY','TG.SEP','LD01.COND',f.separator_drain_fraction*total,drains.separatorDrain.sizingOpening,
      {sizingInlet:{kind:'saturatedLiquid',pressure_Pa:prep.separator_Pa},sizingOutlet_Pa:shells.h2Shell_Pa,areaOf:'TG.SEP.DRAIN',travel_s:drains.separatorEmergencyDrain.travel_s,...actuator('TG.SEP.EMERGENCY'),prepared:0}),
    nozzle('TG.RH.DRAIN','TG.RH.SHELL','FW.H4.SHELL',f.reheat_fraction*total,drains.reheaterDrain.sizingOpening,
      {sizingInlet:{kind:'saturatedLiquid',pressure_Pa:rhShell},sizingOutlet_Pa:shells.h4Shell_Pa,travel_s:1/drains.reheaterDrain.travelRate_per_s,...actuator('TG.RH.DRAIN'),prepared:prep.preparedDrainOpening}),
  ]
  const g=(i:number)=>2*cond.cellDuty_W/(cond.condensing_C-cond.cellPrepared_C[i]!)
  const bandDemand=Math.min(1,Math.max(0,(header-bypass.bandStart_Pa)/(bypass.bandFull_Pa-bypass.bandStart_Pa)))
  return {
    scope:'C10 Gate-1 compact allocation (S5): nine fluid stores with water, air, nitrogen and energy, solids, CW cells and signed nozzle/interval branches; for the test-only prototype, not joined to the kernel',
    census:{differential:9*4+1+4+2+2,algebraic:9*2+1},
    stores,
    junctions:[{id:'TG.ADM.JUNCTION',prepared_Pa:junction}],
    branches,
    separator:{area_m2:stocks.separatorArea_m2,pickup_m3:stocks.separatorPickup_m3,drainPickupFraction:stocks.drainPickupFraction},
    reheater:{wall_J_K:stocks.reheaterWall_J_K,
      sizing:{processFlow_kg_s:lp1,processInlet:{kind:'saturatedVapor',pressure_Pa:prep.separator_Pa},processOutlet_J_kg:pt.LP_reheat_inlet.h_kJ_kg*1e3,processOutlet_K:K(b.reheatOutlet_C)},
      drainPickupFraction:stocks.drainPickupFraction},
    condenser:{hotwellArea_m2:cond.hotwellArea_m2,floor_m:cond.pumpEye_m,surface_m:cond.surface_m,pumpEye_m:cond.pumpEye_m,manifold_m:cond.manifold_m,
      walls:cond.wallPrepared_C.map((t,i)=>({capacity_J_K:cond.wallCapacity_J_K,prepared_K:K(t),shellConductance_W_K:g(i),waterConductance_W_K:g(i)})),
      // Native-water cells (the page's preparation selects native water); the sizing ρ/cp are a comparison only.
      // Cell pressures: the owner's equal split of the condenser path, cell i at p_atm + s·h_i/(h_1+h_2)
      // with the historical 225/75 kPa, s and p_atm from C12's prepared port (P9).
      cells:cond.cellPrepared_C.map((t,i)=>({volume_m3:cond.waterCell_m3,prepared_K:K(t),elevation_m:cond.cellElevation_m,
        pressure_Pa:cw.atmosphere_Pa+cw.header_Pa*cond.historicalCellOverAtmosphere_Pa[i]!/(cond.historicalCellOverAtmosphere_Pa[0]+cond.historicalCellOverAtmosphere_Pa[1])})),
      sizingComparison:{density_kg_m3:cond.sizingDensity_kg_m3,cp_J_kgK:cond.sizingCp_J_kgK},condensing_K:K(cond.condensing_C),
      ownerDesignPort:{cwFlow_kg_s:cond.preparedPort.cwFlow_kg_s,cwInlet_K:K(cond.preparedPort.cwInlet_C)},
      c12Port:{cwFlow_kg_s:cw.flow_kg_s,inletTotalEnthalpy_J_kg:cw.inletEnthalpy_J_kg,header_Pa:cw.header_Pa,atmosphere_Pa:cw.atmosphere_Pa,c12PacketSha256:cw.c12PacketSha256}},
    casing:{roomContact_W_K:casing.roomContact_W_K},
    noncondensables:gases,
    shaft:{referenceSpeed_rad_s:omega0,loadLossFraction:(1-b.shaftMechanicalEfficiency)-drag.dragPowerAtReference_W/reference,drag_Nm_per_rad_s:drag.dragPowerAtReference_W/omega0**2},
    /** S4-D7: the runtime prepares the phasor from its own prepared net turbine shaft power with these
     * fixed hardware values (preparedMachinePhasor); the owner's sizing point is the check at referenceShaft. */
    generatorPreparation:{rule:'S4-D7 unity power factor at the prepared net turbine shaft power',
      lineVoltage_V:machine.lineVoltage_V,frequency_Hz:machine.frequency_Hz,polePairs:machine.polePairs,
      resistance_ohm:hardware.resistance,statorInductance_H:hardware.statorInductance,mutual_H:hardware.mutual,
      fieldInductance_H:hardware.fieldInductance,fieldResistance_ohm:hardware.fieldResistance,referenceShaft_W:machine.referenceShaft_W},
    controllers:{governor,bypass,protection,drains},
    actuatorDuties:{isolationMotion_W:act.isolationMotion_W,openingMotion_W:act.openingMotion_W,springStockShare:act.springStockShare,
      holding_W:act.holding_W,controllerElectronics_W:act.controllerElectronics_W,drainMotion_W:act.drainMotion_W,drainElectronics_W:act.drainElectronics_W},
    prepared:{sg_Pa:sgPrepared_Pa,header_Pa:header,junction_Pa:junction,admission_Pa:admission,reheaterShell_Pa:rhShell,condenserNominal_Pa,
      requests:{msIsolation:position('MS.ISO.A'),stop:position('TG.STOP'),admission:position('TG.ADM'),reheaterIsolation:position('TG.RH.ISO'),
        bypass:position('TG.BYP'),separatorDrain:prep.preparedDrainOpening,separatorEmergency:0,reheaterDrain:prep.preparedDrainOpening}},
    /** D2: the unchanged band evaluated at the re-anchored header. A demand above zero at full power is owner item S4-3. */
    disclosed:{bypassBandDemandAtPreparation:bandDemand,bypassBandConflict:bandDemand>0},
    receivers:shells,
    /** Neighbours' flows at preparation, held as port inputs by the standalone prototype only: the cycle's
     * sizing values (C09 computes them in a joined unit). FIXTURE for the prototype, not a C10 law. */
    heldPortsAtPreparation:{extraction_kg_s:{H4:f.high_heater_fraction*total,H3:f.separator_heater_fraction*total,
      H2:f.low_heater_fraction*total,H1:f.lowest_heater_fraction*total},h1Drain_kg_s:f.condenser_drains_fraction*total,condensate_kg_s:total},
  }
}

const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
export async function prepareOperatingSteam(wikiRoot:string,python:string,receivers:unknown,c12Receipt:unknown){
  const root='world/packs/process-plant/reference-designs/ld-01/'
  const docs=await Promise.all(steamPages.map(p=>Bun.file(join(wikiRoot,root,p)).text()))
  const [turbine,admission,condenser,shaft,cycleText,casing,hot,generator]=docs as [string,string,string,string,string,string,string,string]
  const cycle=await runCycle(cycleText,python)
  const packet=compileOperatingSteam({turbine,admission,condenser,shaft,casing,hot,generator},cycle,parseReceivers(receivers),parseC12Circulating(c12Receipt))
  const after=await Promise.all(steamPages.map(p=>Bun.file(join(wikiRoot,root,p)).text()))
  if(after.some((d,i)=>d!==docs[i]))throw Error('An owner page changed during compilation')
  return {...packet,provenance:{packetSha256:hash(JSON.stringify(packet)),sourceSha256:hash(await Bun.file(import.meta.path).text()),
    cycleInputSha256:cycle.inputSha256,cycleCalculationSha256:cycle.calculationSha256,
    consumed:steamPages.map((p,i)=>({name:root+p,sha256:hash(docs[i]!)}))}}
}

if(import.meta.main){
  const [wikiRoot,python,target,receiversFile,c12File,...extra]=Bun.argv.slice(2)
  if(!wikiRoot||!python||!target||!receiversFile||!c12File||extra.length)
    throw Error('Usage: bun reference-design-operating-steam.ts <wiki root> <research-python> <packet.json> <c09-receivers.json> <c12-support-receipt.json>')
  const c12Text=await Bun.file(c12File).text()
  const prepared=await prepareOperatingSteam(wikiRoot,python,JSON.parse(await Bun.file(receiversFile).text()),JSON.parse(c12Text))
  const packet={...prepared,provenance:{...prepared.provenance,c12ReceiptSha256:hash(c12Text)}}
  await Bun.write(target,JSON.stringify(packet,null,2)+'\n')
  console.log(JSON.stringify({target,packetSha256:packet.provenance.packetSha256,census:packet.census,disclosed:packet.disclosed}))
}
