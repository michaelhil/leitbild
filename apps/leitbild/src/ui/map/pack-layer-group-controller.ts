import type { Map as MapLibreMap } from 'maplibre-gl'
import { layerIdsMatching } from '../../core/packs/layer-id-glob.ts'
import type { MicroworldPack, PackMapLayerGroup } from '../../core/packs/protocol.ts'

// Pack-rail-driven map layer visibility.
//
// Given the active pack(s) and a visibility state (group id → boolean), the
// controller walks every registered MapLibre layer id, picks the ones matching
// each group's `layerIdPattern`, and calls `setLayoutProperty(id, 'visibility',
// ...)`. Toggles arriving before a layer exists are buffered; the controller
// re-applies on every call so a fresh registration picks up the right state.
//
// See ADR 0023.

export interface PackLayerGroupController {
  /** Replace visibility state and apply to the map immediately. */
  readonly apply: (visibility: Readonly<Record<string, boolean>>) => void
  /** All groups exposed by the active packs, in pack-declaration order. */
  readonly groups: ReadonlyArray<PackMapLayerGroup>
  /** Default visibility derived from `defaultVisible` on each group. */
  readonly defaults: Readonly<Record<string, boolean>>
}

const collectGroups = (packs: ReadonlyArray<MicroworldPack>): ReadonlyArray<PackMapLayerGroup> => {
  const out: PackMapLayerGroup[] = []
  const seen = new Set<string>()
  for (const pack of packs) {
    for (const group of pack.presentation.mapLayerGroups ?? []) {
      if (seen.has(group.id)) continue
      seen.add(group.id)
      out.push(group)
    }
  }
  return out
}

const allLayerIds = (map: MapLibreMap): string[] => {
  const style = map.getStyle()
  const layers = style?.layers ?? []
  return layers.map(l => l.id)
}

const safeSetVisibility = (map: MapLibreMap, layerId: string, visible: boolean): void => {
  try {
    if (!map.getLayer(layerId)) return
    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
  } catch (err) {
    console.warn(`pack-layer-group: setLayoutProperty failed for ${layerId} —`, err)
  }
}

export const createPackLayerGroupController = (config: {
  readonly map: MapLibreMap
  readonly packs: ReadonlyArray<MicroworldPack>
}): PackLayerGroupController =>
  createPackLayerGroupControllerFromGroups({
    map: config.map,
    groups: collectGroups(config.packs),
  })

export const createPackLayerGroupControllerFromGroups = (config: {
  readonly map: MapLibreMap
  readonly groups: ReadonlyArray<PackMapLayerGroup>
}): PackLayerGroupController => {
  const groups = config.groups
  const defaults: Record<string, boolean> = {}
  for (const g of groups) defaults[g.id] = g.defaultVisible

  return {
    groups,
    defaults,
    apply: (visibility) => {
      const ids = allLayerIds(config.map)
      for (const group of groups) {
        const visible = visibility[group.id] ?? group.defaultVisible
        const matches = layerIdsMatching(ids, group.layerIdPattern)
        for (const layerId of matches) safeSetVisibility(config.map, layerId, visible)
      }
    },
  }
}

export const packLayerGroupsFromActive = (
  packs: ReadonlyArray<MicroworldPack>,
): ReadonlyArray<PackMapLayerGroup> => collectGroups(packs)

export const defaultVisibilityFor = (
  groups: ReadonlyArray<PackMapLayerGroup>,
): Readonly<Record<string, boolean>> => {
  const out: Record<string, boolean> = {}
  for (const g of groups) out[g.id] = g.defaultVisible
  return out
}
