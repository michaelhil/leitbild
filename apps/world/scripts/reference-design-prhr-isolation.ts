/** Offline isolation material/geometry audit. No fluid, heat-transfer or valve-motion solver. */
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {auditPrhrGeometry,parsePrhrGeometry,type PrhrGeometryBasis} from './reference-design-prhr-geometry'

const positive=z.number().finite().positive()
const schema=z.object({spoolLength_m:positive,discDiameter_m:positive,discThickness_m:positive}).strict()
export type PrhrIsolationBasis=z.infer<typeof schema>
export function parsePrhrIsolation(text:string):PrhrIsolationBasis {
  const blocks=[...text.matchAll(/^```reference-prhr-isolation\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Exactly one PRHR isolation basis required')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function auditPrhrIsolation(geometry:PrhrGeometryBasis,input:PrhrIsolationBasis) {
  const base=auditPrhrGeometry(geometry),b=schema.parse(input),p=geometry.hotConnector
  const sweptDiameter=Math.hypot(b.discDiameter_m,b.discThickness_m)
  if(b.spoolLength_m>=p.length_m||b.spoolLength_m<=sweptDiameter||sweptDiameter>=p.id_m)throw Error('Disc sweep must fit the bore and carved-out spool')
  if(p.length_m-b.spoolLength_m<geometry.tubes.top_m-geometry.hotTerminal_m)throw Error('Remaining connector must reach upper header after horizontal spool')
  const boreArea=Math.PI*p.id_m**2/4,shellArea=Math.PI*(p.od_m**2-p.id_m**2)/4
  const discArea=Math.PI*b.discDiameter_m**2/4,discVolume=discArea*b.discThickness_m
  const spoolShellVolume=shellArea*b.spoolLength_m
  const rho=geometry.steelDensity_kg_m3,cp=geometry.steelCp_J_kgK,k=geometry.steelConductivity_W_mK
  const upstreamWater=boreArea*b.spoolLength_m/2-discVolume/2
  const revisedPrimaryWater=base.primaryWater_m3-discVolume
  return {
    geometry:{spoolLength_m:b.spoolLength_m,remainingHotConnector_m:p.length_m-b.spoolLength_m,
      closedSeatFromHot_m:b.spoolLength_m/2,sweptDiameter_m:sweptDiameter,
      minimumIdealRadialClearance_m:(p.id_m-sweptDiameter)/2,closedEdgeRadialGap_m:(p.id_m-b.discDiameter_m)/2,
      discVolume_m3:discVolume,spoolShellVolume_m3:spoolShellVolume,
      originalPrimaryWater_m3:base.primaryWater_m3,revisedPrimaryWater_m3:revisedPrimaryWater,
      closedHotConnectedWater_m3:upstreamWater,closedBankConnectedWater_m3:revisedPrimaryWater-upstreamWater,
      waterAllocationResidual_m3:upstreamWater+(revisedPrimaryWater-upstreamWater)+discVolume-base.primaryWater_m3,
      addedSteel_kg:rho*discVolume,existingSpoolSteel_kg:rho*spoolShellVolume,
      unchangedPoolDisplacement_m3:base.pool.displacement_m3},
    material:{discHeatCapacity_J_K:rho*cp*discVolume,spoolShellHeatCapacity_J_K:rho*cp*spoolShellVolume,
      discHalfCellConductance_W_K:2*k*discArea/b.discThickness_m,
      shellHalfCellConductance_W_K:2*k*shellArea/b.spoolLength_m,
      discFlatFaceConductance_W_K:k*discArea/b.discThickness_m,
      shellEndFaceConductance_W_K:k*shellArea/b.spoolLength_m,
      thermalDiffusivity_m2_s:k/(rho*cp),
      discThicknessDiffusionScale_s:b.discThickness_m**2*rho*cp/k,
      shellAxialDiffusionScale_s:b.spoolLength_m**2*rho*cp/k},
    scope:'Fictional conducting material and ideal geometric clearance only; conductances are solid-only, not fluid-to-fluid bounds or transient qualification. Edge seal/shaft net volume is included in equivalent allocations, not added again.',
  }
}
if(import.meta.main){
  const [owner,...rest]=process.argv.slice(2)
  if(!owner||rest.length)throw Error('Usage: prhr-isolation <owner.md>')
  const text=await Bun.file(owner).text(),geometry=parsePrhrGeometry(text),isolation=parsePrhrIsolation(text)
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({sourceSha256:hash(await Bun.file(import.meta.path).text()),
    geometrySourceSha256:hash(await Bun.file(new URL('./reference-design-prhr-geometry.ts',import.meta.url)).text()),
    inputSha256:hash(JSON.stringify({geometry,isolation})),input:{geometry,isolation},...auditPrhrIsolation(geometry,isolation)},null,2))
}
