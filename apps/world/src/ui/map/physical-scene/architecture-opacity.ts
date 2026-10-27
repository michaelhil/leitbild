import type { PhysicalSceneObject } from '../../../core/packs/scene.ts'
import type { PhysicalSceneView } from './types.ts'

/** Geometry kinds are declared by the source; names, colours and dimensions
 * never decide whether equipment becomes transparent. */
export const physicalArchitectureOpacity = (object: Pick<PhysicalSceneObject, 'kind'>, view: Pick<PhysicalSceneView, 'wallOpacity' | 'floorOpacity'>): number =>
  object.kind === 'wall' ? view.wallOpacity ?? 1 : object.kind === 'slab' ? view.floorOpacity ?? 1 : 1
