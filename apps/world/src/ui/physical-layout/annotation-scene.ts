import type { PhysicalScenePresentation } from '../map/physical-scene/types.ts'

/** Occlusion changes at invisible/fractional/opaque boundaries, not every alpha edit. */
const opacityClass = (value: number | undefined): number => value === 0 ? 0 : (value ?? 1) === 1 ? 2 : 1

/**
 * Local attention geometry identity. Pending UI intent, failure wording and colour
 * magnitude do not move anchors or change which surfaces can occlude them. A
 * replaced descriptor is a new source even when its external revision is reused.
 * Weak source tokens retain no visited layout or geometry.
 */
export const createPhysicalAnnotationSceneKey = (): ((scenes: ReadonlyArray<PhysicalScenePresentation>) => string) => {
  const descriptors = new WeakMap<PhysicalScenePresentation['descriptor'], number>()
  let nextDescriptor = 0
  return scenes => JSON.stringify(scenes.map(scene => {
    let source = descriptors.get(scene.descriptor)
    if (source === undefined) { source = ++nextDescriptor; descriptors.set(scene.descriptor, source) }
    const view = scene.view
    return [source, scene.status, scene.renderRevision, view.mode, view.levelId, view.cutaway, view.separation, view.detail, view.live, view.surroundings, view.hiddenLayerIds,
      opacityClass(view.wallOpacity), opacityClass(view.floorOpacity)]
  }))
}
