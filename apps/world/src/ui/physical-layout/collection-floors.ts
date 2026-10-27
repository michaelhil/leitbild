import type { PhysicalSceneLevel } from '../../core/packs/scene.ts'
import type { PhysicalScenePresentation, PhysicalSceneView } from '../map/physical-scene/types.ts'

export interface PhysicalCollectionFloorGroup {
  readonly key: string
  readonly label: string
  readonly memberLabels: ReadonlyArray<string>
  readonly scenes: ReadonlyArray<PhysicalScenePresentation>
  readonly levels: ReadonlyArray<PhysicalSceneLevel>
  /** Null is an explicit mixed selection, never a representative source floor. */
  readonly levelId: string | null
}
/** Only an exact reusable Design and identical complete level profile share a
 * floor control. Unidentified templates remain separate; labels never establish identity. */
export const physicalCollectionFloorGroups = (scenes: ReadonlyArray<PhysicalScenePresentation>, label: (scene: PhysicalScenePresentation) => string): ReadonlyArray<PhysicalCollectionFloorGroup> => {
  const groups = new Map<string, PhysicalScenePresentation[]>()
  for (const scene of scenes) {
    const d = scene.descriptor, profile = d.levels.map(level => [level.id, level.label, level.elevation, level.cutHeight])
    const key = JSON.stringify([d.geometryKey === undefined ? ['private', d.id] : ['design', d.geometryKey], profile])
    const previous = groups.get(key); if (previous) previous.push(scene); else groups.set(key, [scene])
  }
  return [...groups].map(([key, members]) => {
    const roots = [...new Set(members.flatMap(scene => (scene.descriptor.scopes ?? []).filter(scope => scope.parentId === undefined && scope.kind !== 'area').map(scope => scope.label)))].sort()
    const selected = new Set(members.map(scene => scene.view.levelId))
    return { key, label: roots.join(' / ') || 'Layouts', memberLabels: members.map(label), scenes: members, levels: members[0]!.descriptor.levels, levelId: selected.size === 1 ? selected.values().next().value! : null }
  })
}
export const physicalCollectionFloorChanges = (group: PhysicalCollectionFloorGroup, levelId: string): ReadonlyArray<{ readonly sceneId: string; readonly view: PhysicalSceneView }> => {
  if (levelId === 'all' ? group.scenes.some(scene => scene.view.mode !== '3d') : !group.levels.some(level => level.id === levelId)) throw new Error(`Unknown collection floor: ${levelId}`)
  return group.scenes.map(scene => ({ sceneId: scene.descriptor.id, view: { ...scene.view, levelId } }))
}
export type PhysicalMixedViewSetting = 'live' | 'cutaway' | 'detail' | 'separation' | 'wallOpacity' | 'floorOpacity'
export const physicalCollectionMixedSettings = (scenes: ReadonlyArray<PhysicalScenePresentation>): ReadonlyArray<PhysicalMixedViewSetting> =>
  (['live', 'cutaway', 'detail', 'separation', 'wallOpacity', 'floorOpacity'] as const).filter(key => new Set(scenes.map(scene => key === 'wallOpacity' || key === 'floorOpacity' ? scene.view[key] ?? 1 : scene.view[key])).size > 1)
/** A Stack-to-Plan change restores each source's own valid floor. */
export const physicalPlanLevelAfterModeChange = (scene: PhysicalScenePresentation, remembered?: string): string => {
  if (scene.view.levelId !== 'all') return scene.view.levelId
  return remembered !== undefined && scene.descriptor.levels.some(level => level.id === remembered) ? remembered : scene.descriptor.levels[0]!.id
}
