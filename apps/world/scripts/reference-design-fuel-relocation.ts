/** Bounded BOL history endpoint using the reviewed connected input, not a new solver. */
import { createHash } from 'node:crypto'
import { runFuelConstruction } from './reference-design-fuel-construction.ts'
export async function runFuelRelocation(fuelDocument:string,connectedArtifact:string,python:string){
  const artifact=JSON.parse(connectedArtifact)
  if(artifact.scope!=='connected physical lattice/grid reference plus reciprocal steady fresh-rod evaluation; no radial fuel transient or fuel qualification'
    ||!artifact.radial?.actualBoundary||!artifact.connected?.physicalCoreInputSha256)throw Error('Expected reviewed connected physical-fuel artifact')
  const boundary=artifact.radial.actualBoundary
  const reference=await runFuelConstruction(fuelDocument,python,boundary)
  if(reference.inputSha256!==artifact.radial.inputSha256||reference.geometrySha256!==artifact.radial.geometrySha256)throw Error('Connected fuel basis differs; rerun its owner before relocation')
  const relocated=await runFuelConstruction(fuelDocument,python,boundary,'beginning-of-life')
  const differences=reference.base.rows.map((r:{cell:number;TfuelCenter_K:number;radialGap_um:number;fuelMass_kg:number;cladMass_kg:number},i:number)=>{
    const changed=relocated.base.rows[i]
    if(r.fuelMass_kg!==changed.fuelMass_kg||r.cladMass_kg!==changed.cladMass_kg)throw Error('Material history changed retained solid mass')
    return {cell:r.cell,centerTemperatureChange_K:changed.TfuelCenter_K-r.TfuelCenter_K,thermalGapChange_um:changed.radialGap_um-r.radialGap_um,
      mechanicalGap_um:changed.mechanicalGap_um,retainedMassUnchanged:true}
  })
  // Reject source-domain extrapolation using an actual rerun, not a claimed guard.
  let highDutyRejected=false
  try{await runFuelConstruction(fuelDocument,python,{...boundary,massflow_kg_s:boundary.massflow_kg_s*1.5,
    cellHeat_W:[boundary.cellHeat_W[0]*1.5,boundary.cellHeat_W[1]*1.5]},'beginning-of-life')}
  catch(error){if(error instanceof Error&&error.message.includes('actual LHGR below20kW/m'))highDutyRejected=true;else throw error}
  if(!highDutyRejected)throw Error('BOL branch extrapolation was not rejected')
  return {scope:'BOL low-linear-rating effective relocation reference; not a contact solver or empirical fuel qualification',
    connectedArtifactSha256:createHash('sha256').update(connectedArtifact).digest('hex'),
    coordinatorSha256:createHash('sha256').update(await Bun.file(import.meta.path).bytes()).digest('hex'),
    connectedInitializerSha256:artifact.connected.calculationSha256,reference,relocated,differences,highDutyRejected}
}
if(import.meta.main){
  const [fuel,connected,python,...extra]=Bun.argv.slice(2)
  if(!fuel||!connected||!python||extra.length)throw Error('Usage: bun reference-design-fuel-relocation.ts <fuel.md> <connected-fuel.json> <isolated-python>')
  console.log(JSON.stringify(await runFuelRelocation(await Bun.file(fuel).text(),await Bun.file(connected).text(),python),null,2))
}
