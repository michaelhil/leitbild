import type { PhysicalMesh } from './geometry.ts'
import earcut from 'earcut'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor, PhysicalSceneObject } from '../../../core/packs/scene.ts'
import { physicalScopeMembers } from './scopes.ts'

/** Source-authored context shared by the dedicated host; it invents no equipment. */
export const createPhysicalOverviewScene = (descriptor: PackPhysicalSceneDescriptor): PackPhysicalScene => {
  const objects: PhysicalSceneObject[] = (descriptor.overviewFootprints ?? []).map(footprint => {
    const ring = footprint.ring.slice(0, -1), positions: number[] = [], feature: number[] = []
    const top = footprint.base + footprint.height, triangles = earcut(ring.flat(), undefined, 2)
    for (const at of triangles) positions.push(...ring[at]!, top)
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length]!
      positions.push(...a, footprint.base, ...b, footprint.base, ...b, top, ...a, footprint.base, ...b, top, ...a, top)
      feature.push(...a, top, ...b, top, ...a, footprint.base, ...a, top)
    })
    return { id: footprint.id, label: footprint.label, kind: 'context', levelId: 'site', subjectIds: [], ...(footprint.scopeId ? { scopeIds: [footprint.scopeId] } : {}), positions, edgePolicy: 'authored', featureLines: [{ positions: feature }], material: 'context' }
  })
  return { id: descriptor.id, revision: descriptor.revision, targetObjectId: descriptor.targetObjectId, anchor: descriptor.anchor, bearing: descriptor.bearing, bounds: descriptor.bounds, levels: descriptor.levels, ...(descriptor.scopes ? { scopes: descriptor.scopes } : {}), objects }
}

/** A focused building keeps its siblings as context without covering its own interior. */
export const physicalOverviewContextMeshes = (descriptor: PackPhysicalSceneDescriptor, meshes: ReadonlyArray<PhysicalMesh>, scopeId: string): ReadonlyArray<PhysicalMesh> => {
  const scopes = new Map((descriptor.scopes ?? []).map(scope => [scope.id, scope]))
  if (scopes.get(scopeId)?.kind === 'area') {
    const members = physicalScopeMembers(descriptor.scopes ?? [], scopeId)
    return meshes.filter(mesh => !mesh.object.scopeIds?.some(id => members.has(id)))
  }
  let current: string | undefined = scopeId, building: string | undefined
  while (current !== undefined) { const scope = scopes.get(current); if (scope?.kind === 'building') { building = scope.id; break }; current = scope?.parentId }
  if (building === undefined) return []
  return meshes.filter(mesh => mesh.object.scopeIds?.some(id => id !== building))
}
