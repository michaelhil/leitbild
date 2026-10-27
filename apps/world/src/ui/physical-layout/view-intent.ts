import type { PhysicalScenePresentation, PhysicalSceneView } from '../map/physical-scene/types.ts'

/** Editing composes with pending intent; drawing always consumes applied view. */
export const requestedPhysicalLayoutView = (scene: PhysicalScenePresentation): PhysicalSceneView =>
  scene.opacityPreparation ? { ...scene.view, ...scene.opacityPreparation.requested } : scene.view

/** Aggregate equal pending states without repeating one line per placement. */
export const physicalOpacityPreparationText = (scenes: readonly PhysicalScenePresentation[]): string => {
  const groups = new Map<string, { scene: PhysicalScenePresentation; count: number }>()
  for (const scene of scenes) if (scene.opacityPreparation) {
    const key = JSON.stringify([scene.opacityPreparation, scene.view.wallOpacity ?? 1, scene.view.floorOpacity ?? 1]), group = groups.get(key)
    if (group) group.count++; else groups.set(key, { scene, count: 1 })
  }
  const percent = (value: number | undefined): string => `${Math.round((value ?? 1) * 100)}%`
  return [...groups.values()].map(({ scene, count }) => {
    const pending = scene.opacityPreparation!, requested = pending.requested
    const action = pending.status === 'loading' ? 'Preparing architecture transparency' : `Architecture transparency unavailable: ${pending.reason ?? 'retry required'}`
    return `${action} · ${count} ${count === 1 ? 'layout' : 'layouts'} · requested wall ${percent(requested.wallOpacity)}, floor ${percent(requested.floorOpacity)}; showing wall ${percent(scene.view.wallOpacity)}, floor ${percent(scene.view.floorOpacity)}`
  }).join(' · ')
}
