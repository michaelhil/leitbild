/** Exact geometry admission for the offline seven-group transport contribution.
 * Material response and optical attenuation are supplied at the same trial by
 * their owners. This compiler is not a complete neutron or thermal operator. */
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {sourceRegionSchema} from './reference-design-source-partition'
import type {SourceFace} from './reference-design-source-faces'

const positive=z.number().finite().positive(),finite=z.number().finite(),
 faceSchema=z.object({left:z.string().min(1),right:z.string().min(1).optional(),area_m2:positive,
  leftDistance_m:positive,rightDistance_m:positive.optional(),axis:z.enum(['x','y','z','arc','equipment']),
  plane_m:finite.optional(),meanOutwardNormal:z.tuple([finite,finite,finite]),
  support:z.object({id:z.string().min(1),kind:z.enum(['rack-panel','transfer-gate','head-mouth'])}).strict().optional()}).strict(),
 partitionSchema=z.object({result:z.object({regions:z.array(sourceRegionSchema).min(1)})}),
 receiptSchema=z.object({partitionSHA256:z.string().regex(/^[a-f0-9]{64}$/),
  result:z.object({faces:z.array(faceSchema).min(1)})}),
 bindingSchema=z.object({faceIndex:z.number().int().nonnegative(),supportId:z.string().min(1),
  targetIds:z.array(z.string().min(1)).min(1)}).strict()
export type OpticalBinding=z.infer<typeof bindingSchema>
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')

function readGeometry(partitionText:string,facesText:string,speeds:number[]){
 const p=partitionSchema.parse(JSON.parse(partitionText)),f=receiptSchema.parse(JSON.parse(facesText)),
  speed=z.array(positive).length(7).parse(speeds),regions=p.result.regions,
  indices=new Map(regions.map((r,i)=>[r.id,i])),seen=new Set<string>()
 if(f.partitionSHA256!==sha(partitionText))throw Error('Transport face/partition lineage mismatch')
 if(indices.size!==regions.length)throw Error('Duplicated source region')
 for(const face of f.result.faces){
  if(!indices.has(face.left)||(face.right!==undefined&&!indices.has(face.right))||face.left===face.right)
   throw Error('Unknown/self source face incidence')
  if((face.right===undefined)!==(face.rightDistance_m===undefined))throw Error('Inconsistent exterior/shared distance')
  const key=JSON.stringify(face)
  if(seen.has(key))throw Error('Duplicated source face');seen.add(key)
  // Refuse old geometry that silently made the closed head transparent. This
  // predicate expresses the owned equipment interface, not a material law.
  const left=regions[indices.get(face.left)!]!,right=face.right===undefined?undefined:regions[indices.get(face.right)!],
   head=(left.id==='UPPER'&&right?.compartment==='WELL')||(right?.id==='UPPER'&&left.compartment==='WELL')
  if(head&&(face.support?.kind!=='head-mouth'||face.support.id!=='HEAD.MOUTH'))
   throw Error('Unresolved head-mouth material support')
 }
 return {regions,sourceFaces:f.result.faces as SourceFace[],speed,indices,
  regionVolumes:regions.map(r=>r.volume_m3),envelopeLengths:regions.map(r=>r.envelopeLength_m),
  identities:{regions:regions.map(r=>r.id)},partitionSHA256:f.partitionSHA256}
}
function nativeFace(face:SourceFace,indices:Map<string,number>,targets?:number[]){
 return {left:indices.get(face.left)!,right:face.right===undefined?undefined:indices.get(face.right)!,
  area:face.area_m2,left_distance:face.leftDistance_m,right_distance:face.rightDistance_m,
  law:targets?{kind:'optical' as const,targets}:{kind:face.right===undefined?'escape' as const:'transparent' as const}}
}

/** Every covered patch needs an explicit actual target-layer map. A map says
 * nothing about whether coefficients, heat recipients or birth inputs are ready. */
export function compileTransportGeometry(partitionText:string,facesText:string,speeds:number[],supplied:OpticalBinding[]){
 const g=readGeometry(partitionText,facesText,speeds),bindings=z.array(bindingSchema).parse(supplied),
  byFace=new Map(bindings.map(b=>[b.faceIndex,b])),targets:string[]=[],targetIndex=new Map<string,number>()
 if(byFace.size!==bindings.length)throw Error('Duplicated optical face binding')
 for(const b of bindings){const face=g.sourceFaces[b.faceIndex]
  if(!face?.support||face.support.id!==b.supportId||face.right===undefined)
   throw Error('Unknown/unshared optical support binding')
  for(const id of b.targetIds)if(!targetIndex.has(id)){targetIndex.set(id,targets.length);targets.push(id)}
 }
 const faces=g.sourceFaces.map((face,i)=>{
  const binding=byFace.get(i)
  if(face.support&&!binding)throw Error('Missing optical target layers: '+face.support.id+' face '+i)
  return nativeFace(face,g.indices,binding?.targetIds.map(id=>targetIndex.get(id)!))
 })
 return {regionVolumes:g.regionVolumes,envelopeLengths:g.envelopeLengths,speed:g.speed,faces,
  identities:{...g.identities,targets},partitionSHA256:g.partitionSHA256,
  completeReactorOperator:false,emissionIsDepositedHeat:false,
  scope:'Geometry and explicit layer-target incidence only. Same-trial collision, attenuation, captures, births and thermal deposition remain caller-owned.'}
}

/** Qualification-only additive partial view, NOT an alternative plant model.
 * Covered patches are enumerated exclusions, never transparent substitutes. */
export function partialTransparentTransportGeometry(partitionText:string,facesText:string,speeds:number[]){
 const g=readGeometry(partitionText,facesText,speeds),omitted=g.sourceFaces.flatMap((face,i)=>face.support?
  [{faceIndex:i,supportId:face.support.id,kind:face.support.kind,area_m2:face.area_m2}]:[]),
  faces=g.sourceFaces.filter(face=>!face.support).map(face=>nativeFace(face,g.indices))
 return {regionVolumes:g.regionVolumes,envelopeLengths:g.envelopeLengths,speed:g.speed,faces,
  identities:g.identities,partitionSHA256:g.partitionSHA256,omittedFaces:omitted,
  omittedArea_m2:omitted.reduce((s,f)=>s+f.area_m2,0),completeReactorOperator:false,
  scope:'Nonadvancing algebra check of present fuel/PRIMARY-moderator and transparent/escape contributions only. Covered head/rack/gate faces and absent material inputs are not modelled.'}
}
