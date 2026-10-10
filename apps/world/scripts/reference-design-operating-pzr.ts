/** Actual PZR/connection geometry and finite NC-free water/tracer preparation. Rust owns
 * thermodynamic/rate laws. No fine field, HEM vessel, held pressure or line
 * solver is imported; numerical phase force/active topology admission is open. */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {z} from 'zod'
import {heaterBankBasis,heaterBankGeometry} from './reference-design-pressurizer-heater-banks'
import {parseSurgeRoute,resolveSurgeRoute,routeElevation} from './reference-design-surge-route'
import {withOperatingIf97,waterPartials,fixedVolumeChart} from './reference-design-operating-fluid'
import {nativeIf97Revision,nativeIf97HeaderSha256,nativeIf97LicenseSha256} from './reference-design-if97-primitives'

const positive=z.number().finite().positive()
const schema=z.object({commonPressure_Pa:positive,liquidTemperature_K:positive,vaporTemperature_K:positive,
  phaseBoundaryHeight_m:positive,bands_m:z.tuple([z.literal(0),z.literal(1),z.literal(3),z.literal(6),z.literal(9),z.literal(12)]),
  interfacialLength_m:positive,solidRoughness_m:z.number().finite().nonnegative(),
  absorberMassFraction:z.number().finite().min(0).lt(1)}).strict()
