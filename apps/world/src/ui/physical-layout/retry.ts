import type { PhysicalScenePresentation } from '../map/physical-scene/types.ts'

/** Retry only failures in the current area; a missing optional layer does not
 * turn its still-valid base geometry into a failed source. */
export const retryablePhysicalLayouts = (scenes: ReadonlyArray<PhysicalScenePresentation>, focusedId: string | null, groupId: string | null): ReadonlyArray<string> => scenes
  .filter(scene => focusedId !== null ? scene.descriptor.id === focusedId : groupId === null || scene.descriptor.group?.id === groupId)
  .filter(scene => scene.status === 'unavailable' || scene.layerPreparation?.status === 'unavailable' || scene.opacityPreparation?.status === 'unavailable')
  .map(scene => scene.descriptor.id)
