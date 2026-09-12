/** Offline PRHR geometry/loss-budget selection. Not a plant or heat-transfer solver. */
import {createHash} from 'node:crypto'
import {z} from 'zod'
const positive=z.number().finite().positive()
const nonnegative=z.number().finite().nonnegative()
const pipe=z.object({id_m:positive,od_m:positive,length_m:positive}).strict().refine(p=>p.od_m>p.id_m,'Wall thickness must be positive')
const schema=z.object({
  tubes:z.object({count:z.number().int().positive(),id_m:positive,od_m:positive,straightLeg_m:positive,bendRadius_m:positive,pitch_m:positive,top_m:z.number().finite(),bottom_m:z.number().finite(),bendLoss_K:nonnegative,entryExitLoss_K:nonnegative}).strict(),
  header:pipe,hotConnector:pipe,coldConnector:pipe,connectorLoss_K:nonnegative,
  roughness_m:nonnegative,steelDensity_kg_m3:positive,steelCp_J_kgK:positive,steelConductivity_W_mK:positive,
  pool:z.object({width_m:positive,length_m:positive,floor_m:z.number().finite(),initialWater_m3:positive,initialGas_m3:positive}).strict(),
  hotTerminal_m:z.number().finite(),coldTerminal_m:z.number().finite(),
  calibration:z.object({flow_kg_s:positive,density_kg_m3:positive,viscosity_Pas:positive,meterDrop_Pa:positive,totalDrop_Pa:positive}).strict(),
}).strict().superRefine((b,c)=>{
  const t=b.tubes
  if(t.od_m<=t.id_m||t.pitch_m<=t.od_m||t.top_m-t.bottom_m<2*t.bendRadius_m||t.bendRadius_m<=t.od_m/2)c.addIssue({code:'custom',message:'Nonoverlapping tubes and realizable bends required'})
  if((t.count-1)*t.pitch_m+t.od_m>b.header.length_m||b.header.length_m>b.pool.width_m)c.addIssue({code:'custom',message:'Tube bank must fit header and tank width'})
  if(b.header.od_m+t.straightLeg_m+t.bendRadius_m+t.od_m/2>b.pool.length_m)c.addIssue({code:'custom',message:'Bank must fit tank length with header clearance'})
  if(b.hotConnector.length_m<t.top_m-b.hotTerminal_m||b.coldConnector.length_m<t.bottom_m-b.coldTerminal_m)c.addIssue({code:'custom',message:'Connectors cannot be shorter than elevation change'})
  if(t.bottom_m-b.header.od_m/2<=b.pool.floor_m||b.calibration.totalDrop_Pa<=b.calibration.meterDrop_Pa)c.addIssue({code:'custom',message:'Invalid pool or reference pressure budget'})
})
export type PrhrGeometryBasis=z.infer<typeof schema>
export function parsePrhrGeometry(text:string):PrhrGeometryBasis {
  const blocks=[...text.matchAll(/^```reference-prhr-geometry\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Exactly one PRHR geometry basis required')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
// Churchill 1977 Eq18 uses f=tau/(rho*v²); Darcy f_D=8f (Eq5).
export function darcyFriction(re:number,relativeRoughness:number):number {
  if(!Number.isFinite(re)||re<=0||!Number.isFinite(relativeRoughness)||relativeRoughness<0||relativeRoughness>=1)throw Error('Positive finite Re and physical relative roughness required')
  // Below Re=1 the full expression is indistinguishable from its laminar limit;
  // evaluating (37530/Re)^16 needlessly risks overflow.
  if(re<1)return 64/re
  const A=(2.457*Math.log(1/((7/re)**.9+.27*relativeRoughness)))**16
  const B=(37530/re)**16
  return 8*((8/re)**12+1/(A+B)**1.5)**(1/12)
}
export function pipeLoss(m:number,rho:number,mu:number,d:number,L:number,roughness:number,K=0):number {
  if(![m,rho,mu,d,L,roughness,K].every(Number.isFinite)||rho<=0||mu<=0||d<=0||L<0||roughness<0||roughness>=d||K<0)throw Error('Invalid single-phase pipe-loss state')
  if(m===0)return 0
  const A=Math.PI*d*d/4,re=Math.abs(m)*d/(A*mu),v=m/(rho*A)
  return (darcyFriction(re,roughness/d)*L/d+K)*rho*v*Math.abs(v)/2
}
export function auditPrhrGeometry(input:PrhrGeometryBasis) {
  const b=schema.parse(input),t=b.tubes,p=b.pool,c=b.calibration
  const tubeLength=2*t.straightLeg_m+t.top_m-t.bottom_m-2*t.bendRadius_m+Math.PI*t.bendRadius_m
  const cylinder=(id:number,od:number,L:number,n=1)=>({water_m3:n*Math.PI*id*id*L/4,steel_m3:n*Math.PI*(od*od-id*id)*L/4,external_m3:n*Math.PI*od*od*L/4,insideArea_m2:n*Math.PI*id*L,outsideArea_m2:n*Math.PI*od*L})
  const tube=cylinder(t.id_m,t.od_m,tubeLength,t.count),headers=cylinder(b.header.id_m,b.header.od_m,b.header.length_m,2)
  const hot=cylinder(b.hotConnector.id_m,b.hotConnector.od_m,b.hotConnector.length_m),cold=cylinder(b.coldConnector.id_m,b.coldConnector.od_m,b.coldConnector.length_m)
  const displacement=tube.external_m3+headers.external_m3,area=p.width_m*p.length_m
  const firstExposure=Math.max(t.top_m+t.od_m/2,t.top_m+b.header.od_m/2),lastWetting=Math.min(t.bottom_m-t.od_m/2,t.bottom_m-b.header.od_m/2)
  const initialSurface=p.floor_m+(p.initialWater_m3+displacement)/area
  if(initialSurface<=firstExposure)throw Error('Selected initial inventory does not fully immerse exchanger')
  const loss=(m:number,d:number,L:number,K=0)=>pipeLoss(m,c.density_kg_m3,c.viscosity_Pas,d,L,b.roughness_m,K)
  const tubeDrop=loss(c.flow_kg_s/t.count,t.id_m,tubeLength,2*t.bendLoss_K+t.entryExitLoss_K)
  const connectorDrop=loss(c.flow_kg_s,b.hotConnector.id_m,b.hotConnector.length_m)+loss(c.flow_kg_s,b.coldConnector.id_m,b.coldConnector.length_m)+loss(c.flow_kg_s,b.hotConnector.id_m,0,b.connectorLoss_K/2)+loss(c.flow_kg_s,b.coldConnector.id_m,0,b.connectorLoss_K/2)
  // Reverse-return headers: each discrete outlet/inlet changes retained axial flow.
  // This is a uniform-branch allocation SCREEN, not a solved parallel-flow network.
  const dx=b.header.length_m/t.count,paths=[] as number[]
  const inletSegments=Array.from({length:t.count},(_,j)=>loss(c.flow_kg_s*(t.count-j-.5)/t.count,b.header.id_m,dx))
  const outletSegments=Array.from({length:t.count},(_,j)=>loss(c.flow_kg_s*(j+.5)/t.count,b.header.id_m,dx))
  for(let j=0;j<t.count;j++)paths.push(inletSegments.slice(0,j).reduce((a,v)=>a+v,0)+inletSegments[j]!/2+outletSegments[j]!/2+outletSegments.slice(j+1).reduce((a,v)=>a+v,0))
  const headerMean=paths.reduce((a,v)=>a+v,0)/paths.length
  const fixedMean=c.meterDrop_Pa+tubeDrop+connectorDrop+headerMean,valveDrop=c.totalDrop_Pa-fixedMean
  if(valveDrop<=0)throw Error('Geometry exhausts the authored loss budget; do not hide negative valve resistance')
  return {tubeLength_m:tubeLength,tube,headers,hotConnector:hot,coldConnector:cold,
    primaryWater_m3:tube.water_m3+headers.water_m3+hot.water_m3+cold.water_m3,
    submergedSteelHeatCapacity_J_K:(tube.steel_m3+headers.steel_m3)*b.steelDensity_kg_m3*b.steelCp_J_kgK,
    tubeRadialConductance_W_K:2*Math.PI*b.steelConductivity_W_mK*tubeLength*t.count/Math.log(t.od_m/t.id_m),
    pool:{area_m2:area,displacement_m3:displacement,initialSurface_m:initialSurface,firstExposure_m:firstExposure,lastWetting_m:lastWetting,
      waterToFirstExposure_m3:area*(initialSurface-firstExposure),gasAndPoolEnclosure_m3:p.initialGas_m3+p.initialWater_m3+displacement},
    calibration:{tubeDrop_Pa:tubeDrop,connectorDrop_Pa:connectorDrop,headerMeanDrop_Pa:headerMean,headerMinDrop_Pa:Math.min(...paths),headerMaxDrop_Pa:Math.max(...paths),
      fixedMeanDrop_Pa:fixedMean,selectedValveDrop_Pa:valveDrop,totalDrop_Pa:fixedMean+valveDrop,
      headerMaldistributionHeadSpread_Pa:Math.max(...paths)-Math.min(...paths)},
    scope:'Authored geometry and isothermal single-phase loss allocation; not flow-distribution, pressure-boundary, thermal-capacity or transient qualification'}
}
if(import.meta.main){
  const [owner,...rest]=process.argv.slice(2);if(!owner||rest.length)throw Error('Usage: prhr-geometry <owner.md>')
  const source=await Bun.file(import.meta.path).text(),input=parsePrhrGeometry(await Bun.file(owner).text()),output=auditPrhrGeometry(input)
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({sourceSha256:hash(source),inputSha256:hash(JSON.stringify(input)),input,...output},null,2))
}