export function parseOperatingPzr(text:string){
  const blocks=[...text.matchAll(/^```reference-operating-pzr\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-operating-pzr block')
  const b=schema.parse(JSON.parse(blocks[0]![1]!))
  if(b.phaseBoundaryHeight_m!==6)throw Error('Selected PZR preparation boundary must match actual6m band')
  return b
}
export type PzrRegion={id:string,lane:'inner'|'outer',bottom_m:number,top_m:number,elevation_m:number,
  radialCentroid_m:number,volume_m3:number,axialArea_m2:number,solidPerimeter_m:number,initialPhase:'liquid'|'vapor'}
export type PzrFace={id:string,from:number,to:number,area_m2:number,direction:'radial'|'axial',elevation_m:number,
  distance_m:number,normal:[number,number],contrastContact:true,bulkPhaseVelocity:'separate'}
export type PzrPort={id:string,region:number,area_m2:number,elevation_m:number,normal:[number,number,number],
  receiptConvention:'signed thermal enthalpy into each actual phase',noncondensableScope:'explicit refusal in first composed hot spine'}

export type HotEnvelope={id:string,volume_m3:number,mainFlowArea_m2:number,elevation_m:number}
export function compileOperatingPzr(selection:string,surgeOwner:string,hot:HotEnvelope){
  const b=parseOperatingPzr(selection),hardware=heaterBankBasis,bank=heaterBankGeometry(6),
    route=resolveSurgeRoute(parseSurgeRoute(surgeOwner)),innerRadius=Math.sqrt(hardware.upflowArea_m2/Math.PI),
    shellRadius=Math.sqrt(hardware.vesselArea_m2/Math.PI),
    // Selected uniform gross-ring volume centroids. Rod displacement remains
    // in actual fluid V/A and solid perimeter, not a second fitted radial mesh.
    innerCentroid=2*innerRadius/3,outerCentroid=(2/3)*(shellRadius**3-innerRadius**3)/(shellRadius**2-innerRadius**2),
    regions:PzrRegion[]=[],faces:PzrFace[]=[],
    rodArea=(z:number)=>Object.values(hardware).reduce((sum,q)=>sum+(typeof q==='object'&&'count'in q&&z<=q.length_m?q.count*Math.PI*(q.diameter_m/2)**2:0),0)
  if(route.receiverElevation_m!==hardware.bottom_m||route.internalDiameter_m!==.3)throw Error('PZR mouth/route datum mismatch')
  if(hot.id!=='HOT.A'||![hot.volume_m3,hot.mainFlowArea_m2,hot.elevation_m].every(Number.isFinite)
    ||hot.mainFlowArea_m2<=0||hot.volume_m3<=hot.mainFlowArea_m2||hot.elevation_m!==route.sourceElevation_m)throw Error('Invalid actual HOT.A envelope/datum')
  for(let i=0;i<5;i++){
    const lo=b.bands_m[i]!,hi=b.bands_m[i+1]!,mid=(lo+hi)/2,
      area=hardware.upflowArea_m2-rodArea(mid),perimeter=(['normal','backup']as const).reduce((a,k)=>a+(mid<hardware[k].length_m?hardware[k].count*Math.PI*hardware[k].diameter_m:0),0)
    for(const lane of ['inner','outer']as const)regions.push({id:`PZR.${i}.${lane}`,lane,bottom_m:hardware.bottom_m+lo,top_m:hardware.bottom_m+hi,
      elevation_m:hardware.bottom_m+mid,radialCentroid_m:lane==='inner'?innerCentroid:outerCentroid,
      volume_m3:(hi-lo)*(lane==='inner'?area:hardware.vesselArea_m2-hardware.upflowArea_m2),
      axialArea_m2:lane==='inner'?area:hardware.vesselArea_m2-hardware.upflowArea_m2,
      solidPerimeter_m:lane==='inner'?perimeter:2*Math.PI*shellRadius,initialPhase:hi<=b.phaseBoundaryHeight_m?'liquid':'vapor'})
    faces.push({id:`PZR.RADIAL.${i}`,from:2*i,to:2*i+1,area_m2:2*Math.PI*innerRadius*(hi-lo),direction:'radial',elevation_m:hardware.bottom_m+mid,
      distance_m:outerCentroid-innerCentroid,normal:[1,0],contrastContact:true,bulkPhaseVelocity:'separate'})
    if(i<4)for(const lane of [0,1])faces.push({id:`PZR.AXIAL.${i}.${lane}`,from:2*i+lane,to:2*(i+1)+lane,
      // Lower-sided/minimum throat: a rod end cap remains solid on its plane.
      // This intentionally differs from the upper-sided volume-section helper.
      area_m2:lane===0?hardware.upflowArea_m2-rodArea(hi):hardware.vesselArea_m2-hardware.upflowArea_m2,
      direction:'axial',elevation_m:hardware.bottom_m+hi,distance_m:(b.bands_m[i+2]!-b.bands_m[i]!)/2,
      normal:[0,1],contrastContact:true,bulkPhaseVelocity:'separate'})
  }
  const totalVolume=regions.reduce((a,r)=>a+r.volume_m3,0)
  if(Math.abs(totalVolume+bank.totalSolid_m3-hardware.vesselArea_m2*hardware.vesselHeight_m)>1e-12)throw Error('PZR displaced volume mismatch')
  // Each ladder rectangle is a conservative circulation; four PER phase when
  // every phase is present. Exact absence changes the actual active subgraph.
  const cycles=Array.from({length:4},(_,i)=>{
    const c=faces.map(()=>0),set=(from:number,to:number,w:number)=>{const j=faces.findIndex(f=>f.from===from&&f.to===to);if(j<0)throw Error('Missing actual PZR face');c[j]=w}
    set(2*i,2*i+1,1);set(2*i+1,2*(i+1)+1,1);set(2*(i+1),2*(i+1)+1,-1);set(2*i,2*(i+1),-1);return c
  })
  for(const c of cycles){const B=regions.map(()=>0);for(const[f,w]of c.entries()){B[faces[f]!.from]!-=w;B[faces[f]!.to]!+=w}if(B.some(v=>v!==0))throw Error('Nonconservative PZR cycle')}
  const mouth:PzrPort={id:'PZR.SURGE.MOUTH',region:1,area_m2:route.area_m2,elevation_m:hardware.bottom_m,normal:[0,0,1],
    receiptConvention:'signed thermal enthalpy into each actual phase',noncondensableScope:'explicit refusal in first composed hot spine'},
    hotArea=hot.mainFlowArea_m2,junctionVolume=hotArea,stubVolume=(hot.volume_m3-junctionVolume)/2,
    lengths=route.lengths_m,ends=lengths.reduce<number[]>((a,L)=>[...a,a[a.length-1]!+L],[0]),
    pieces=lengths.map((L,i)=>({id:`SURGE.PHYSICAL.${i}`,length_m:L,area_m2:route.area_m2,volume_m3:L*route.area_m2,
      start_m:ends[i]!,end_m:ends[i+1]!,inletElevation_m:routeElevation(route,ends[i]!),outletElevation_m:routeElevation(route,ends[i+1]!),
      wallRoughness_m:route.roughness_m,elbowLoss:i===1||i===3?route.elbowLoss:0}))
  return {scope:'Actual common-P NC-free water PZR chart/ports with retained passive absorber; pressure/kinematic/inertia composition and joined rank unadmitted',selection:b,regions,faces,
    radialGeometry:{innerRadius_m:innerRadius,shellRadius_m:shellRadius,innerCentroid_m:innerCentroid,outerCentroid_m:outerCentroid,
      scope:'Selected uniform gross-annular volume centroid approximation for radial gradients; actual displaced V/A, face apertures and rod/shell perimeter stay separate'},
    totalVolume_m3:totalVolume,heaterDisplacement_m3:bank.totalSolid_m3,cycleColumns:cycles,
    phaseCycles:{liquid:4,vapor:4,preparedLiquid:2,preparedVapor:1,scope:'Maximum graph-cycle supports only, not a complete dynamic allocation; actual absentphase topology is not padded with momentum/property states'},
    material:'NC-free water EOS with finite passive dissolved absorber; any air/nitrogen amount or arrival explicitly refuses',
    mouth:{...mouth,withdrawalCdAAtUnitFraction_m2:mouth.area_m2/Math.sqrt(1.5),receiptArea_m2:mouth.area_m2,radiusFromAxis_m:.8,
      bottomOuterContactArea_m2:hardware.vesselArea_m2-hardware.upflowArea_m2-mouth.area_m2},
    hotPartition:{sourceOwner:'HOT.A',totalVolume_m3:hot.volume_m3,parts:[{id:'HOT.A.UPSTREAM',volume_m3:stubVolume,length_m:stubVolume/hotArea},
      {id:'HOT.A.JUNCTION',volume_m3:junctionVolume,length_m:1},{id:'HOT.A.DOWNSTREAM',volume_m3:stubVolume,length_m:stubVolume/hotArea}],
      area_m2:hotArea,surgeArea_m2:route.area_m2,elevation_m:route.sourceElevation_m,
      junctionPorts:[{id:'HOT.A.JUNCTION.UPSTREAM',area_m2:hotArea,normal:[-1,0,0]as [number,number,number]},
        {id:'HOT.A.JUNCTION.DOWNSTREAM',area_m2:hotArea,normal:[1,0,0]as [number,number,number]},
        {id:'HOT.A.JUNCTION.SURGE',area_m2:route.area_m2,normal:[0,1,0]as [number,number,number]}],
      reflectingSideAreas_m2:{positiveY:Math.sqrt(hotArea)-route.area_m2,negativeY:Math.sqrt(hotArea)},
      scope:'Distinct finite thermal owners; carve existing15m³, do not append water or keep an off-centre merged stub'},
    surge:{route,pieces,scope:'Five physical geometry supports, NOT five selected fluid pressure cells; remove existingSURGE from primary territory exactlyonce; retain finite line with own currentpressure/material'},
    pressureScope:'One separate PZR thermodynamicP; currentdensity hydrostatic/multiplier forces/taps, excluded from EOS under0012 requires local saturation/level/control budgets'}
}

export async function prepareOperatingPzr(wikiRoot:string,if97Directory:string,hot:HotEnvelope){
  const base=join(wikiRoot,'world/packs/process-plant/reference-designs/ld-01'),paths=['systems/primary-coolant/pressurizer-thermal-state.md','systems/primary-coolant/surge-route.md'],
    docs=await Promise.all(paths.map(p=>Bun.file(join(base,p)).text())),g=compileOperatingPzr(docs[0]!,docs[1]!,hot),b=g.selection
  return withOperatingIf97(if97Directory,async query=>{
    const props=await query([{branch:'liquid',p:b.commonPressure_Pa,T:b.liquidTemperature_K},{branch:'vapor',p:b.commonPressure_Pa,T:b.vaporTemperature_K}]),
      regions=g.regions.map(r=>{const q=props[r.initialPhase==='liquid'?0:1]!,c=fixedVolumeChart(r.volume_m3,q);return {...r,
        commonPressure_Pa:b.commonPressure_Pa,vaporFraction:r.initialPhase==='liquid'?0:1,liquidEnergy_J:r.initialPhase==='liquid'?c.internalEnergy_J:0,
        vaporEnergy_J:r.initialPhase==='vapor'?c.internalEnergy_J:0,mass_kg:c.mass_kg,water:q,partials:waterPartials(q),
        // Once-only prepared tracer stock; pressure/temperature trials do not
        // reapply this fraction to the current EOS mass.
        absorberTracer_kgEq:r.initialPhase==='liquid'?b.absorberMassFraction*c.mass_kg:0,
        airMass_kg:0,nitrogenMass_kg:0,massPAtEnergy_kg_Pa:c.massPAtEnergy_kg_Pa,massEnergyAtPressure_kg_J:c.massEnergyAtPressure_kg_J}}),
      hash=(s:string)=>createHash('sha256').update(s).digest('hex')
    return {...g,regions,totalMass_kg:regions.reduce((a,r)=>a+r.mass_kg,0),totalInternalEnergy_J:regions.reduce((a,r)=>a+r.liquidEnergy_J+r.vaporEnergy_J,0),
      aggregateMassPAtEnergy_kg_Pa:regions.reduce((a,r)=>a+r.massPAtEnergy_kg_Pa,0),
      preparationScope:'Fresh finite commonP NC-free water thermal and dissolved-tracer stocks; not oldseedprofile, hydrostatic/forcebalance or phasecycleflow initialization',
      provenance:{sourceSha256:hash(await Bun.file(import.meta.path).text()),consumed:paths.map((name,i)=>({name,sha256:hash(docs[i]!)})),
        if97Revision:nativeIf97Revision,if97HeaderSha256:nativeIf97HeaderSha256,if97LicenseSha256:nativeIf97LicenseSha256,
        propertyInterfaceSha256:hash(await Bun.file(new URL('./reference-design-operating-fluid.ts',import.meta.url)).text()),
        propertyPrimitiveSha256:hash(await Bun.file(new URL('./reference-design-if97-primitives.ts',import.meta.url)).text()),
        geometryHelperSha256:hash(await Bun.file(new URL('./reference-design-pressurizer-heater-banks.ts',import.meta.url)).text()),
        surgeHelperSha256:hash(await Bun.file(new URL('./reference-design-surge-route.ts',import.meta.url)).text())}}
  })
}
