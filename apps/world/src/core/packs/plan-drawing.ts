import { z } from 'zod'

const id = z.string().min(1).max(200)
const point = z.tuple([z.number().finite(), z.number().finite()])
export const physicalPlanBoundsSchema = z.object({ min: point, max: point }).strict()
  .refine(value => value.min.every((coordinate, axis) => coordinate <= value.max[axis]!), 'Drawing bounds must be ordered')
const command = z.union([
  z.tuple([z.literal('M'), z.number().finite(), z.number().finite()]),
  z.tuple([z.literal('L'), z.number().finite(), z.number().finite()]),
  z.tuple([z.literal('Q'), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  z.tuple([z.literal('C'), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  z.tuple([z.literal('Z')]),
])
const membership = {
  id, bounds: physicalPlanBoundsSchema, scopeIds: z.array(id).min(1), occurrenceId: id.optional(), layerId: id.optional(),
  depiction: z.enum(['section', 'projection', 'above', 'below', 'annotation', 'allowance']),
}
const paint = {
  fill: id.optional(), stroke: id.optional(), width: z.number().positive().finite().optional(),
  dash: z.array(z.number().positive().finite()).min(1).optional(), opacity: z.number().finite().min(0).max(1).optional(),
  fillRule: z.enum(['nonzero', 'evenodd']).optional(),
  hatch: z.object({ material: id, spacing: z.number().positive().finite(), width: z.number().positive().finite(), angle: z.number().finite() }).strict().optional(),
}
/** Native vector drawing in scene-local XY metres. Ordered primitives express
 * architectural composition, independently of solid geometry and live state. */
export const physicalPlanPrimitiveSchema = z.discriminatedUnion('kind', [
  z.object({ ...membership, ...paint, kind: z.literal('path'), commands: z.array(command).min(1) }).strict()
    .refine(value => value.commands[0]![0] === 'M', 'A drawing path must start with a move'),
  z.object({ ...membership, ...paint, kind: z.literal('ellipse'), center: point, radii: z.tuple([z.number().positive().finite(), z.number().positive().finite()]), rotation: z.number().finite() }).strict(),
  z.object({ ...membership, kind: z.literal('text'), anchor: point, text: z.string().min(1).max(1000), height: z.number().positive().finite(), rotation: z.number().finite(), align: z.enum(['start', 'middle', 'end']), material: id, halo: id.optional(), haloWidth: z.number().positive().finite().optional() }).strict(),
])
export const physicalPlanDrawingSchema = z.object({
  views: z.array(z.object({ levelId: id, bounds: physicalPlanBoundsSchema, primitives: z.array(physicalPlanPrimitiveSchema) }).strict()).min(1),
}).strict().superRefine((drawing, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message })
  if (new Set(drawing.views.map(view => view.levelId)).size !== drawing.views.length) issue('Drawing floor IDs must be unique')
  for (const view of drawing.views) {
    if (new Set(view.primitives.map(primitive => primitive.id)).size !== view.primitives.length) issue(`Drawing primitive IDs must be unique within a floor: ${view.levelId}`)
    for (const primitive of view.primitives) {
      if (primitive.bounds.min.some((coordinate, axis) => coordinate < view.bounds.min[axis]!) || primitive.bounds.max.some((coordinate, axis) => coordinate > view.bounds.max[axis]!)) issue(`Primitive outside drawing bounds: ${primitive.id}`)
      if (new Set(primitive.scopeIds).size !== primitive.scopeIds.length) issue(`Duplicate drawing scope: ${primitive.id}`)
    }
  }
})
export type PhysicalPlanPrimitive = z.infer<typeof physicalPlanPrimitiveSchema>
export type PhysicalPlanDrawing = z.infer<typeof physicalPlanDrawingSchema>
