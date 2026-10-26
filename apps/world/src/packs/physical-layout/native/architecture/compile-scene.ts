import { packPhysicalSceneSchema, type PackPhysicalScene, type PhysicalSceneBounds, type PhysicalPlanAnnotation } from '../../../../core/packs/scene.ts'
import type { Source } from './source.ts'
import { elementWorld, parameters, type V3 } from './source.ts'
import { solid } from './solid.ts'
import { physicalScopeManifest } from '../../scope-manifest.ts'

export interface PhysicalCompilerInput {
  readonly source: Source
  readonly bindings: ReadonlyArray<{ readonly physicalElementId: string; readonly elementId: string }>
}
export interface PhysicalSceneInput extends PhysicalCompilerInput {
  readonly design: { readonly digest: string }
  readonly owner: { readonly objectId: string }
  readonly placement: { readonly anchor: [number, number]; readonly bearing: number }
  readonly bounds: PhysicalSceneBounds
}

/** Preserve authored features; tessellation cells never become linework. */
export const compilePhysicalObjects = (data: PhysicalCompilerInput): PackPhysicalScene['objects'] => data.source.elements.flatMap(element => {
  const mesh = solid(data.source, element)
  if (!mesh) return []
  const origin = data.source.origin
  const positions = mesh.positions.map((value, index) => value - origin[index % 3]!)
  const linePositions = mesh.linePositions.map((value, index) => value - origin[index % 3]!)
  const featureLines = linePositions.length ? [{ positions: linePositions, material: 'line' }] : []
  const planLines = [...featureLines]
  if (element.kind === 'door') {
    const pose = elementWorld(data.source, element), radius = parameters(data.source, element).length, arc: number[] = []
    const point = (angle: number): V3 => [pose.position[0] + Math.cos(pose.yaw + angle) * radius - origin[0], pose.position[1] + Math.sin(pose.yaw + angle) * radius - origin[1], pose.position[2] + .015 - origin[2]]
    for (let step = 0; step < 24; step++) arc.push(...point(step * (element.door?.swing ?? Math.PI / 2) / 24), ...point((step + 1) * (element.door?.swing ?? Math.PI / 2) / 24))
    planLines.push({ positions: arc, material: 'door' })
  }
  const noEdges = element.kind === 'slab' || element.kind === 'roof' || element.kind === 'pavement' || element.material === 'marking'
  return [{
    id: mesh.id, label: mesh.label, kind: mesh.kind, levelId: mesh.levelId,
    positions, normals: mesh.normals, materials: mesh.materials, materialIndices: mesh.materialIndices,
    subjectIds: data.bindings.filter(binding => binding.physicalElementId === element.id).map(binding => binding.elementId),
    ...(planLines.length && !noEdges ? { planLines } : {}),
    ...(featureLines.length && !noEdges ? { featureLines } : {}),
    edgePolicy: noEdges || !featureLines.length ? 'none' as const : 'authored' as const,
    bounds: { min: mesh.bounds.min.map((value, axis) => value - origin[axis]!) as V3, max: mesh.bounds.max.map((value, axis) => value - origin[axis]!) as V3 },
    scopeIds: [data.source.rootScope.id, element.buildingId, ...(element.spaceIds ?? []), element.assemblyId].filter((id): id is string => id !== undefined),
    ...(element.kind === 'conductor' && element.installation === 'cable-corridor' ? { layerId: 'utility-routes' } : {}),
    ...(element.inspectionBoundary ? { inspectionBoundary: element.inspectionBoundary } : {}),
    ...(element.planDisplay ? { planDisplay: element.planDisplay } : {}),
  }]
})

