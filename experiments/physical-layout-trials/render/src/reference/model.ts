// Drawing view model. All dimensions/elevations are authored study assumptions,
// not recovered plant geometry or a replacement for the IFC source standard.
export type Level = 'operating' | 'lower';
export type Point = readonly [number, number];
export type Box = {x:number; y:number; w:number; h:number};
export type Equipment = Box & {
 id:string; name:string; tag:string; level:Level; kind:'hp'|'lp'|'generator'|'exciter'|'msr'|'stop-valve'|'condenser'|'feed-pump'|'condensate-pump';
 componentId?:string; binding:'component'|'part-of'|'illustrative'; zBase:number; zTop:number; note:string;
};
export type Opening={id:string;start:number;end:number;kind:'personnel'|'double'|'shutter'|'glazing';levels:Level[]};
export type Wall=Box & {id:string;axis:'h'|'v';levels:Level[];openings:Opening[]};
export type Door={id:string;level:'both'|Level;hinge:Point;closed:Point;open:Point};
export const plant={id:'plant:halden-1',name:'Halden 1',modelRef:'process-plant.pwr.reference',modelDigest:'16523e5a06e67b517862fd96650bfef2cdd5e4ad05a1dd70c8f27eb2dff9bdff',units:'mm',geometryStatus:'illustrative',nominalTurbineMW:1100} as const;
export const levels:Record<Level,{label:string;elevation:number;sheet:string;note:string}>={
 operating:{label:'Turbine operating deck',elevation:15000,sheet:'P—101',note:'HP / LP train, generator and maintenance deck'},
 lower:{label:'Condenser & pump deck',elevation:0,sheet:'P—100',note:'Condenser below the LP bank; adjacent feedwater-pump room'},
};
export const hall:Box={x:400,y:400,w:88000,h:36000};
export const pumpRoom:Box={x:8800,y:37200,w:32000,h:16000};
export const stairs:Box={x:3600,y:27400,w:5200,h:7400};
export const laydown:Box={x:20000,y:3600,w:32000,h:6400};
export const withdrawal:Box={x:68000,y:14200,w:18500,h:8400};
export const table:Box={x:8000,y:11800,w:69000,h:13400};
export const tablePiers:Box[]=[18400,29400,40400,51400].flatMap(x=>[8000,26700].map(y=>({x,y,w:1200,h:1800})));
export const hallColumns:Box[]=Array.from({length:9},(_,i)=>400+i*11000).flatMap(x=>[400,36400].map(y=>({x:x-400,y:y-400,w:800,h:800})));
export const hatch:Box={x:75800,y:26000,w:8000,h:4800};
export const crane={z:28000,runways:[2500,34200],bridge:{x:80000,y:2500,w:1400,h:31700}};
export const routes:Record<Level,Box[]>={
 operating:[{x:9000,y:31300,w:75800,h:2000},{x:81700,y:23700,w:3100,h:9600}],
 lower:[{x:9000,y:31300,w:75800,h:2000},{x:1000,y:24200,w:8000,h:2000},{x:12475,y:33100,w:2250,h:5900},{x:12475,y:39000,w:2250,h:13200},{x:14725,y:44500,w:21475,h:2000},{x:35675,y:46500,w:2250,h:6700}],
};
const both:Level[]=['operating','lower'];
export const walls:Wall[]=[
 {id:'hall-north',x:0,y:0,w:88800,h:400,axis:'h',levels:both,openings:[{id:'D-N1',start:74000,end:75200,kind:'personnel',levels:['lower']},...[13400,35400,57400].map((start,i)=>({id:`W-${i+1}`,start,end:start+7000,kind:'glazing' as const,levels:['operating'] as Level[]}))]},
 {id:'hall-west',x:0,y:400,w:400,h:36000,axis:'v',levels:both,openings:[{id:'D-W1',start:24000,end:26400,kind:'double',levels:['lower']}]},
 {id:'hall-east',x:88400,y:400,w:400,h:36000,axis:'v',levels:both,openings:[{id:'D-E1',start:26000,end:32000,kind:'shutter',levels:['lower']}]},
 {id:'hall-south',x:0,y:36400,w:88800,h:400,axis:'h',levels:both,openings:[{id:'D-P1',start:12400,end:14800,kind:'double',levels:['lower']}]},
 {id:'annex-north',x:8400,y:36800,w:32800,h:400,axis:'h',levels:['lower'],openings:[{id:'D-P1b',start:12400,end:14800,kind:'double',levels:['lower']}]},
 {id:'annex-west',x:8400,y:37200,w:400,h:16000,axis:'v',levels:['lower'],openings:[{id:'D-P2',start:41800,end:47800,kind:'shutter',levels:['lower']}]},
 {id:'annex-east',x:40800,y:37200,w:400,h:16000,axis:'v',levels:['lower'],openings:[]},
 {id:'annex-south',x:8400,y:53200,w:32800,h:400,axis:'h',levels:['lower'],openings:[{id:'D-P3',start:35600,end:38000,kind:'double',levels:['lower']}]},
];
export function wallSpans(w:Wall,level:Level):Box[]{
 if(!w.levels.includes(level))return [];
 const start=w.axis==='h'?w.x:w.y,end=start+(w.axis==='h'?w.w:w.h);let p=start;const spans:Box[]=[];
 for(const o of w.openings.filter(o=>o.levels.includes(level)).sort((a,b)=>a.start-b.start)){
  if(o.start>p)spans.push(w.axis==='h'?{x:p,y:w.y,w:o.start-p,h:w.h}:{x:w.x,y:p,w:w.w,h:o.start-p});p=o.end;
 }
 if(p<end)spans.push(w.axis==='h'?{x:p,y:w.y,w:end-p,h:w.h}:{x:w.x,y:p,w:w.w,h:end-p});return spans;
}
export const doors:Door[]=[
 {id:'D-W1a',level:'lower',hinge:[400,24000],closed:[400,25200],open:[1600,24000]},
 {id:'D-W1b',level:'lower',hinge:[400,26400],closed:[400,25200],open:[1600,26400]},
 {id:'D-N1',level:'lower',hinge:[74000,400],closed:[75200,400],open:[74000,1600]},
 {id:'D-P1a',level:'lower',hinge:[12400,37200],closed:[13600,37200],open:[12400,38400]},
 {id:'D-P1b',level:'lower',hinge:[14800,37200],closed:[13600,37200],open:[14800,38400]},
 {id:'D-P3a',level:'lower',hinge:[35600,53200],closed:[36800,53200],open:[35600,52000]},
 {id:'D-P3b',level:'lower',hinge:[38000,53200],closed:[36800,53200],open:[38000,52000]},
];
export const equipment:Equipment[]=[
 {id:'tg-hp',tag:'HP',name:'High-pressure turbine',level:'operating',kind:'hp',x:10000,y:16000,w:7000,h:4800,componentId:'turbine',binding:'part-of',zBase:15000,zTop:20100,note:'Illustrative double-flow HP casing. One common shaft with the LP bank and generator. This is a visual part of the lumped turbine-generator, not a separate simulation component.'},
 ...[20000,31000,42000].map((x,i)=>({id:`tg-lp-${i+1}`,tag:`LP ${i+1}`,name:`Low-pressure turbine ${i+1}`,level:'operating' as const,kind:'lp' as const,x,y:12800,w:9000,h:11200,componentId:'turbine',binding:'part-of' as const,zBase:15000,zTop:21700,note:'Illustrative double-flow casing and bolted split line, with exhaust neck descending to the condenser below. LP machines share a shaft; their steam admissions are parallel after reheating.'})),
 {id:'tg-generator',tag:'GEN',name:'Electrical generator',level:'operating',kind:'generator',x:55000,y:15400,w:12500,h:6000,componentId:'turbine',binding:'part-of',zBase:15000,zTop:21500,note:'Stator housing, terminal enclosure, bearing pedestals and cooling ribs drawn as parts of the current turbine-generator. Its existing electrical port is turbine.generatorOutput.'},
 {id:'tg-exciter',tag:'EXC',name:'Exciter & coupling',level:'operating',kind:'exciter',x:70000,y:16800,w:4000,h:3200,componentId:'turbine',binding:'part-of',zBase:15000,zTop:18800,note:'Illustrative visual part of the train. The outage overlay reserves this area for generator rotor withdrawal after the exciter is removed.'},
 ...[5400,27800].map((y,i)=>({id:`msr-${i+1}`,tag:`MSR ${i+1}`,name:`Moisture separator / reheater ${i+1}`,level:'operating' as const,kind:'msr' as const,x:10200,y,w:7400,h:3000,binding:'illustrative' as const,zBase:15000,zTop:19500,note:'Illustrative balance-of-plant detail. Not an independent asset in the current simulation. The two MSRs serve parallel LP admission branches; the depicted routing is a study assumption.'})),
 {id:'stop-valve',tag:'TSV',name:'Turbine stop valve',level:'operating',kind:'stop-valve',x:4800,y:15400,w:1800,h:2100,componentId:'turbineStopValve',binding:'component',zBase:15000,zTop:18100,note:'Bound to turbineStopValve. The main-steam continuation enters from off sheet; exact pipe diameters, support and valve geometry are illustrative.'},
 ...[20000,31000,42000].map((x,i)=>({id:`condenser-${i+1}`,tag:`COND ${i+1}`,name:`Condenser section ${i+1}`,level:'lower' as const,kind:'condenser' as const,x,y:10500,w:9000,h:15800,componentId:'condenser',binding:'part-of' as const,zBase:0,zTop:14600,note:'Illustrative section of the single model condenser below an LP exhaust. Shell, tube bundles, water boxes and hotwell are depicted; three visual sections do not create three model assets.'})),
 {id:'cp-a',tag:'CP A',name:'Condensate pump A',level:'lower',kind:'condensate-pump',x:55500,y:19200,w:5200,h:2600,componentId:'condensatePumpA',binding:'component',zBase:0,zTop:3200,note:'Condenser condensate outlet → pump A → off-sheet feedwaterTank. The motor is part of this visual assembly. Assumed horizontal drawing symbol, not a recovered OEM pump configuration.'},
 {id:'cp-b',tag:'CP B',name:'Condensate pump B',level:'lower',kind:'condensate-pump',x:63500,y:24200,w:5200,h:2600,componentId:'condensatePumpB',binding:'component',zBase:0,zTop:3200,note:'Parallel condensate path B from the condenser to feedwaterTank. Location and pump/motor shape are illustrative.'},
 {id:'mfw-a',tag:'MFW A',name:'Main feedwater pump A',level:'lower',kind:'feed-pump',x:17000,y:40400,w:12000,h:2700,componentId:'mainFeedwaterPumpA',binding:'component',zBase:0,zTop:3400,note:'Multistage pump, coupling guard and finned motor on a common plinth. Suction comes from off-sheet feedwaterTank; discharge goes to feedwaterHeader. These are the current graph endpoints, not a shortcut from the condensate pumps.'},
 {id:'mfw-b',tag:'MFW B',name:'Main feedwater pump B',level:'lower',kind:'feed-pump',x:17000,y:48100,w:12000,h:2700,componentId:'mainFeedwaterPumpB',binding:'component',zBase:0,zTop:3400,note:'Second current-model feedwater pump. Side working aisles and a north-side equipment removal area are drawn as authored spatial allowances; no OEM maintenance clearance is claimed.'},
];
export const componentIds=['turbine','turbineStopValve','condenser','condensatePumpA','condensatePumpB','mainFeedwaterPumpA','mainFeedwaterPumpB'] as const;
export const pipeConnections=[
 ['main-steam-header-to-turbine-stop-valve','mainSteamHeader.outletA','turbineStopValve.inlet'],
 ['turbine-stop-valve-to-turbine','turbineStopValve.outlet','turbine.steamInlet'],
 ['condenser-to-condensate-pump-a','condenser.condensateOutlet','condensatePumpA.inlet'],
 ['condenser-to-condensate-pump-b','condenser.condensateOutlet','condensatePumpB.inlet'],
 ['condensate-pump-a-to-feedwater-tank','condensatePumpA.outlet','feedwaterTank.inlet'],
 ['condensate-pump-b-to-feedwater-tank','condensatePumpB.outlet','feedwaterTank.inlet'],
 ['feedwater-tank-to-main-feedwater-pump-a','feedwaterTank.outlet','mainFeedwaterPumpA.inlet'],
 ['feedwater-tank-to-main-feedwater-pump-b','feedwaterTank.outlet','mainFeedwaterPumpB.inlet'],
 ['main-feedwater-pump-a-to-header','mainFeedwaterPumpA.outlet','feedwaterHeader.inletA'],
 ['main-feedwater-pump-b-to-header','mainFeedwaterPumpB.outlet','feedwaterHeader.inletB'],
] as const;
export const contains=(a:Box,b:Box)=>b.x>=a.x&&b.y>=a.y&&b.x+b.w<=a.x+a.w&&b.y+b.h<=a.y+a.h;
export const overlap=(a:Box,b:Box)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
export const visibleEquipment=(level:Level)=>equipment.filter(e=>e.level===level);
export const area=(b:Box)=>b.w*b.h/1e6;
// Conservative rectangle enclosing the SVG assembly, including projecting accessories.
export function assemblyBounds(e:Equipment):Box{
 const b={x:e.x,y:e.y,w:e.w,h:e.h};
 switch(e.kind){
  case 'hp':return {...b,x:b.x-300,w:b.w+600};
  case 'lp':return {...b,x:b.x-350,w:b.w+700};
  case 'generator':return {...b,x:b.x-250,y:b.y-400,w:b.w+500,h:b.h+2000};
  case 'exciter':return {...b,x:b.x-200,w:b.w+400};
  case 'msr':return {...b,y:b.y-500,h:b.h+1000};
  case 'stop-valve':return {...b,y:b.y-170,h:b.h+170};
  case 'condenser':return {...b,w:b.w+700};
  case 'feed-pump':case 'condensate-pump':return {...b,x:b.x-180,y:b.y-150,w:b.w+360,h:b.h+300};
 }
}
export function pumpNozzles(e:Equipment):{inlet:Point;outlet:Point}{
 if(e.kind==='feed-pump')return {inlet:[e.x+1200,e.y+100],outlet:[e.x+4075,e.y+e.h]};
 if(e.kind==='condensate-pump')return {inlet:[e.x,e.y+e.h/2],outlet:[e.x+825,e.y]};
 throw Error(`Not a pump: ${e.id}`);
}
