import type { PhysicalSceneHit } from '../map/physical-scene/types.ts'

/** A deliberate rest on one physical occurrence opens its card. Pointer motion
 * within that same occurrence updates its anchor without postponing the rest.
 * Navigation, capture, source/scope changes and unmount cancel the intent. */
export const createPhysicalHoverIntent = (open: (hit: PhysicalSceneHit) => void, schedule: (work: () => void, delayMs: number) => () => void = (work, delayMs) => {
  const timer = setTimeout(work, delayMs)
  return () => clearTimeout(timer)
}) => {
  let current: PhysicalSceneHit | null = null, identity: string | null = null, cancel: (() => void) | null = null, generation = 0
  const clear = (): void => { generation++; cancel?.(); cancel = null; current = null; identity = null }
  return {
    clear,
    update(hit: PhysicalSceneHit | null): void {
      const next = hit === null ? null : JSON.stringify([hit.sceneId, hit.occurrenceId, hit.subjectIds])
      if (next === identity) { current = hit; return }
      clear(); current = hit; identity = next
      if (hit === null) return
      const expected = generation
      cancel = schedule(() => { if (expected !== generation || current === null) return; cancel = null; open(current) }, 2_000)
    },
  }
}