export const physicalObjectsBounds = (objects: PackPhysicalScene['objects']): PhysicalSceneBounds => {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity]
  for (const object of objects) for (let index = 0; index < object.positions.length; index++) {
    const axis = index % 3
    min[axis] = Math.min(min[axis]!, object.positions[index]!)
    max[axis] = Math.max(max[axis]!, object.positions[index]!)
  }
  if (!min.every(Number.isFinite)) throw new Error('A physical scene requires nonempty geometry')
  return { min, max }
}
export const architectureLayers = [
  { id: 'utility-routes', label: 'Utility routes', defaultVisible: false },
  { id: 'plan-labels', label: 'Plan labels', defaultVisible: true },
  { id: 'plan-dimensions', label: 'Dimensions', defaultVisible: true },
  { id: 'plan-allowances', label: 'Illustrative work areas', defaultVisible: false },
]
/** Resolve annotations from source authorities, never from screen geometry or duplicated dimensions. */
export const compilePlanAnnotations = (source: Source): PhysicalPlanAnnotation[] => {
  const elements = new Map(source.elements.map(element => [element.id, element]))
  const point = (elementId: string, local: V3): V3 => {
    const element = elements.get(elementId)!, pose = elementWorld(source, element), c = Math.cos(pose.yaw), s = Math.sin(pose.yaw)
    return [pose.position[0] + c * local[0] - s * local[1] - source.origin[0], pose.position[1] + s * local[0] + c * local[1] - source.origin[1], pose.position[2] + local[2] - source.origin[2]]
  }
  return (source.planAnnotations ?? []).map(annotation => {
    if (annotation.kind === 'label') {
      const { anchor, text, ...rest } = annotation
      return { ...rest, text: text ?? elements.get(anchor.elementId)!.label, anchor: point(anchor.elementId, anchor.local) }
    }
    if (annotation.kind === 'dimension') {
      const { measure, offset, ...rest } = annotation, element = elements.get(measure.elementId)!, dimensions = parameters(source, element), endpoint: V3 = [...measure.start]
      endpoint[measure.axis === 'length' ? 0 : measure.axis === 'width' ? 1 : 2] += dimensions[measure.axis]
      const pose = elementWorld(source, element), c = Math.cos(pose.yaw), s = Math.sin(pose.yaw)
      return { ...rest, from: point(element.id, measure.start), to: point(element.id, endpoint), offset: [c * offset[0] - s * offset[1], s * offset[0] + c * offset[1], offset[2]] as V3 }
    }
    return { ...annotation, outline: annotation.outline.map(value => value.map((coordinate, axis) => coordinate - source.origin[axis]!) as V3) }
  })
}
const inspectionManifest = (source: Source, input: ReturnType<typeof physicalScopeManifest>): ReturnType<typeof physicalScopeManifest> => {
  const elements = new Map(source.elements.map(element => [element.id, element]))
  return {
    scopes: input.scopes.map(scope => {
      const element = elements.get(scope.id), authored = element?.inspectionLevels
      if (authored) return { ...scope, levelIds: authored.map(value => value.levelId) }
      const inherited = element?.buildingId ? elements.get(element.buildingId)?.inspectionLevels : undefined
      return inherited ? { ...scope, levelIds: inherited.filter(value => scope.bounds.max[2] + source.origin[2] > value.low && scope.bounds.min[2] + source.origin[2] < value.high).map(value => value.levelId) } : scope
    }),
    objects: input.objects.map(object => {
      const element = elements.get(object.id)!
      const spaces = (element.spaceIds ?? []).flatMap(id => elements.get(id)?.inspectionLevels ?? [])
      const authored = spaces.length ? spaces : element.buildingId ? elements.get(element.buildingId)?.inspectionLevels : undefined
      if (!authored?.length) return object
      const volumes = new Map<string, { levelId: string; low: number; high: number }>()
      for (const value of authored) {
        const previous = volumes.get(value.levelId)
        volumes.set(value.levelId, { levelId: value.levelId, low: Math.min(previous?.low ?? Infinity, value.low - source.origin[2]), high: Math.max(previous?.high ?? -Infinity, value.high - source.origin[2]) })
      }
      const inspectionLevels = [...volumes.values()]
      const bounds = object.bounds!
      return { ...object, inspectionLevels, levelIds: inspectionLevels.filter(value => (bounds.max[2] > value.low || (object.levelId === value.levelId && bounds.max[2] === value.low)) && bounds.min[2] < value.high).map(value => value.levelId) }
    }),
  }
}
export const compilePhysicalScene = (id: string, data: PhysicalSceneInput): PackPhysicalScene => packPhysicalSceneSchema.parse({
  id, revision: data.design.digest, targetObjectId: data.owner.objectId,
  anchor: data.placement.anchor, bearing: data.placement.bearing, bounds: data.bounds,
  levels: data.source.levels.map(level => ({ ...level, cutHeight: level.elevation + level.cutHeight })),
  layers: architectureLayers,
  planAnnotations: compilePlanAnnotations(data.source),
  ...inspectionManifest(data.source, physicalScopeManifest(data.source, compilePhysicalObjects(data))),
})
