import type { PhysicalScenePresentation, PhysicalSceneView } from '../map/physical-scene/types.ts'

export interface PhysicalCollectionLayerChoice {
  readonly key: string
  readonly id: string
  readonly label: string
  readonly memberLabels: ReadonlyArray<string>
  readonly scenes: ReadonlyArray<PhysicalScenePresentation>
  /** Null means that declaring layouts currently disagree on visibility. */
  readonly visible: boolean | null
}

const hiddenLayers = (scene: PhysicalScenePresentation): ReadonlyArray<string> =>
  scene.view.hiddenLayerIds ?? scene.descriptor.layers?.filter(layer => !layer.defaultVisible).map(layer => layer.id) ?? []

/** Aggregate matching declared controls, not a global namespace for source layers.
 * Every member retains its own local layer reference, defaults and view state. */
export const physicalCollectionLayerChoices = (scenes: ReadonlyArray<PhysicalScenePresentation>, label: (scene: PhysicalScenePresentation) => string): ReadonlyArray<PhysicalCollectionLayerChoice> => {
  const groups = new Map<string, { id: string; label: string; scenes: PhysicalScenePresentation[] }>()
  for (const scene of scenes) for (const layer of scene.descriptor.layers ?? []) {
    const key = JSON.stringify([layer.id, layer.label]), group = groups.get(key)
    if (group) group.scenes.push(scene)
    else groups.set(key, { id: layer.id, label: layer.label, scenes: [scene] })
  }
  return [...groups].map(([key, group]) => {
    const visible = new Set(group.scenes.map(scene => !hiddenLayers(scene).includes(group.id)))
    return { ...group, key, memberLabels: group.scenes.map(label), visible: visible.size === 1 ? visible.values().next().value! : null }
  })
}

/** Call with the current choice resolved from the current selected population. */
export const physicalCollectionLayerChanges = (choice: PhysicalCollectionLayerChoice, visible: boolean): ReadonlyArray<{ readonly sceneId: string; readonly view: PhysicalSceneView }> =>
  choice.scenes.map(scene => {
    if (!scene.descriptor.layers?.some(layer => layer.id === choice.id && layer.label === choice.label)) throw new Error(`Collection layer is no longer declared: ${choice.id}`)
    const hidden = hiddenLayers(scene)
    const hiddenLayerIds = visible ? hidden.filter(id => id !== choice.id) : hidden.includes(choice.id) ? [...hidden] : [...hidden, choice.id]
    return { sceneId: scene.descriptor.id, view: { ...scene.view, hiddenLayerIds } }
  })
