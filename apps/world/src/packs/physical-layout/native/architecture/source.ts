import { z } from 'zod'
import { physicalSourceSchema as explorerSourceSchema } from '../explorer/source.ts'
export { parameters, elementWorld, type Parameters, type V3 } from '../explorer/source.ts'

const id = z.string().min(1).max(200)
const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
const anchor = z.object({ elementId: id, local: vector }).strict()
const layer = z.object({ id, label: z.string().min(1).max(200), defaultVisible: z.boolean() }).strict()
export const architectureLayers = [
  { id: 'utility-routes', label: 'Utility routes', defaultVisible: false },
  { id: 'roof-structure', label: 'Roof structure', defaultVisible: false },
  { id: 'plan-labels', label: 'Plan labels', defaultVisible: true },
  { id: 'plan-dimensions', label: 'Dimensions', defaultVisible: true },
  { id: 'plan-allowances', label: 'Illustrative work areas', defaultVisible: false },
]
const inspectionView = z.object({ bearing: z.number().finite(), pitch: z.number().finite().min(0).lt(90), target: vector.optional() }).strict()
const membership = { id, levelIds: z.array(id).min(1), scopeIds: z.array(id).min(1), occurrenceId: id.optional(), layerId: id.optional() }
const annotationSchema = z.discriminatedUnion('kind', [
  z.object({ ...membership, kind: z.literal('label'), role: z.enum(['space', 'equipment', 'note']), text: z.string().min(1).max(1000).optional(), anchor, rotation: z.number().finite() }).strict(),
  z.object({ ...membership, kind: z.literal('dimension'), measure: z.object({ elementId: id, axis: z.enum(['length', 'width', 'height']), start: vector }).strict(), offset: vector, unit: z.literal('m') }).strict(),
  z.object({ ...membership, kind: z.literal('hatch'), role: z.enum(['laydown', 'access', 'withdrawal']), outline: z.array(vector).min(4), label: z.string().min(1).max(1000), basis: z.literal('illustrative') }).strict(),
])
const memberSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('i-section'), axis: z.enum(['x', 'y', 'z']), flange: z.number().positive().finite(), web: z.number().positive().finite() }).strict(),
  z.object({ kind: z.literal('tube'), points: z.array(vector).min(2), radius: z.number().positive().finite() }).strict(),
  z.object({ kind: z.literal('guardrail'), points: z.array(vector).min(2), height: z.number().positive().finite(), postSpacing: z.number().positive().finite(), railRadius: z.number().positive().finite(), postRadius: z.number().positive().finite() }).strict(),
  z.object({ kind: z.literal('transition'), topLength: z.number().positive().finite(), topWidth: z.number().positive().finite() }).strict(),
])
const elementSchema = explorerSourceSchema.shape.elements.element.extend({
  planDisplay: z.enum(['section', 'projection']).optional(),
  layerId: id.optional(),
  /** Intentional cover-panel joints, drawn at the exact source-derived top face. */
  surfaceJoints: z.object({ axis: z.enum(['length', 'width']), offsets: z.array(z.number().finite().positive()).min(1) }).strict().optional(),
  member: memberSchema.optional(),
  inspectionBoundary: z.object({ outward: z.tuple([z.number().finite(), z.number().finite(), z.literal(0)]) }).strict().optional(),
  inspectionLevels: z.array(z.object({ levelId: id, low: z.number().finite(), high: z.number().finite() }).strict()).min(1).optional(),
})
/** A new retained compiler profile. The explorer source/recipe closure remains frozen. */
export const physicalSourceSchema = explorerSourceSchema.safeExtend({ elements: z.array(elementSchema), planAnnotations: z.array(annotationSchema).optional(), layers: z.array(layer).optional(),
  viewAreas: z.array(z.object({ id, label: z.string().min(1).max(300), members: z.array(id).min(1), inspectionView: inspectionView.optional() }).strict()).optional(),
}).superRefine((source, context) => {
  const issue = (message: string): void => context.addIssue({ code: 'custom', message })
  const elements = new Map(source.elements.map(element => [element.id, element]))
  const levels = new Set([...source.levels.map(level => level.id), 'site'])
  const scopes = new Set([source.rootScope.id, ...source.elements.filter(element => ['building', 'space', 'assembly'].includes(element.kind)).map(element => element.id)])
  const layers = new Set((source.layers ?? architectureLayers).map(layer => layer.id))
  if (layers.size !== (source.layers ?? architectureLayers).length) issue('Representation layer IDs must be unique')
  const physicalIds = new Set([...source.levels, ...source.types, ...source.elements].map(value => value.id))
  const areas = new Set<string>()
  for (const area of source.viewAreas ?? []) {
    if (areas.has(area.id) || physicalIds.has(area.id) || area.id === source.rootScope.id) issue(`View area must have a distinct identity: ${area.id}`)
    areas.add(area.id)
    if (new Set(area.members).size !== area.members.length || area.members.some(id => !scopes.has(id))) issue(`View areas reference unique existing non-area scopes: ${area.id}`)
  }
  let memberCoordinates = 0
  for (const element of source.elements) {
    const member = element.member
    if (element.layerId !== undefined && !layers.has(element.layerId)) issue(`Unknown representation layer: ${element.id}`)
    if (element.surfaceJoints) {
      const dimensions = { ...(source.types.find(type => type.id === element.typeId)?.parameters ?? element.dimensions), ...element.override }
      if (!['slab', 'roof'].includes(element.kind) || element.shape || element.holes?.length || new Set(element.surfaceJoints.offsets).size !== element.surfaceJoints.offsets.length || element.surfaceJoints.offsets.some(offset => offset >= dimensions[element.surfaceJoints!.axis]!)) issue(`Panel joints require distinct offsets inside a plain rectangular plate: ${element.id}`)
      memberCoordinates += element.surfaceJoints.offsets.length * 6
    }
    if (member && !['support', 'context'].includes(element.kind)) issue(`A structural member needs a support or context occurrence: ${element.id}`)
    if (member?.kind === 'i-section') {
      const dimensions = { ...(source.types.find(type => type.id === element.typeId)?.parameters ?? element.dimensions), ...element.override }
      const section = member.axis === 'z' ? [dimensions.length!, dimensions.width!] : member.axis === 'x' ? [dimensions.width!, dimensions.height!] : [dimensions.length!, dimensions.height!]
      if (member.web >= section[0]! || member.flange * 2 >= section[1]!) issue(`I-section thickness consumes its section: ${element.id}`)
    }
    if ((member?.kind === 'tube' || member?.kind === 'guardrail') && member.points.some((point, index) => index > 0 && point.every((value, axis) => value === member.points[index - 1]![axis]))) issue(`A structural member has a zero-length segment: ${element.id}`)
    if (member?.kind === 'tube') memberCoordinates += (member.points.length - 1) * 12 * 4 * 9
    if (member?.kind === 'guardrail') for (let index = 0; index < member.points.length - 1; index++) {
      const a = member.points[index]!, b = member.points[index + 1]!, distance = Math.hypot(b[0] - a[0], b[1] - a[1]), posts = Math.ceil(distance / member.postSpacing)
      if (distance === 0) issue(`A guardrail needs a horizontal run: ${element.id}`)
      memberCoordinates += 12 * 4 * 9 + (posts + 1) * 8 * 4 * 9
    }
    if (element.inspectionBoundary && Math.abs(Math.hypot(...element.inspectionBoundary.outward) - 1) > Number.EPSILON * 8) issue(`An enclosure boundary requires a unit outward normal: ${element.id}`)
    if (element.inspectionLevels) {
      if (!['building', 'space'].includes(element.kind)) issue(`Only an authored enclosure owns inspection floor volumes: ${element.id}`)
      if (new Set(element.inspectionLevels.map(value => value.levelId)).size !== element.inspectionLevels.length || element.inspectionLevels.some(value => !levels.has(value.levelId) || value.high <= value.low)) issue(`Invalid inspection floor volumes: ${element.id}`)
    }
  }
  // Preflight procedural replication against the existing scene transport
  // coordinate budget, before generating a potentially enormous post array.
  if (!Number.isSafeInteger(memberCoordinates) || memberCoordinates > 6_000_000) issue('Structural member recipes exceed the existing scene coordinate delivery budget')
  if (new Set((source.planAnnotations ?? []).map(annotation => annotation.id)).size !== (source.planAnnotations?.length ?? 0)) issue('Plan annotation IDs must be unique')
  for (const annotation of source.planAnnotations ?? []) {
    if (new Set(annotation.levelIds).size !== annotation.levelIds.length || annotation.levelIds.some(id => !levels.has(id))) issue(`Unknown annotation level: ${annotation.id}`)
    if (new Set(annotation.scopeIds).size !== annotation.scopeIds.length || annotation.scopeIds.some(id => !scopes.has(id) && !areas.has(id))) issue(`Unknown annotation scope: ${annotation.id}`)
    if (annotation.occurrenceId && !elements.has(annotation.occurrenceId)) issue(`Unknown annotation occurrence: ${annotation.id}`)
    if (annotation.layerId !== undefined && !layers.has(annotation.layerId)) issue(`Unknown annotation layer: ${annotation.id}`)
    if (annotation.kind === 'label' && !elements.has(annotation.anchor.elementId)) issue(`Unknown annotation anchor: ${annotation.id}`)
    if (annotation.kind === 'dimension' && !elements.has(annotation.measure.elementId)) issue(`Unknown dimension authority: ${annotation.id}`)
    if (annotation.kind === 'hatch') {
      const first = annotation.outline[0]!, last = annotation.outline.at(-1)!
      if (!first.every((value, axis) => value === last[axis]) || annotation.outline.some(point => point[2] !== first[2])) issue(`Hatch must be a closed XY polygon: ${annotation.id}`)
      if (annotation.outline.slice(0, -1).reduce((sum, point, index) => { const next = annotation.outline[index + 1]!; return sum + point[0] * next[1] - next[0] * point[1] }, 0) === 0) issue(`Hatch must enclose an area: ${annotation.id}`)
    }
  }
})
export type Source = z.infer<typeof physicalSourceSchema>
export type Element = Source['elements'][number]

/** Presentation annotations never alter physical applicability, but remain Design-pinned. */
export const physicalSourceFacts = (source: Source): unknown => {
  const { planAnnotations: _annotations, viewAreas: _areas, layers: _layers, ...physical } = source
  return stripMaterial(physical)
}
const stripMaterial = (value: unknown): unknown => Array.isArray(value) ? value.map(stripMaterial) : value !== null && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !['material', 'inspectionBoundary', 'planDisplay', 'layerId', 'surfaceJoints'].includes(key)).map(([key, child]) => [key, stripMaterial(child)])) : value
