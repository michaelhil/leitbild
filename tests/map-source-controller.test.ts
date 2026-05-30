import { describe, expect, test } from 'bun:test'
import { createMapSourceController, type MapSourceLayer } from '../src/ui/map/map-source-controller.ts'
import type { OperationalObject } from '../src/core/model/index.ts'

const makeMapWithSources = () => {
  const setDataCalls = new Map<string, number>()
  const source = (id: string) => ({
    setData: (_data: unknown): void => {
      setDataCalls.set(id, (setDataCalls.get(id) ?? 0) + 1)
    },
  })
  const map = {
    getSource: (id: string) => source(id),
  } as never
  return { map, setDataCalls }
}

const createController = (config: {
  readonly map: never
  readonly objects?: ReadonlyArray<OperationalObject>
  readonly enabledLayers: ReadonlyArray<MapSourceLayer>
  readonly setDataCalls: ReadonlyMap<string, number>
}) => createMapSourceController({
  getMap: () => config.map,
  isLoaded: () => true,
  getObjects: () => config.objects ?? [],
  getDisplayObjects: () => config.objects ?? [],
  getSelectedControllerId: () => null,
  getHighlightedObjectIds: () => [],
  getPlacementPoints: () => [],
  hasNewInfo: () => false,
  presentationFor: () => ({
    categoryId: 'none',
    icon: 'grid',
    color: '#000000',
    summary: '',
    fields: [],
  }),
  getPackMapAreaFeatures: () => [],
  isLayerEnabled: layer => config.enabledLayers.includes(layer),
  updateMarkerPopup: () => undefined,
})

describe('MapSourceController', () => {
  test('refreshAll only writes enabled source families', () => {
    const { map, setDataCalls } = makeMapWithSources()
    const controller = createController({
      map,
      enabledLayers: ['objects'],
      setDataCalls,
    })

    controller.refreshAll()

    expect(setDataCalls.get('objects')).toBe(1)
    expect(setDataCalls.get('weather-line-source')).toBeUndefined()
    expect(setDataCalls.get('traffic-line-source')).toBeUndefined()
    expect(setDataCalls.get('grid-line-source')).toBeUndefined()
    expect(setDataCalls.get('planned-route-source')).toBeUndefined()
  })
})
