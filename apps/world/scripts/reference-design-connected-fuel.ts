/** One connected physical-geometry reference, using the existing exact owners. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { fuelGeometry,parseFuelConstruction,runFuelConstruction } from './reference-design-fuel-construction.ts'
import { runInitialization,type PhysicalCoreReference } from './reference-design-initialization.ts'
const positive=z.number().finite().positive()
const schema=z.object({gridPositions_m:z.array(positive).min(2),blockageFraction:positive.lt(1),
  gridLossFactor:positive,inletLoss:z.number().finite().nonnegative(),outletLoss:z.number().finite().nonnegative()}).strict()
export function parseConnectedFuelSelection(document:string){
  const blocks=[...document.matchAll(/^```reference-connected-fuel\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected exactly one reference-connected-fuel block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function parseConnectedFuel(document:string,fuelDocument:string):PhysicalCoreReference{
  const b=parseConnectedFuelSelection(document),fuel=parseFuelConstruction(fuelDocument),half=fuel.activeLength_m/2
  if(b.gridPositions_m.some((p,i)=>p>=fuel.activeLength_m||p===half||(i>0&&p<=b.gridPositions_m[i-1]!)))throw Error('Grid planes must be ordered inside the active core, away from the cell face')
  const lower=b.gridPositions_m.filter(p=>p<half).length,upper=b.gridPositions_m.length-lower
  if(lower!==upper)throw Error('This two-slice reference requires equal grid counts per half')
  return {geometry:fuelGeometry(fuel),activeLength_m:fuel.activeLength_m,gridsPerHalf:lower,
    blockageFraction:b.blockageFraction,gridLossFactor:b.gridLossFactor,inletLoss:b.inletLoss,outletLoss:b.outletLoss}
}
export async function runConnectedFuel(initializationDocument:string,hydraulicDocument:string,cycleDocument:string,fuelDocument:string,python:string){
  const core=parseConnectedFuel(initializationDocument,fuelDocument)
  const connected=await runInitialization(initializationDocument,hydraulicDocument,cycleDocument,python,core)
  const cells=connected.cells as Array<{p_MPa:number;T_C:number}>
  const lower=cells[1]!,mid=cells[2]!,upper=cells[3]!
  const radial=await runFuelConstruction(fuelDocument,python,{
    coolantPressures_MPa:[lower.p_MPa,mid.p_MPa,upper.p_MPa],
    coolantTemperatures_K:[lower.T_C+273.15,mid.T_C+273.15,upper.T_C+273.15],
    massflow_kg_s:connected.nominal.flow_kg_s[1],cellHeat_W:connected.coreHeat_W,
  })
  return {scope:'connected physical lattice/grid reference plus reciprocal steady fresh-rod evaluation; no radial fuel transient or fuel qualification',
    coordinatorSha256:createHash('sha256').update(await Bun.file(import.meta.path).bytes()).digest('hex'),connected,radial}
}
if(import.meta.main){
  const [init,hydro,cycle,fuel,python,...extra]=Bun.argv.slice(2)
  if(!init||!hydro||!cycle||!fuel||!python||extra.length)throw Error('Usage: bun reference-design-connected-fuel.ts <initialization.md> <hydraulic.md> <cycle.md> <fuel.md> <isolated-python>')
  const docs=await Promise.all([init,hydro,cycle,fuel].map(p=>Bun.file(p).text()))
  console.log(JSON.stringify(await runConnectedFuel(docs[0]!,docs[1]!,docs[2]!,docs[3]!,python),null,2))
}
