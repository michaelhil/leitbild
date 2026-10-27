import {createHash} from 'node:crypto'
import unitSource from '../pwr-full-unit-drafting.source.json'
import unitBindings from '../pwr-full-unit-drafting.bindings.json'
import unitCoverage from '../pwr-full-unit-drafting.coverage.json'
import campusSource from '../pwr-campus-drafting.source.json'
import campusBindings from '../pwr-campus-drafting.bindings.json'
import campusCoverage from '../pwr-campus-drafting.coverage.json'
import {canonicalPhysicalJson, physicalCorrespondenceSchema} from '../model.ts'
import {physicalCoverageEvidenceSchema} from '../coverage.ts'
import {physicalSourceSchema, physicalSourceFacts} from '../native/drafting/source.ts'
import {compilePhysicalScene} from '../native/drafting/compile-scene.ts'
import {physicalSceneShapeFacts} from '../source-validation.ts'

const hash=(value:unknown):string=>createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')

/** Explicit source authoring ledger, never a renderer rule about unbound pipes.
 * Each superseded illustration names the accepted graph/port replacement. */
export const pwrSupersededRoutePreviews=[
  {preview:'main-steam-route',routes:['main-steam-header-to-turbine-stop-valve','turbine-stop-valve-to-turbine'],reason:'Retired unbound two-room steam preview with an unsupported free end above the HP turbine, bypassing the graph-owned stop valve.'},
  {preview:'feedwater-route',routes:['main-feedwater-pump-a-to-header'],reason:'Retired unbound two-room feedwater preview duplicating the accepted graph-bound pump-to-header connection with a separate angular path.'},
  ...['A','B','C','D'].flatMap(loop=>{
    const l=loop.toLowerCase()
    return [
      {preview:`route/hot-leg-${loop}`,routes:[`rcs-hot-leg-${l}`],reason:`Retired unbound loop ${loop} hot-leg illustration superseded by its accepted reactor-to-steam-generator connection.`},
      {preview:`route/cold-leg-${loop}`,routes:[`rcs-cold-leg-${l}`],reason:`Retired unbound loop ${loop} cold-leg illustration superseded by its accepted steam-generator-to-pump connection.`},
      {preview:`route/rcp-return-${loop}`,routes:[`rcp-${l}-to-core`],reason:`Retired unbound loop ${loop} reactor-coolant-pump return illustration superseded by its accepted pump-to-reactor connection.`},
      {preview:`route/steam-riser-${loop}`,routes:[`sg-${l}-steam-to-msiv-${l}`,`msiv-${l}-to-main-steam-header`],reason:`Retired unbound loop ${loop} steam illustration superseded by accepted connections through its graph-owned isolation valve.`},
      {preview:`route/feedwater-${loop}`,routes:[`feedwater-header-to-control-valve-${l}`,`feedwater-control-valve-${l}-to-sg-${l}`],reason:`Retired unbound loop ${loop} feedwater illustration superseded by accepted connections through its graph-owned control valve.`},
    ]
  }),
  {preview:'route/pressurizer-surge',routes:['pressurizer-surge-line'],reason:'Retired unbound pressurizer-surge illustration superseded by its accepted reactor-to-pressurizer connection.'},
  {preview:'route/cooling-water-supply',routes:['ultimate-heat-sink-to-circulating-water-pump','circulating-water-pump-to-condenser'],reason:'Retired unbound cooling-water supply illustration superseded by accepted source-to-pump-to-condenser connections.'},
  {preview:'route/cooling-water-return',routes:['condenser-to-cooling-water-discharge'],reason:'Retired unbound cooling-water return illustration superseded by its accepted condenser-to-discharge connection.'},
]

/** Retire superseded preview paths without extending free ends, bypassing valves
 * or adding renderer-specific visibility rules. The installed
 * brown reheat header and all graph-bound occurrences retain their identities. */
export const createPwrConnectedUnitArtifacts=()=>{
  const source=physicalSourceSchema.parse(structuredClone(unitSource))
  const bindings=physicalCorrespondenceSchema.array().parse(structuredClone(unitBindings))
  const coverage=physicalCoverageEvidenceSchema.parse(structuredClone(unitCoverage))
  for(const {preview,routes,reason} of pwrSupersededRoutePreviews){
    const element=source.elements.find(element=>element.id===preview)
    if(!element||element.kind!=='pipe'||element.disposition!=='installed')throw Error(`Missing installed illustrative preview: ${preview}`)
    if(bindings.some(binding=>binding.physicalElementId===preview))throw Error(`A graph-bound occurrence cannot be retired as a preview: ${preview}`)
    for(const graphConnectionId of routes){
      const replacement=source.routing?.connections.find(connection=>connection.graphConnectionId===graphConnectionId)
      if(!replacement?.solution||!bindings.some(binding=>binding.physicalElementId===replacement.id&&binding.elementId===graphConnectionId&&binding.relation==='represents'))throw Error(`Preview retirement requires an accepted graph-bound replacement: ${graphConnectionId}`)
    }
    const context=coverage.contextElements.find(entry=>entry.physicalElementId===preview)
    if(!context)throw Error(`Preview retirement has no retained context identity: ${preview}`)
    element.disposition='removed'
    context.reason=`${reason} Replaced by accepted, exact-port graph connections: ${routes.join(', ')}. Its source identity is retained as removed; it carries no operational or live-state claim.`
  }
  source.evidence.origin+=' Connected-layout revision authored 27 October 2026 retires explicitly superseded unbound utility preview paths; the complete accepted graph/terminal routing network, bound headers and turbine subassembly remain unchanged.'
  return {source:physicalSourceSchema.parse(source),bindings,coverage}
}

export const createPwrConnectedCampusArtifacts=()=>{
  const source=physicalSourceSchema.parse(structuredClone(campusSource))
  const bindings=physicalCorrespondenceSchema.array().parse(structuredClone(campusBindings))
  const coverage=physicalCoverageEvidenceSchema.parse(structuredClone(campusCoverage))
  const unit=createPwrConnectedUnitArtifacts()
  const scene=compilePhysicalScene('authoring-dependency',{...unit,design:{digest:'authoring'},owner:{objectId:'authoring'},placement:{anchor:[0,0],bearing:0},bounds:{min:[-1e9,-1e9,-1e9],max:[1e9,1e9,1e9]}})
  const physicalSourceDigest=hash(physicalSourceFacts(unit.source)),physicalShapeDigest=hash(physicalSceneShapeFacts(scene.objects))
  if(!source.sourceDependencies?.length)throw Error('Campus connection revision needs its authored member source dependencies')
  source.sourceDependencies=source.sourceDependencies.map(witness=>{
    if(witness.sourceId!==unit.source.id)throw Error(`Unexpected campus source dependency: ${witness.sourceId}`)
    return {...witness,physicalSourceDigest,physicalShapeDigest}
  })
  source.evidence.origin+=' Connected-layout revision authored 27 October 2026 retains campus geometry and revalidates its unit source and compiled-shape dependencies against the connected unit revision.'
  return {source:physicalSourceSchema.parse(source),bindings,coverage}
}
