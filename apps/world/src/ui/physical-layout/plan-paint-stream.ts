import type { PhysicalPlanPrimitive, PhysicalSceneObject } from '../../core/packs/scene.ts'
type Geometry = Exclude<PhysicalPlanPrimitive, { kind: 'text' }>
type Bounds = PhysicalPlanPrimitive['bounds']
export type PhysicalPlanPaint = { readonly kind: 'text'; readonly primitive: Extract<PhysicalPlanPrimitive, { kind: 'text' }> } | {
  readonly kind: 'geometry'; readonly paint: Geometry; readonly path: Path2D; readonly bounds: Bounds
  readonly occurrenceId?: string; readonly clip: boolean; readonly dashKey: string
}
/** Retain command preparation without merging native paths. Even disjoint world
 * strokes can contribute coverage to the same device pixel, and a combined
 * Path2D changes that coverage's source-over antialiasing. Preserve each original
 * fill/stroke submission and painter order at every scale. */
export const compilePhysicalPlanPaint = (primitives: ReadonlyArray<PhysicalPlanPrimitive>, objects: ReadonlyMap<string, PhysicalSceneObject>, pathFor: (primitive: Geometry) => Path2D): ReadonlyArray<PhysicalPlanPaint> => {
  const output: PhysicalPlanPaint[] = []
  for (const primitive of primitives) {
    if (primitive.kind === 'text') { output.push({ kind: 'text', primitive }); continue }
    const object = primitive.occurrenceId ? objects.get(primitive.occurrenceId) : undefined
    const occurrenceId = object && (object.subjectIds.length || object.clipToScope) ? object.id : undefined, clipping = object?.clipToScope === true
    output.push({ kind: 'geometry', paint: primitive, path: pathFor(primitive), bounds: primitive.bounds, ...(occurrenceId ? { occurrenceId } : {}), clip: clipping, dashKey: JSON.stringify(primitive.dash ?? []) })
  }
  return output
}
