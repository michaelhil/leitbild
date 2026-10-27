import type { PhysicalPlanPrimitive, PhysicalSceneObject } from '../../core/packs/scene.ts'
type Geometry = Exclude<PhysicalPlanPrimitive, { kind: 'text' }>
type Bounds = PhysicalPlanPrimitive['bounds']
export type PhysicalPlanPaint = { readonly kind: 'text'; readonly primitive: Extract<PhysicalPlanPrimitive, { kind: 'text' }> } | {
  readonly kind: 'geometry'; readonly paint: Geometry; readonly path: Path2D; readonly bounds: Bounds
  readonly occurrenceId?: string; readonly clip: boolean; readonly dashKey: string
}
const styleKeys = new WeakMap<Geometry, string>()
const signature = (p: Geometry) => {
  let value = styleKeys.get(p)
  if (value === undefined) { value = JSON.stringify([p.fill, p.stroke, p.width, p.dash, p.opacity, p.fillRule, p.hatch, p.depiction]); styleKeys.set(p, value) }
  return value
}
const overlaps = (a: Bounds, b: Bounds) => a.min[0] <= b.max[0] && a.max[0] >= b.min[0] && a.min[1] <= b.max[1] && a.max[1] >= b.min[1]
/** Consecutive, identically styled and disjoint opaque paths may share one
 * native submission without changing painter order, overlap or alpha meaning.
 * Bolts and ribs benefit; overlapping fills/hatches remain individual commands. */
export const compilePhysicalPlanPaint = (primitives: ReadonlyArray<PhysicalPlanPrimitive>, objects: ReadonlyMap<string, PhysicalSceneObject>, pathFor: (primitive: Geometry) => Path2D): ReadonlyArray<PhysicalPlanPaint> => {
  const output: PhysicalPlanPaint[] = []
  let pending: Geometry[] = [], key = '', identity: string | undefined, clip = false
  const flush = () => {
    if (!pending.length) return
    const first = pending[0]!, path = pending.length === 1 ? pathFor(first) : new Path2D()
    if (pending.length > 1) for (const p of pending) path.addPath(pathFor(p))
    const bounds: Bounds = { min: [Math.min(...pending.map(p => p.bounds.min[0])), Math.min(...pending.map(p => p.bounds.min[1]))], max: [Math.max(...pending.map(p => p.bounds.max[0])), Math.max(...pending.map(p => p.bounds.max[1]))] }
    output.push({ kind: 'geometry', paint: first, path, bounds, ...(identity ? { occurrenceId: identity } : {}), clip, dashKey: JSON.stringify(first.dash ?? []) }); pending = []
  }
  for (const primitive of primitives) {
    if (primitive.kind === 'text') { flush(); output.push({ kind: 'text', primitive }); continue }
    const object = primitive.occurrenceId ? objects.get(primitive.occurrenceId) : undefined
    const occurrenceId = object && (object.subjectIds.length || object.clipToScope) ? object.id : undefined, clipping = object?.clipToScope === true
    const style = signature(primitive), independent = !primitive.hatch && (primitive.opacity ?? 1) === 1
    if (!independent || key !== style || identity !== occurrenceId || clip !== clipping || pending.some(previous => overlaps(previous.bounds, primitive.bounds))) flush()
    if (!pending.length) { key = style; identity = occurrenceId; clip = clipping }
    pending.push(primitive)
    if (!independent) flush()
  }
  flush(); return output
}
