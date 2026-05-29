import { describe, expect, test } from 'bun:test'
import { applyConfiguredMapLayerVisibility } from '../src/ui/map/map-layer-visibility.ts'
import { mapLayerIds } from '../src/ui/map/map-features.ts'

const makeMap = () => {
  const visibility = new Map<string, string>()
  for (const layerId of Object.values(mapLayerIds)) visibility.set(layerId, 'visible')
  const map = {
    getLayer: (id: string) => visibility.has(id) ? { id } : null,
    setLayoutProperty: (id: string, property: string, value: string) => {
      if (property !== 'visibility') throw new Error(`unexpected property ${property}`)
      visibility.set(id, value)
    },
  }
  return { map, visibility }
}

describe('configured map layer visibility', () => {
  test('treats operational grid branches as a first-class scenario map layer', () => {
    const { map, visibility } = makeMap()

    applyConfiguredMapLayerVisibility({
      map: map as never,
      enabledLayers: ['objects', 'traffic', 'weather', 'highlights'],
    })

    expect(visibility.get(mapLayerIds.gridLine)).toBe('none')
    expect(visibility.get(mapLayerIds.gridLineCasing)).toBe('none')

    applyConfiguredMapLayerVisibility({
      map: map as never,
      enabledLayers: ['objects', 'traffic', 'weather', 'grid', 'highlights'],
    })

    expect(visibility.get(mapLayerIds.gridLine)).toBe('visible')
    expect(visibility.get(mapLayerIds.gridLineCasing)).toBe('visible')
  })
})
