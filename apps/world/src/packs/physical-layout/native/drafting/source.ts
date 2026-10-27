import { z } from 'zod'
import { physicalSourceSchema as architectureSchema, physicalSourceFacts as architectureFacts } from '../architecture/source.ts'
import { physicalRoutingSchema } from '../routing/source.ts'
export { architectureLayers, parameters, elementWorld, type V3 } from '../architecture/source.ts'
const id=z.string().min(1).max(200), point=z.tuple([z.number().finite(),z.number().finite()])
const axis=z.object({id,label:z.string().min(1),axis:z.enum(['x','y']),elementId:id,fraction:z.number().finite().min(0).max(1)}).strict()
const grid=z.object({id,buildingId:id,spaceId:id,levelIds:z.array(id).min(1),axes:z.array(axis).min(1),bubbleOffset:z.number().positive(),dimensionOffset:z.number().positive(),overallOffset:z.number().positive()}).strict()
const intent=z.object({dimensionUnit:z.enum(['m','mm']),floorJoints:z.array(z.object({elementId:id,spacing:point}).strict()),grids:z.array(grid),contexts:z.array(z.object({elementId:id,levelIds:z.array(id).min(1),depiction:z.enum(['above','below','projection'])}).strict()),projectedOpenings:z.array(z.object({elementId:id,levelIds:z.array(id).min(1)}).strict()),strokes:z.array(z.object({elementId:id,levelIds:z.array(id).min(1),width:z.number().positive(),material:id}).strict()),labelPositions:z.array(z.object({annotationId:id,anchor:point.optional(),height:z.number().finite().positive().optional()}).strict())}).strict()
const positive=z.number().finite().positive()
const foundation=z.object({offset:point,length:positive,width:positive,height:positive,holes:z.array(z.object({x:z.number().finite().nonnegative(),y:z.number().finite().nonnegative(),length:positive,width:positive}).strict()).optional()}).strict()
/** R4 adds an explicit drafting authority. The published architecture compiler
 * and source remain frozen and independently resolvable. */
export const physicalSourceSchema=architectureSchema.safeExtend({northAxis:z.enum(['positive-y','negative-y']),elements:z.array(architectureSchema.shape.elements.element.extend({foundation:foundation.optional(),planTag:z.string().min(1).max(200).optional(),planSymbol:z.enum(['bearing','hatch']).optional()})),planIntent:intent.optional(),routing:physicalRoutingSchema.optional()}).superRefine((source,context)=>{
 const elements=new Map(source.elements.map(e=>[e.id,e])),levels=new Set(source.levels.map(l=>l.id)),issue=(message:string)=>context.addIssue({code:'custom',message})
 for(const floor of source.planIntent?.floorJoints??[]){if(elements.get(floor.elementId)?.kind!=='slab'||floor.spacing.some(v=>v<=0))issue(`Floor joints need a slab and positive physical spacing: ${floor.elementId}`)}
 for(const grid of source.planIntent?.grids??[]){if(elements.get(grid.buildingId)?.kind!=='building'||elements.get(grid.spaceId)?.kind!=='space'||grid.levelIds.some(id=>!levels.has(id))||grid.axes.some(axis=>!elements.has(axis.elementId))||new Set(grid.axes.map(a=>a.id)).size!==grid.axes.length)issue(`Invalid source-derived structural grid: ${grid.id}`)}
 for(const item of source.planIntent?.contexts??[])if(!elements.has(item.elementId)||item.levelIds.some(id=>!levels.has(id)))issue(`Unknown contextual drawing authority: ${item.elementId}`)
 for(const item of source.planIntent?.projectedOpenings??[])if(elements.get(item.elementId)?.kind!=='opening'||item.levelIds.some(id=>!levels.has(id)))issue(`Unknown projected opening authority: ${item.elementId}`)
 for(const item of source.planIntent?.labelPositions??[])if(!source.planAnnotations?.some(a=>a.id===item.annotationId))issue(`Unknown drawing label authority: ${item.annotationId}`)
 for(const item of source.planIntent?.strokes??[])if(!elements.has(item.elementId)||item.levelIds.some(id=>!levels.has(id)))issue(`Unknown authored stroke authority: ${item.elementId}`)
 for(const element of source.elements)if(element.foundation){const f=element.foundation,holes=f.holes??[];if(element.kind!=='equipment'||holes.some(h=>h.x<=0||h.y<=0||h.x+h.length>=f.length||h.y+h.width>=f.width)||holes.some((a,i)=>holes.slice(i+1).some(b=>a.x<=b.x+b.length&&a.x+a.length>=b.x&&a.y<=b.y+b.width&&a.y+a.width>=b.y)))issue(`A machinery foundation requires separate strictly interior voids: ${element.id}`)}
 if(source.routing){
  const layers=new Set(source.layers?.map(layer=>layer.id)),identities=new Set([...source.elements,...source.types,...source.levels].map(value=>value.id))
  for(const terminal of source.routing.terminals)if(!elements.has(terminal.elementId)||elements.get(terminal.elementId)!.disposition==='removed')issue(`Routing terminal has no installed source occurrence: ${terminal.id}`)
  for(const connection of source.routing.connections)if(identities.has(connection.id)||!layers.has(connection.layerId))issue(`Routing connection identity/layer conflicts with its source: ${connection.id}`)
  for(const obstacle of source.routing.obstacleElementIds)if(!elements.has(obstacle)||['building','space','assembly','opening'].includes(elements.get(obstacle)!.kind))issue(`A routing obstacle must reference actual physical geometry: ${obstacle}`)
 }
})
export type Source=z.infer<typeof physicalSourceSchema>
export type Element=Source['elements'][number]
/** Drawing recipes and tags change exact representation identity, not physical applicability. */
export const physicalSourceFacts=(source:Source):unknown=>{
 const {planIntent:_intent,...physical}=source
 return architectureFacts({...physical,elements:physical.elements.map(({planTag:_tag,planSymbol:_symbol,...element})=>element)})
}
