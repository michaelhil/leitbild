/** Offline geometry check, not an installed pool flash or geometry service. */
import { createHash } from 'node:crypto'
import { parseFuelHandling, fuelHandlingChecks } from './reference-design-fuel-handling'
import { parseFuelConstruction } from './reference-design-fuel-construction'

export type DisplacedSlice = { bottom_m: number; top_m: number; area_m2: number }

/** Slices must already represent disjoint solid/sealed-envelope incidence. */
export function poolLiquidMoments(area: number, floor: number, surface: number, slices: readonly DisplacedSlice[]) {
  if (![area, floor, surface].every(Number.isFinite) || area <= 0 || surface < floor) throw Error('Invalid pool geometry')
  for (const s of slices) if (![s.bottom_m,s.top_m,s.area_m2].every(Number.isFinite) || s.top_m<=s.bottom_m || s.area_m2<0) throw Error('Invalid displaced slice')
  const cuts = [...new Set([floor,surface,...slices.flatMap(s=>[s.bottom_m,s.top_m]).filter(z=>z>floor&&z<surface)])].sort((a,b)=>a-b)
  let volume=0, firstMoment=0
  for(let i=1;i<cuts.length;i++) {
    const lo=cuts[i-1]!,hi=cuts[i]!,mid=(lo+hi)/2
    const available=area-slices.filter(s=>s.bottom_m<mid&&s.top_m>mid).reduce((a,s)=>a+s.area_m2,0)
    if(available<=0) throw Error('Disconnected or overfilled geometric slice')
    volume+=available*(hi-lo)
    firstMoment+=available*(hi-lo)*(hi+lo)/2
  }
  return { volume_m3:volume, firstMoment_m4:firstMoment, centroid_m:volume>0?firstMoment/volume:null }
}

export function poolSurfaceForVolume(area:number,floor:number,ceiling:number,volume:number,slices:readonly DisplacedSlice[]) {
  if(!Number.isFinite(volume)||volume<0)throw Error('Invalid liquid volume')
  const capacity=poolLiquidMoments(area,floor,ceiling,slices).volume_m3
  if(volume>capacity)throw Error('Volume exceeds specified geometric range')
  if(volume===0)return floor
  const cuts=[...new Set([floor,ceiling,...slices.flatMap(s=>[s.bottom_m,s.top_m]).filter(z=>z>floor&&z<ceiling)])].sort((a,b)=>a-b)
  for(let i=1;i<cuts.length;i++) {
    const lo=cuts[i-1]!,hi=cuts[i]!
    const low=poolLiquidMoments(area,floor,lo,slices).volume_m3,high=poolLiquidMoments(area,floor,hi,slices).volume_m3
    if(volume<=high)return lo+(volume-low)*(hi-lo)/(high-low)
  }
  throw Error('No liquid-surface solution')
}

if(import.meta.main) {
  const [handlingPath,fuelPath,receipt,...extra]=Bun.argv.slice(2)
  if(!handlingPath||!fuelPath||!receipt||extra.length)throw Error('Usage: pool-moments <handling-owner> <fuel-owner> <new-receipt>')
  if(await Bun.file(receipt).exists())throw Error('Refusing to overwrite receipt')
  const handlingText=await Bun.file(handlingPath).text(),fuelText=await Bun.file(fuelPath).text()
  const h=parseFuelHandling(handlingText),f=parseFuelConstruction(fuelText),geometry=fuelHandlingChecks(h,f)
  const rack={bottom_m:h.poolFloor_m+h.bottomFittingLength_m,top_m:h.poolFloor_m+h.bottomFittingLength_m+f.activeLength_m,
    area_m2:geometry.rack.totalSleeveDisplacement_m3/f.activeLength_m}
  const area=h.poolSide_m**2
  const empty=poolLiquidMoments(area,h.poolFloor_m,h.surface_m,[])
  const rackOnly=poolLiquidMoments(area,h.poolFloor_m,h.surface_m,[rack])
  const recovered=poolSurfaceForVolume(area,h.poolFloor_m,h.surface_m+1,rackOnly.volume_m3,[rack])
  if(Math.abs(recovered-h.surface_m)>1e-12)throw Error('Surface inverse mismatch')
  const input=JSON.stringify({area,floor:h.poolFloor_m,surface:h.surface_m,rack})
  const result={scope:'Current empty-rack displacement only; no gate, loaded fuel, native fluid trajectory or complete original inventory claim.',
    inputSHA256:createHash('sha256').update(input).digest('hex'),sourceSHA256:createHash('sha256').update(await Bun.file(import.meta.path).text()).digest('hex'),
    input:JSON.parse(input),empty,rackOnly,recoveredSurface_m:recovered,
    rejectedNetVolumePrismCentroid_m:h.poolFloor_m+rackOnly.volume_m3/(2*area)}
  await Bun.write(receipt,JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result,null,2))
}
