import { describe, expect, test } from 'bun:test'
import { createMapSourceController, type MapSourceLayer } from '../src/ui/map/map-source-controller.ts'
import { geoPointFromLonLat, type IsoTimestamp, type ObjectId, type OperationalObject, type PackId } from '../src/core/model/index.ts'
import type { PackObjectStatusTone } from '../src/core/packs/protocol.ts'

const makeMapWithSources = () => {
  const setDataCalls = new Map<string, number>()
  const featureStateCalls = new Map<string, number>()
  const source = (id: string) => ({
    setData: (_data: unknown): void => {
      setDataCalls.set(id, (setDataCalls.get(id) ?? 0) + 1)
    },
  })
  const map = {
    getSource: (id: string) => source(id),
    setFeatureState: (target: { readonly source: string; readonly id?: string | number }, _state: unknown): void => {
      const key = `${target.source}:${String(target.id)}`
      featureStateCalls.set(key, (featureStateCalls.get(key) ?? 0) + 1)
    },
    removeFeatureState: (_target: { readonly source: string; readonly id?: string | number }): void => undefined,
  } as never
  return { map, setDataCalls, featureStateCalls }
}

const createController = (config: {
  readonly map: never
  readonly objects?: ReadonlyArray<OperationalObject> | (() => ReadonlyArray<OperationalObject>)
  readonly enabledLayers: ReadonlyArray<MapSourceLayer>
  readonly setDataCalls: ReadonlyMap<string, number>
  readonly presentationCategory?: string
  readonly presentationToneFor?: (object: OperationalObject) => PackObjectStatusTone
}) => createMapSourceController({
  getMap: () => config.map,
  isLoaded: () => true,
  getObjects: () => typeof config.objects === 'function' ? config.objects() : config.objects ?? [],
  getDisplayObjects: () => typeof config.objects === 'function' ? config.objects() : config.objects ?? [],
  getSelectedControllerId: () => null,
  getHighlightedObjectIds: () => [],
  getPlacementPoints: () => [],
  hasNewInfo: () => false,
  presentationFor: object => ({
    categoryId: config.presentationCategory ?? 'none',
    icon: 'grid',
    color: '#000000',
    summary: '',
    fields: [],
    status: { tone: config.presentationToneFor?.(object) ?? 'ready', label: 'Ready', indicator: { shape: 'dot' } },
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

  test('does not resend unchanged object source data on repeated refreshes', () => {
    const { map, setDataCalls } = makeMapWithSources()
    const asset: OperationalObject = {
      id: 'facility:1' as ObjectId,
      kind: 'facility',
      packId: 'ambulance' as PackId,
      label: 'Facility 1',
      lifecycle: 'active',
      revision: 1,
      spatial: {
        frame: { kind: 'wgs84' },
        position: {
          point: geoPointFromLonLat(10.75, 59.91),
          observedAt: '2026-05-30T00:00:00.000Z' as IsoTimestamp,
        },
      },
      operational: { status: 'normal', mode: 'simulated' },
      alerts: [],
      provenance: { source: 'simulator' },
      timestamps: {
        createdAt: '2026-05-30T00:00:00.000Z' as IsoTimestamp,
        updatedAt: '2026-05-30T00:00:00.000Z' as IsoTimestamp,
      },
    }
    const controller = createController({
      map,
      objects: [asset],
      enabledLayers: ['objects'],
      setDataCalls,
    })

    controller.refreshObjects()
    controller.refreshObjects()

    expect(setDataCalls.get('objects')).toBe(1)
  })

  test('uses feature-state for repeated grid branch visual updates without resending geometry', () => {
    const { map, setDataCalls, featureStateCalls } = makeMapWithSources()
    let branch: OperationalObject = {
      id: 'grid:branch:1' as ObjectId,
      kind: 'zone',
      packId: 'electric-grid' as PackId,
      label: 'Branch 1',
      lifecycle: 'active',
      revision: 1,
      spatial: {
        frame: { kind: 'wgs84' },
        geometry: {
          type: 'LineString',
          coordinates: [
            geoPointFromLonLat(10, 59).coordinates,
            geoPointFromLonLat(11, 60).coordinates,
          ],
        },
      },
      operational: { status: 'normal', mode: 'simulated' },
      alerts: [],
      provenance: { source: 'simulator' },
      timestamps: {
        createdAt: '2026-05-30T00:00:00.000Z' as IsoTimestamp,
        updatedAt: '2026-05-30T00:00:00.000Z' as IsoTimestamp,
      },
    }
    const controller = createController({
      map,
      objects: () => [branch],
      enabledLayers: ['grid'],
      setDataCalls,
      presentationCategory: 'grid-branches',
      presentationToneFor: object => object.operational.status === 'constrained' ? 'working' : 'ready',
    })

    controller.refreshGrid()
    branch = {
      ...branch,
      revision: 2,
      operational: { ...branch.operational, status: 'constrained' },
      spatial: {
        ...branch.spatial,
        geometry: {
          type: 'LineString',
          coordinates: [
            [...geoPointFromLonLat(10, 59).coordinates],
            [...geoPointFromLonLat(11, 60).coordinates],
          ],
        },
      },
    }
    controller.refreshGrid()

    expect(setDataCalls.get('grid-line-source')).toBe(1)
    expect(featureStateCalls.get('grid-line-source:grid:branch:1')).toBe(2)
  })
})
