import { packPhysicalSceneSchema, type PackPhysicalScene, type PhysicalSceneBounds } from '../../../../core/packs/scene.ts'
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
export const compilePhysicalScene = (id: string, data: PhysicalSceneInput): PackPhysicalScene => packPhysicalSceneSchema.parse({
  id, revision: data.design.digest, targetObjectId: data.owner.objectId,
  anchor: data.placement.anchor, bearing: data.placement.bearing, bounds: data.bounds,
  levels: data.source.levels.map(level => ({ ...level, cutHeight: level.elevation + level.cutHeight })),
  layers: [{ id: 'utility-routes', label: 'Utility routes', defaultVisible: false }],
  ...physicalScopeManifest(data.source, compilePhysicalObjects(data)),
})
