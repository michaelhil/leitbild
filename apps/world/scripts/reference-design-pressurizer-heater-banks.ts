/** Elementary offline PZR heater geometry. No thermal carrier or live equipment. */
import {createHash} from 'node:crypto'

export const heaterBankBasis={
 vesselArea_m2:5,vesselHeight_m:12,bottom_m:6.5,upflowArea_m2:.5,steelDensity_kg_m3:7920,
 normal:{count:32,diameter_m:.02,length_m:1,capacity_W:120000},
 backup:{count:256,diameter_m:.02,length_m:3,capacity_W:2880000},
 backupGridPitch_m:.033,normalRingRadius_m:.38,
} as const
export type HeaterBankName='normal'|'backup'
export function heaterPacking(){
 const b=heaterBankBasis
 const rods:Array<{bank:HeaterBankName;x_m:number;y_m:number;radius_m:number}>=[]
 for(let i=0;i<16;i++)for(let j=0;j<16;j++)rods.push({bank:'backup',x_m:(i-7.5)*b.backupGridPitch_m,y_m:(j-7.5)*b.backupGridPitch_m,radius_m:b.backup.diameter_m/2})
 for(let i=0;i<b.normal.count;i++)rods.push({bank:'normal',x_m:b.normalRingRadius_m*Math.cos(2*Math.PI*i/b.normal.count),y_m:b.normalRingRadius_m*Math.sin(2*Math.PI*i/b.normal.count),radius_m:b.normal.diameter_m/2})
 const radius=Math.sqrt(b.upflowArea_m2/Math.PI)
 const wallClearance=Math.min(...rods.map(r=>radius-Math.hypot(r.x_m,r.y_m)-r.radius_m))
 let rodClearance=Infinity
 for(let i=0;i<rods.length;i++)for(let j=i+1;j<rods.length;j++){
  const a=rods[i]!,c=rods[j]!
  rodClearance=Math.min(rodClearance,Math.hypot(a.x_m-c.x_m,a.y_m-c.y_m)-a.radius_m-c.radius_m)
 }
 return {rods,upflowRadius_m:radius,minimumWallClearance_m:wallClearance,minimumRodClearance_m:rodClearance}
}
export function heaterBankGeometry(occupiedHeight_m:number){
 const b=heaterBankBasis
 if(!Number.isFinite(occupiedHeight_m)||occupiedHeight_m<0||occupiedHeight_m>b.vesselHeight_m)throw Error('Surface outside gross PZR geometry')
 const banks=Object.fromEntries((['normal','backup'] as const).map(name=>{
  const bank=b[name],wetLength=Math.min(occupiedHeight_m,bank.length_m),crossSection=bank.count*Math.PI*(bank.diameter_m/2)**2
  const solid=crossSection*bank.length_m,wetSolid=crossSection*wetLength
  const lateralArea=bank.count*Math.PI*bank.diameter_m*bank.length_m,wetArea=bank.count*Math.PI*bank.diameter_m*wetLength
  return [name,{bottom_m:b.bottom_m,top_m:b.bottom_m+bank.length_m,crossSection_m2:crossSection,solidVolume_m3:solid,steelMass_kg:solid*b.steelDensity_kg_m3,
   submergedSolid_m3:wetSolid,exposedSolid_m3:solid-wetSolid,wetSideArea_m2:wetArea,drySideArea_m2:lateralArea-wetArea,
   fullSideArea_m2:lateralArea,ratedSurfacePower_W_m2:bank.capacity_W/lateralArea}]
 })) as Record<HeaterBankName,{bottom_m:number;top_m:number;crossSection_m2:number;solidVolume_m3:number;steelMass_kg:number;submergedSolid_m3:number;exposedSolid_m3:number;wetSideArea_m2:number;drySideArea_m2:number;fullSideArea_m2:number;ratedSurfacePower_W_m2:number}>
 const submerged=banks.normal.submergedSolid_m3+banks.backup.submergedSolid_m3,exposed=banks.normal.exposedSolid_m3+banks.backup.exposedSolid_m3
 return {occupiedHeight_m,surface_m:b.bottom_m+occupiedHeight_m,banks,
  upflowFreeEnvelope_m3:b.upflowArea_m2*occupiedHeight_m-submerged,
  returnFreeEnvelope_m3:(b.vesselArea_m2-b.upflowArea_m2)*occupiedHeight_m,
  upperFreeEnvelope_m3:b.vesselArea_m2*(b.vesselHeight_m-occupiedHeight_m)-exposed,
  submergedSolid_m3:submerged,exposedSolid_m3:exposed,totalSolid_m3:submerged+exposed,
  totalSteelMass_kg:(submerged+exposed)*b.steelDensity_kg_m3}
}
/** Section-area limits are sided at the rod ends; an end plane adds no volume. */
export function heaterUpflowSection(heightAboveBottom_m:number){
 const b=heaterBankBasis
 if(!Number.isFinite(heightAboveBottom_m)||heightAboveBottom_m<0||heightAboveBottom_m>b.vesselHeight_m)throw Error('Section outside gross PZR geometry')
 return b.upflowArea_m2-(['normal','backup'] as const).reduce((sum,n)=>sum+(heightAboveBottom_m<b[n].length_m?b[n].count*Math.PI*(b[n].diameter_m/2)**2:0),0)
}
if(import.meta.main){
 const [output,...extra]=process.argv.slice(2)
 if(!output||extra.length)throw Error('Usage: pressurizer-heater-banks <receipt.json>')
 const source=await Bun.file(import.meta.path).text(),packing=heaterPacking()
 const input=heaterBankBasis,hash=(text:string)=>createHash('sha256').update(text).digest('hex')
 const result={scope:'Elementary authored hardware/coverage geometry only; no electrical mechanics, thermal source or carrier qualification',sourceSha256:hash(source),inputSha256:hash(JSON.stringify(input)),basis:input,
  packing:{upflowRadius_m:packing.upflowRadius_m,rodCount:packing.rods.length,minimumWallClearance_m:packing.minimumWallClearance_m,minimumRodClearance_m:packing.minimumRodClearance_m},
  surfaces:[0,.5,1,2,3,6,12].map(heaterBankGeometry),freeSections:[.5,2,4].map(h=>({heightAboveBottom_m:h,freeArea_m2:heaterUpflowSection(h)}))}
 if(source!==await Bun.file(import.meta.path).text())throw Error('Source changed during calculation')
 await Bun.write(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({output,sourceSha256:result.sourceSha256,packing:result.packing}))
}
