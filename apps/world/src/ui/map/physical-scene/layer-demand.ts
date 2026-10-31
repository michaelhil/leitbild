import type { PackPhysicalScene } from '../../../core/packs/scene.ts'
import type { PhysicalSceneView } from './types.ts'

const layers = new WeakMap<PackPhysicalScene, Map<string, ReadonlyArray<string>>>()
export const physicalHiddenLayers = (scene: PackPhysicalScene, view: PhysicalSceneView): ReadonlySet<string> => new Set(view.hiddenLayerIds ?? scene.layers?.filter(layer => !layer.defaultVisible).map(layer => layer.id) ?? [])
/** Only layers that can produce this representation's real meshes affect its
 * preparation identity. Label/dimension/other overlay toggles stay immediate. */
export const physicalMeshLayers = (scene: PackPhysicalScene, view: PhysicalSceneView): ReadonlyArray<string> => {
  const key = JSON.stringify([view.mode, view.cutaway, view.levelId]), cache = layers.get(scene) ?? new Map<string, ReadonlyArray<string>>()
  layers.set(scene, cache)
  const prior = cache.get(key); if (prior) return prior
  const result = new Set<string>()
  for (const object of scene.objects) if (object.layerId && object.kind !== 'space' && object.kind !== 'opening' && object.kind !== 'assembly' && !(view.cutaway && object.kind === 'roof')) result.add(object.layerId)
  if (view.mode === '3d') for (const annotation of scene.planAnnotations ?? []) if (annotation.kind === 'hatch' && annotation.layerId && (view.levelId === 'all' || annotation.levelIds.includes(view.levelId) || annotation.levelIds.includes('site')) && annotation.outline.every(point => point[2] === annotation.outline[0]![2])) result.add(annotation.layerId)
  const value = [...result].sort(); cache.set(key, value); return value
}
export const physicalDesiredMeshLayers = (scene: PackPhysicalScene, view: PhysicalSceneView): ReadonlyArray<string> => {
  const hidden = physicalHiddenLayers(scene, view)
  return physicalMeshLayers(scene, view).filter(id => !hidden.has(id))
}
/** Coverage grows monotonically while one floor/scope representation remains
 * active. Hidden known layers remain cached; no layer-combination catalog. */
export const physicalLayerUnion = (...groups: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> => [...new Set(groups.flat())].sort()
export const physicalMissingLayers = (desired: ReadonlyArray<string>, coverage: ReadonlyArray<string> = []): ReadonlyArray<string> => {
  const retained = new Set(coverage); return desired.filter(id => !retained.has(id))
}
export const physicalViewWithMeshCoverage = <T extends PhysicalSceneView>(scene: PackPhysicalScene, view: T, coverage: ReadonlyArray<string>): T => {
  const included = new Set(coverage), hidden = new Set(physicalHiddenLayers(scene, view))
  for (const id of physicalMeshLayers(scene, view)) included.has(id) ? hidden.delete(id) : hidden.add(id)
  return { ...view, hiddenLayerIds: [...hidden].sort() }
}
/** This is a derived mesh demand, never a partial retained source/graph. The
 * registered immutable source and occurrence objects remain whole and shared. */
export const physicalMeshDemandScene = (scene: PackPhysicalScene, view: PhysicalSceneView): PackPhysicalScene => {
  const hidden = physicalHiddenLayers(scene, view)
  if (!hidden.size) return scene
  const objects = scene.objects.filter(object => !object.layerId || !hidden.has(object.layerId)), planAnnotations = scene.planAnnotations?.filter(annotation => !annotation.layerId || !hidden.has(annotation.layerId))
  return { ...scene, objects, ...(planAnnotations ? { planAnnotations } : {}) }
}
