/** Geometry/kinematics screen over retained finite-source states; no mixing law. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { cmtStratificationDefinitions, parseStratificationBasis } from './reference-design-cmt-stratification.ts'

const positive = z.number().finite().positive()
const schema = z.object({ pipeDiameter_m: positive, slotRadius_m: positive, slotGap_m: positive,
  slotElevation_m: z.number().finite(), tankTop_m: positive, tankArea_m2: positive,
  topProbeElevation_m: z.number().finite(), referenceFlow_kg_s: positive,
  totalReferenceLoss_Pa: positive, exitLossCoefficient: positive }).strict().superRefine((x,c) => {
  if (x.slotElevation_m+x.slotGap_m/2>=x.tankTop_m || x.slotElevation_m-x.slotGap_m/2<=x.topProbeElevation_m ||
    x.slotRadius_m>=Math.sqrt(x.tankArea_m2/Math.PI)) c.addIssue({code:'custom',message:'Inlet/probe geometry does not fit the tank'})
})
export function parseInletBasis(document:string) {
  const blocks=[...document.matchAll(/^```reference-cmt-inlet\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw new Error('Expected one reference-cmt-inlet numeric block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export function inletScales(flow:number,inletDensity:number,receiverDensity:number,area:number,length:number) {
  if (![flow,inletDensity,receiverDensity,area,length].every(Number.isFinite) ||
    Math.min(inletDensity,receiverDensity,area,length)<=0) throw new Error('Invalid inlet scale state')
  const velocity=flow/(inletDensity*area), gravity=9.80665*(receiverDensity-inletDensity)/receiverDensity
  return { velocity_m_s:velocity, reducedGravity_m_s2:gravity,
    buoyancy:gravity>0?'lighter_inlet':gravity<0?'denser_inlet':'density_matched',
    direction:flow>0?'inflow':flow<0?'outflow':'zero_flow',
    dynamicHead_Pa:.5*inletDensity*velocity**2,
    signedRichardson:velocity===0?null:gravity*length/velocity**2,
    densimetricFroude:gravity===0?null:Math.abs(velocity)/Math.sqrt(Math.abs(gravity)*length),
    inertialBuoyancyLength_m:gravity===0?null:velocity**2/Math.abs(gravity) }
}
export function allocateLoss(density:number,flow:number,area:number,zeta:number,total:number) {
  if (![density,flow,area,zeta,total].every(Number.isFinite) || Math.min(density,flow,area,zeta,total)<=0)
    throw new Error('Invalid loss allocation')
  const exit=zeta*flow**2/(2*density*area**2)
  if(exit>=total)throw new Error('Selected exit leaves no positive feed-line loss budget')
  return { referenceDensity_kg_m3:density, exitReferenceLoss_Pa:exit, remainingLineReferenceLoss_Pa:total-exit }
}

export const inletCalculation=cmtStratificationDefinitions+String.raw`
cases=[study(name,nt,b['maximumStep_s'],True) for name,nt in [('limited',b['topCells']),('limited_double_top',2*b['topCells'])]]
print(json.dumps(dict(cases=cases,referenceDensity_kg_m3=water(b['initialPressure_MPa']*1e6,b['hot_C']+273.15)[0])))
`
type Row={t_s:number;balanceToTankFlow_kg_s:number;balanceDensity_kg_m3:number;topCellDensity_kg_m3:number;
  tankInletMass_kg:number;inletStateVolume_m3:number|null;[key:string]:unknown}
const added=['balanceToTankFlow_kg_s','balanceDensity_kg_m3','topCellDensity_kg_m3','tankInletMass_kg','inletStateVolume_m3']
export function oldTraceProjection(trace:Row[]) {
  return trace.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!added.includes(key))))
}
if(import.meta.main) {
  const [page,python,retainedPath]=process.argv.slice(2)
  if(!page||!python||!retainedPath)throw new Error('Usage: reference-design-cmt-inlet.ts <wiki-page> <python> <retained-calorimetry-json>')
  const document=await Bun.file(page).text(), input=parseStratificationBasis(document), geometry=parseInletBasis(document)
  const retainedText=await Bun.file(retainedPath).text(),retained=JSON.parse(retainedText)
  if(retained.calculationHash!=='22e1b49f0fd5804024756848b13c553f029e0cb4ddb0842b39e20b31d12ba617')
    throw new Error('Expected the retained, independently reviewed calorimetry source')
  const child=Bun.spawn([python,'-c',inletCalculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(status!==0)throw new Error(stderr)
  const result=JSON.parse(stdout),slotArea=2*Math.PI*geometry.slotRadius_m*geometry.slotGap_m
  const pipeArea=Math.PI*geometry.pipeDiameter_m**2/4
  const cases=result.cases.map((run:{name:string;trace:Row[];finalSnapshot:{area_m2:number;topElevation_m:number}})=>{
    const old=retained.cases.find((c:{name:string})=>c.name===run.name)?.sourceRun
    if(!old||JSON.stringify(oldTraceProjection(run.trace))!==JSON.stringify(old.trace))throw new Error('Historical trace changed')
    if(geometry.tankArea_m2!==run.finalSnapshot.area_m2 || geometry.tankTop_m!==run.finalSnapshot.topElevation_m)
      throw new Error('Screen geometry differs from actual source tank')
    const screen=run.trace.map(row=>({t_s:row.t_s,
      slotAgainstTopCell:inletScales(row.balanceToTankFlow_kg_s,row.balanceDensity_kg_m3,row.topCellDensity_kg_m3,slotArea,geometry.slotGap_m),
      barePipeAgainstTopCell:inletScales(row.balanceToTankFlow_kg_s,row.balanceDensity_kg_m3,row.topCellDensity_kg_m3,pipeArea,geometry.pipeDiameter_m)}))
    const last=run.trace.at(-1)!
    // Existing BAL volume is exactly 1 m3. Main-to-BAL and BAL-to-tank
    // integrals must differ by its actual stored mass change.
    const balanceMassResidual=last.tankInletMass_kg-Number(last.grossInlet_kg)-
      (run.trace[0]!.balanceDensity_kg_m3-last.balanceDensity_kg_m3)
    if(Math.abs(balanceMassResidual)>1e-5)throw new Error('Actual tank inlet integral violates finite BAL mass balance')
    return {name:run.name,historicalTraceExactlyEqual:true,balanceMassResidual_kg:balanceMassResidual,run,screen,
      finalInletStateVolume_m3:last.inletStateVolume_m3,
      equivalentVolumeDepth_m:last.inletStateVolume_m3===null?null:last.inletStateVolume_m3/geometry.tankArea_m2,
      slotToProbe_m:geometry.slotElevation_m-geometry.topProbeElevation_m}
  })
  console.log(JSON.stringify({scope:'New inlet geometry screened over unchanged old apparatus states, not hardware-coupled dynamics',input,geometry,
    postprocessorSourceHash:createHash('sha256').update(await Bun.file(import.meta.path).text()).digest('hex'),
    inputHash:createHash('sha256').update(JSON.stringify({input,geometry})).digest('hex'),
    calculationHash:createHash('sha256').update(inletCalculation).digest('hex'),
    retainedArtifactHash:createHash('sha256').update(retainedText).digest('hex'),
    areas_m2:{slot:slotArea,barePipe:pipeArea},
    allocation:allocateLoss(result.referenceDensity_kg_m3,geometry.referenceFlow_kg_s,slotArea,geometry.exitLossCoefficient,geometry.totalReferenceLoss_Pa),
    cases,pressureFrontQualified:false,physicalEntrainmentSelected:false},null,2))
}
