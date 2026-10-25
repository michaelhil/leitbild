import earcut from 'earcut'
import type { PackPhysicalScene, PackPhysicalSceneDescriptor, PhysicalSceneObject } from '../../../core/packs/scene.ts'

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
    return { id: footprint.id, label: footprint.label, kind: 'context', levelId: 'site', subjectIds: [], positions, edgePolicy: 'authored', featureLines: [{ positions: feature }], material: 'context' }
  })
  return { id: descriptor.id, revision: descriptor.revision, targetObjectId: descriptor.targetObjectId, anchor: descriptor.anchor, bearing: descriptor.bearing, bounds: descriptor.bounds, levels: descriptor.levels, objects }
}
