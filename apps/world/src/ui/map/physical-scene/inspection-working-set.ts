import { physicalPreparedGeometryBuffers, type PhysicalPreparedGeometry } from './preparation.ts'
import type { PhysicalSceneView } from './types.ts'

interface Representation {
  readonly signature: string
  readonly coverage: ReadonlyArray<string>
  readonly asset: PhysicalPreparedGeometry
}
const signature = (view: PhysicalSceneView, scopeId?: string): string => JSON.stringify([
  view.mode, view.levelId, view.cutaway, view.levelId === 'all' && view.separation > 0, scopeId ?? null,
])

/** An inspection owns its current Plan and spatial representations. A mode
 * switch must not make reuse depend on GC, while visiting floors/scopes must
 * not turn into a strong cache of every view ever opened. Source replacement,
 * scope and selected inspection population own this lifetime; camera movement
 * and display-only styles do not create new representations. */
export const createPhysicalInspectionWorkingSet = () => {
  const scenes = new Map<string, Map<PhysicalSceneView['mode'], Representation>>()
  const inventories = new WeakMap<PhysicalPreparedGeometry, ReadonlySet<ArrayBufferLike>>()
  return {
    select(sceneId: string, view: PhysicalSceneView, scopeId?: string): Representation | undefined {
      const modes = scenes.get(sceneId), value = modes?.get(view.mode)
      if (value?.signature === signature(view, scopeId)) return value
      modes?.delete(view.mode)
      if (modes?.size === 0) scenes.delete(sceneId)
      return undefined
    },
    remember(sceneId: string, view: PhysicalSceneView, scopeId: string | undefined, coverage: ReadonlyArray<string>, asset: PhysicalPreparedGeometry): void {
      const base = asset.sourceAsset ?? asset
      for (const values of scenes.values()) for (const previous of values.values()) if (previous.asset.key === base.key && previous.asset !== base) throw new Error('Immutable inspection representation key changed its CPU asset')
      const modes = scenes.get(sceneId) ?? new Map<PhysicalSceneView['mode'], Representation>()
      modes.set(view.mode, { signature: signature(view, scopeId), coverage: [...coverage], asset: base })
      scenes.set(sceneId, modes)
    },
    forget(sceneId: string): void { scenes.delete(sceneId) },
    retainScenes(selected: ReadonlySet<string>): void { for (const id of scenes.keys()) if (!selected.has(id)) scenes.delete(id) },
    metrics() {
      const assets = new Map<string, PhysicalPreparedGeometry>(), buffers = new Set<ArrayBufferLike>()
      let representations = 0
      for (const modes of scenes.values()) for (const value of modes.values()) { representations++; assets.set(value.asset.key, value.asset) }
      for (const asset of assets.values()) {
        let inventory = inventories.get(asset)
        if (!inventory) { inventory = physicalPreparedGeometryBuffers(asset); inventories.set(asset, inventory) }
        for (const buffer of inventory) buffers.add(buffer)
      }
      return { scenes: scenes.size, representations, uniqueViews: assets.size, bytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0) }
    },
    clear(): void { scenes.clear() },
  }
}
