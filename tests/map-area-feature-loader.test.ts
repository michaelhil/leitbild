import { describe, expect, test } from 'bun:test'
import type { ControlInstanceId, IsoTimestamp } from '../src/core/model/index.ts'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import type { LeitbildPack, PackMapAreaFeature, PackQueryRequest } from '../src/core/packs/protocol.ts'
import { createMapAreaFeatureLoader } from '../src/ui/app/map-area-feature-loader.ts'
import type { ControlInstanceRequestOptions } from '../src/ui/control-instance-client.ts'
import type { PackQueryApiResponse } from '../src/ui/types.ts'

const generatedAt = '2026-05-30T00:00:00.000Z' as IsoTimestamp

const viewport = {
  type: 'Polygon',
  coordinates: [[
    geoPointFromLonLat(10, 59).coordinates,
    geoPointFromLonLat(11, 59).coordinates,
    geoPointFromLonLat(11, 60).coordinates,
    geoPointFromLonLat(10, 60).coordinates,
    geoPointFromLonLat(10, 59).coordinates,
  ]],
} as const

const featureFor = (id: string): PackMapAreaFeature => ({
  id,
  categoryId: 'weather',
  geometry: viewport,
  color: '#2563eb',
  summary: id,
})

const delay = async (ms: number): Promise<void> => {
  await new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })
}

const createPack = (requests: ReadonlyArray<PackQueryRequest>): LeitbildPack => ({
  id: 'weather',
  name: 'Weather',
  categories: [],
  createObjectTypes: [],
  mapAreaFeatures: () => [featureFor('sync-feature')],
  mapAreaFeatureQueries: () => requests,
  presentObject: () => ({
    categoryId: 'weather',
    icon: 'weather',
    color: '#2563eb',
    summary: '',
    fields: [],
    status: { tone: 'ready', label: 'Ready', indicator: { shape: 'dot' } },
  }),
  defaultObjectLabel: () => 'unused',
  buildCreateObjectCommand: () => ({ kind: 'unused', payload: {}, targetObjectIds: [] }),
  isController: () => false,
  isTarget: () => false,
  buildSetTargetCommand: () => ({ kind: 'unused', payload: {}, targetObjectIds: [] }),
  buildCancelTargetCommand: () => ({ kind: 'unused', payload: {}, targetObjectIds: [] }),
})

describe('MapAreaFeatureLoader', () => {
  test('runs pack map-area queries concurrently and preserves sync features', async () => {
    const requests: ReadonlyArray<PackQueryRequest> = [
      { packId: 'weather', kind: 'first', payload: {} },
      { packId: 'weather', kind: 'second', payload: {} },
    ]
    let activeQueries = 0
    let maxActiveQueries = 0
    const queryPack = async (
      _controlInstanceId: ControlInstanceId,
      request: PackQueryRequest,
      options?: ControlInstanceRequestOptions,
    ): Promise<PackQueryApiResponse> => {
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      activeQueries += 1
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries)
      await delay(10)
      activeQueries -= 1
      return {
        response: {
          ok: true,
          packId: request.packId,
          kind: request.kind,
          result: { features: [featureFor(`query-feature:${request.kind}`)] },
          generatedAt,
        },
      }
    }
    const loader = createMapAreaFeatureLoader({
      pack: () => createPack(requests),
      objects: () => [],
      controlInstanceId: () => 'control-instance:test' as ControlInstanceId,
      currentTime: () => generatedAt,
      queryPack,
      queryTimeoutMs: 500,
    })

    const features = await loader({ viewport, zoom: 8 })

    expect(maxActiveQueries).toBe(2)
    expect(features.map(feature => feature.id)).toEqual([
      'sync-feature',
      'query-feature:first',
      'query-feature:second',
    ])
  })
})
