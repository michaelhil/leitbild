import type { PackPhysicalScene, PhysicalSceneBounds, PhysicalSceneObject, PhysicalPlanAnnotation, PhysicalPlanPrimitive } from '../../../../core/packs/scene.ts'

type V3 = [number, number, number]
type V2 = [number, number]
const point = ([x, y, z]: readonly number[]): V3 => [x!, -y!, z!]
const bounds = (value: PhysicalSceneBounds): PhysicalSceneBounds => ({ min: [value.min[0], -value.max[1], value.min[2]], max: [value.max[0], -value.min[1], value.max[2]] })
const drawingBounds = (value: { readonly min: readonly [number, number]; readonly max: readonly [number, number] }) => ({ min: [value.min[0], -value.max[1]] as V2, max: [value.max[0], -value.min[1]] as V2 })
const coordinates = (values: ArrayLike<number>): number[] => Array.from(values, (value, index) => index % 3 === 1 ? -value : value)
const reverseTriangles = (values: number[], stride: number): number[] => {
  for (let i = 0; i < values.length; i += stride * 3) for (let offset = 0; offset < stride; offset++) { const value = values[i + stride + offset]!; values[i + stride + offset] = values[i + stride * 2 + offset]!; values[i + stride * 2 + offset] = value }
  return values
}
const object = (value: PhysicalSceneObject): PhysicalSceneObject => ({ ...value,
  positions: value.indices ? coordinates(value.positions) : reverseTriangles(coordinates(value.positions), 3),
  ...(value.indices ? { indices: reverseTriangles(Array.from(value.indices), 1) } : {}),
  ...(value.normals ? { normals: value.indices ? coordinates(value.normals) : reverseTriangles(coordinates(value.normals), 3) } : {}),
  ...(value.materialIndices && !value.indices ? { materialIndices: reverseTriangles(Array.from(value.materialIndices), 1) } : {}),
  ...(value.bounds ? { bounds: bounds(value.bounds) } : {}),
  ...(value.featureLines ? { featureLines: value.featureLines.map(line => ({ ...line, positions: coordinates(line.positions) })) } : {}),
  ...(value.planLines ? { planLines: value.planLines.map(line => ({ ...line, positions: coordinates(line.positions) })) } : {}),
  ...(value.inspectionBoundary ? { inspectionBoundary: { outward: [value.inspectionBoundary.outward[0], -value.inspectionBoundary.outward[1], 0] as [number, number, 0] } } : {}),
})
const annotation = (value: PhysicalPlanAnnotation): PhysicalPlanAnnotation => value.kind === 'label' ? { ...value, anchor: point(value.anchor), rotation: -value.rotation }
  : value.kind === 'dimension' ? { ...value, from: point(value.from), to: point(value.to), offset: point(value.offset) }
  : { ...value, outline: value.outline.map(point) }
const primitive = (value: PhysicalPlanPrimitive): PhysicalPlanPrimitive => {
  const common = { ...value, bounds: drawingBounds(value.bounds) }
  if (value.kind === 'text') return { ...value, ...common, kind: 'text', anchor: [value.anchor[0], -value.anchor[1]], rotation: -value.rotation } as PhysicalPlanPrimitive
  const hatch = value.hatch ? { hatch: { ...value.hatch, angle: -value.hatch.angle } } : {}
  if (value.kind === 'ellipse') return { ...value, ...common, ...hatch, kind: 'ellipse', center: [value.center[0], -value.center[1]], rotation: -value.rotation } as PhysicalPlanPrimitive
  return { ...value, ...common, ...hatch, kind: 'path', commands: value.commands.map(command => command.map((entry, index) => index !== 0 && index % 2 === 0 ? -(entry as number) : entry) as typeof command) } as PhysicalPlanPrimitive
}
/** Authored plan coordinates may increase down a sheet. Delivery is ALWAYS
 * right-handed local east/north/up. This is a physical frame transformation,
 * performed once, not a reflected camera or a renderer special case. */
export const normalizePhysicalDraftingScene = (scene: PackPhysicalScene, northAxis: 'positive-y' | 'negative-y'): PackPhysicalScene => northAxis === 'positive-y' ? scene : ({ ...scene,
  bounds: bounds(scene.bounds), objects: scene.objects.map(object),
  ...(scene.scopes ? { scopes: scene.scopes.map(scope => ({ ...scope, bounds: bounds(scope.bounds), ...(scope.inspectionView ? { inspectionView: { ...scope.inspectionView, bearing: ((180 - scope.inspectionView.bearing) % 360 + 360) % 360, ...(scope.inspectionView.target ? { target: point(scope.inspectionView.target) } : {}) } } : {}) })) } : {}),
  ...(scene.planAnnotations ? { planAnnotations: scene.planAnnotations.map(annotation) } : {}),
  ...(scene.planDrawing ? { planDrawing: { views: scene.planDrawing.views.map(view => ({ ...view, bounds: drawingBounds(view.bounds), primitives: view.primitives.map(primitive) })) } } : {}),
})

/** The same involution converts an admitted delivery envelope into the authoring
 * frame before the final single normalization. */
export const physicalDraftingAuthoringBounds = (value: PhysicalSceneBounds, northAxis: 'positive-y' | 'negative-y'): PhysicalSceneBounds => northAxis === 'negative-y' ? bounds(value) : value
