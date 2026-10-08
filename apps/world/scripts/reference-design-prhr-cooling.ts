/** Compile the cold PRHR join from current physical owners and an explicitly
 * authored laboratory preparation. No property calculation or physical law
 * runs here; all state/heat/flow belongs to the native network. */
import {z} from 'zod'
import {configurationBlock} from './reference-design-source-laws'
import type {compileOperatingNetwork} from './reference-design-operating-network'
const positive=z.number().finite().positive()
const preparation=z.object({bankTemperature_K:positive,wstTemperature_K:positive,gasTemperature_K:positive,gasPressure_Pa:positive,
 gasRelativeHumidity:z.number().finite().min(0).max(1),ambientTemperature_K:positive,roomTemperature_K:positive,
 initialOpening:z.number().finite().min(0).max(1),
 blocked:z.boolean()}).strict()
export function parsePrhrColdPreparation(text:string){return preparation.parse(configurationBlock(text,'reference-prhr-cold-preparation'))}
type Network=Awaited<ReturnType<typeof compileOperatingNetwork>>
const capture=(text:string,pattern:RegExp,label:string)=>{
 const m=text.match(pattern);if(!m)throw Error('Missing current PRHR '+label)
 const n=Number(m[1]);if(!Number.isFinite(n)||n<=0)throw Error('Invalid current PRHR '+label);return n
}
export function compilePrhrCooling(network:Network,prhrDocument:string,wstDocument:string,roomDocument:string,selectionDocument:string){
 const g=network.prhr;if(!g)throw Error('PRHR contacts require its actual physical network')
 const prep=parsePrhrColdPreparation(selectionDocument),act=prhrDocument.split('## Actuation and restoration')[1]
 if(!act)throw Error('Missing current PRHR actuation owner')
 const stroke=capture(act,/over (\d+(?:\.\d+)?) s/,'stroke'),
  spring=capture(act,/Es=(\d+(?:\.\d+)?)\*\(1−a\)/,'spring stock'),
  close=capture(act,/(\d+(?:\.\d+)?) kW, 5 s closing action/,'closing duty')*1000,
  hold=capture(act,/A (\d+(?:\.\d+)?) W energized holding duty/,'hold duty'),
  roomCapacity=capture(roomDocument,/each with(\d+(?:\.\d+)?)MJ\/K effective air-and-structure/,'ROOM capacity')*1e6,
  roomWall=capture(roomDocument,/Wall conductance(\d+(?:\.\d+)?)MW\/K to ambient/,'ROOM wall')*1e6,
  surface=capture(wstDocument,/k_surface = (\d+(?:\.\d+)?) m\/s/,'WST surface transfer'),
  rim=capture(wstDocument,/physical spill rim \+(\d+(?:\.\d+)?) m/,'WST rim')
 const water=(id:string)=>{const i=network.water.findIndex(w=>w.id===id);if(i<0)throw Error('Missing PRHR water '+id);return i},
  solid=(id:string)=>{const i=network.solids.findIndex(w=>w.id===id);if(i<0)throw Error('Missing PRHR solid '+id);return i},
  edge=(from:string,to:string)=>{const i=network.hydraulic.findIndex(e=>e.id===from+'->'+to);if(i<0)throw Error('Missing PRHR flow '+from+'->'+to);return i}
 const liquid:{water:number;solid:number;area:number;diameter:number;flow_area:number;flow_edge:number;half_resistance:number;weight:0|1|2}[]=[],
  pool:{solid:number;area:number;diameter:number;elevation:number;half_resistance:number;bank_factor:number}[]=[],
  gas:{solid:number;conductance:number}[]=[],
  seat=edge('PRHR.SEAT.UP','PRHR.SEAT.DOWN'),
  filmFlow=(id:string)=>{
   // The far lower header receives both tube groups. Its outlet carries the
   // combined current; choosing the first incoming link would pick only one
   // group according to array order. This is the stated mixed-header speed
   // reduction, not a resolved axial velocity profile.
   if(id==='PRHR.LOWER.2')return edge(id,'PRHR.RETURN.BANK')
   const edges=g.links.filter(e=>e.to===id)
   if(edges.length!==1)throw Error('Ambiguous PRHR representative film flow '+id)
   return edge(edges[0]!.from,edges[0]!.to)
  }
 const insulationText=prhrDocument.split('The exposed hot and cold connectors select ')[1]
 if(!insulationText)throw Error('Missing authored connector insulation')
 const thickness=capture(insulationText,/^(\d+(?:\.\d+)?) mm insulation/,'connector insulation thickness')/1000,
  kIns=capture(insulationText,/conductivity `([\d.]+) W\/\(m K\)`/,'connector insulation conductivity'),
  hGas=capture(insulationText,/exterior coefficient `(\d+(?:\.\d+)?) W\/\(m² K\)`/,'connector exterior coefficient')
 for(const p of g.parts){
  const shell=p.id.startsWith('PRHR.SEAT.'),s=g.steel.find(s=>s.id===p.id+(shell?'.SHELL':'.STEEL.1'))!,
   outer=shell?s:g.steel.find(s=>s.id===p.id+'.STEEL.2')!,
   area=Math.PI*p.diameter_m*p.length_m*p.parallel,
   flow_area=p.parallel*Math.PI*p.diameter_m**2/4
  liquid.push({water:water(p.id),solid:solid(s.id),area,diameter:p.diameter_m,flow_area,
   flow_edge:shell?seat:filmFlow(p.id),half_resistance:s.innerResistance_K_W,weight:0})
  if(p.immersed)pool.push({solid:solid(outer.id),area:Math.PI*p.outsideDiameter_m*p.length_m*p.parallel,
   diameter:p.outsideDiameter_m,elevation:p.elevation_m,half_resistance:outer.outerResistance_K_W,bank_factor:g.contact.bankFactor})
  else{
   const r=p.outsideDiameter_m/2,insulated=r+thickness,
    resistance=outer.outerResistance_K_W+Math.log(insulated/r)/(2*Math.PI*kIns*p.length_m)
      +1/(hGas*2*Math.PI*insulated*p.length_m)
   gas.push({solid:solid(outer.id),conductance:1/resistance})
  }
 }
 const discArea=Math.PI*g.isolation.discDiameter_m**2/4,
  discResistance=g.isolation.discThickness_m/(4*g.geometry.steelConductivity_W_mK*discArea),
  seatArea=Math.PI*g.geometry.hotConnector.id_m**2/4
 for(const face of [0,1])for(const side of [0,1])liquid.push({water:water(side===0?'PRHR.SEAT.UP':'PRHR.SEAT.DOWN'),
  solid:solid('PRHR.DISC.'+(face+1)),area:discArea,diameter:g.isolation.discDiameter_m,flow_area:seatArea,
  flow_edge:seat,half_resistance:discResistance,weight:face===side?1:2})
 const sgWater=water('SG.A.PRIMARY.4'),sgFlow=edge('SG.A.PRIMARY.3','SG.A.PRIMARY.4'),
  sgArea=network.hydraulic[sgFlow]!.segments[0]!.area_m2,D=g.geometry.coldConnector.id_m,
  L=g.geometry.coldConnector.length_m,entry=g.mixing.penetrationBores*D,
  coordinates=[0,entry/2,(entry+L)/2,L],
  ids=['SG.A.PRIMARY.4','PRHR.RETURN.ENTRANCE','PRHR.RETURN.BANK','PRHR.LOWER.2'],
  mixing=ids.slice(1).map((id,i)=>{
   const lo=coordinates[i]!,hi=coordinates[i+1]!,separation=hi-lo,
    penetration_average=entry/separation*(Math.exp(-lo/entry)-Math.exp(-hi/entry))
   return {from:water(ids[i]!),to:water(id),area:Math.PI*D**2/4,separation,diameter:D,
    slope:(g.geometry.tubes.bottom_m-g.geometry.coldTerminal_m)/L,penetration_average,
    sg_flow_edge:sgFlow,sg_water:sgWater,sg_flow_area:sgArea,coefficient:g.mixing.coefficient,
    prandtl:g.mixing.turbulentPrandtl,schmidt:g.mixing.turbulentSchmidt}
  }),mixPairs=new Set(mixing.map(m=>[m.from,m.to].sort((a,b)=>a-b).join('/'))),
  boundary=(id:string)=>id==='HOT.A.after'?'HOT.A.AFTER':id==='SG.A.PRIMARY.outlet'?'SG.A.PRIMARY.4':id,
  axial=g.links.filter(e=>!mixPairs.has([water(boundary(e.from)),water(boundary(e.to))].sort((a,b)=>a-b).join('/'))).map(e=>{
   const area=Math.min(...e.segments.map(s=>s.area_m2))
   return {from:water(boundary(e.from)),to:water(boundary(e.to)),area,
    separation:area*e.segments.reduce((sum,s)=>sum+s.length_m/s.area_m2,0),seat:e.seat}
  })
 return {prep,seat:{edge:seat,area:seatArea,full_open_loss:g.valveK},
  wst:{area_m2:g.pool.area_m2,floor_m:g.pool.floor_m,hardware_volume_m3:g.pool.displacement_m3,
   hardware_first_moment_m4:g.pool.hardwareFirstMoment_m4,minimum_fully_wet_height_m:g.pool.firstExposure_m,
   maximum_height_m:rim,surface_mass_transfer_m_s:surface,initial_water_volume_m3:g.pool.initialWater_m3,
   initial_temperature_k:prep.wstTemperature_K},
  gasBoundary:{pressure_pa:prep.gasPressure_Pa,temperature_k:prep.gasTemperature_K,humidity:prep.gasRelativeHumidity},
  actuator:{stroke_s:stroke,spring_energy_j:spring,closing_power_w:close,hold_power_w:hold,
   room_capacity_j_k:roomCapacity,room_wall_w_k:roomWall,room_reference_temperature_k:prep.ambientTemperature_K,
   initial_opening:prep.initialOpening,initial_room_temperature_k:prep.roomTemperature_K},
  liquid,pool,gas,axial,mixing,
  scope:'Cold all-liquid finite PRHR/WST with explicit supplied gas/electrical boundaries; no full containment, hot duty or circulation-inertia credit'}
}
export function nativePrhrCoolingFrame(p:ReturnType<typeof compilePrhrCooling>|undefined){
 if(!p)return [0]
 const {wst:w,actuator:a,gasBoundary:g,prep:s}=p,
  fields=[1,p.seat.edge,p.seat.area,p.seat.full_open_loss,
   w.area_m2,w.floor_m,w.hardware_volume_m3,w.hardware_first_moment_m4,w.minimum_fully_wet_height_m,
   w.maximum_height_m,w.surface_mass_transfer_m_s,w.initial_water_volume_m3,w.initial_temperature_k,
   g.pressure_pa,g.temperature_k,g.humidity,
   a.stroke_s,a.spring_energy_j,a.closing_power_w,a.hold_power_w,a.room_capacity_j_k,a.room_wall_w_k,
   a.room_reference_temperature_k,a.initial_opening,a.initial_room_temperature_k,
   +s.blocked,s.ambientTemperature_K,
   p.liquid.length,...p.liquid.flatMap(c=>[c.water,c.solid,c.area,c.diameter,c.flow_area,c.flow_edge,c.half_resistance,c.weight]),
   p.pool.length,...p.pool.flatMap(c=>[c.solid,c.area,c.diameter,c.elevation,c.half_resistance,c.bank_factor]),
   p.gas.length,...p.gas.flatMap(c=>[c.solid,c.conductance]),
   p.axial.length,...p.axial.flatMap(c=>[c.from,c.to,c.area,c.separation,+c.seat]),
   p.mixing.length,...p.mixing.flatMap(c=>[c.from,c.to,c.area,c.separation,c.diameter,c.slope,c.penetration_average,
    c.sg_flow_edge,c.sg_water,c.sg_flow_area,c.coefficient,c.prandtl,c.schmidt])]
 if(!fields.every(Number.isFinite))throw Error('Nonfinite native PRHR frame')
 return fields
}
