import { describe, expect, test } from 'bun:test'
import type { SimulationRunId, IsoTimestamp } from '../src/core/model/index.ts'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import {
  createWorldPackDescriptor,
  emptyPackScenarioConfigSchema,
  type WorldPack,
  type PackMapFeature,
  type PackMapFeatureQuery,
} from '../src/core/packs/protocol.ts'
import { createMapFeatureLoader } from '../src/ui/app/map-feature-loader.ts'
import type { SimulationRunRequestOptions } from '../src/ui/simulation-run-client.ts'
import { createActivePackViews } from '../src/core/packs/active-views.ts'

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

const featureFor = (id: string): PackMapFeature => ({
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

const createPack = (requests: ReadonlyArray<PackMapFeatureQuery>): WorldPack => ({
  descriptor: createWorldPackDescriptor({
    id: 'weather-test',
    version: '1.0.0',
    name: 'Weather Test',
    description: 'Test Pack.',
    contributions: ['presentation'],
  }),
  scenarioConfigSchema: emptyPackScenarioConfigSchema,
  presentation: {
    categories: [],
    mapFeatures: () => [featureFor('sync-feature')],
    mapFeatureQueries: () => requests,
    presentObject: () => ({
      categoryId: 'weather',
      icon: 'weather',
      color: '#2563eb',
      summary: '',
      fields: [],
      status: { tone: 'ready', label: 'Ready', indicator: { shape: 'dot' } },
    }),
  },
})

describe('MapFeatureLoader', () => {
  test('one failed pack does not erase healthy layers and truncation stays visible', async () => {
    let warnings: ReadonlyArray<string> = []
    const loader = createMapFeatureLoader({
      pack: () => createActivePackViews([createPack([{ capabilityId: 'world.weather-test.good', input: {} }, { capabilityId: 'world.weather-test.broken', input: {} }])]),
      objects: () => [], simulationRunId: () => 'run-test' as SimulationRunId, currentTime: () => generatedAt,
      queryCapability: async (_id, request) => { if (request.capabilityId === 'world.weather-test.broken') throw new Error('Test provider failed'); return { features: [featureFor('good')], truncated: true } },
      onWarnings: messages => { warnings = messages },
    })
    expect((await loader({ viewport, zoom: 8 })).map(feature => feature.id)).toEqual(['sync-feature','good'])
    expect(warnings).toHaveLength(2); expect(warnings.join(' ')).toContain('coverage limited'); expect(warnings.join(' ')).toContain('Test provider failed')
  })
  test('runs pack map-area queries concurrently and preserves sync features', async () => {
    const requests: ReadonlyArray<PackMapFeatureQuery> = [
      { capabilityId: 'world.weather-test.first', input: {} },
      { capabilityId: 'world.weather-test.second', input: {} },
    ]
    let activeQueries = 0
    let maxActiveQueries = 0
    const queryCapability = async (
      _simulationRunId: SimulationRunId,
      request: PackMapFeatureQuery,
      options?: SimulationRunRequestOptions,
    ): Promise<unknown> => {
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      activeQueries += 1
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries)
      await delay(10)
      activeQueries -= 1
      return { features: [featureFor(`query-feature:${request.capabilityId}`)] }
    }
    const loader = createMapFeatureLoader({
      pack: () => createActivePackViews([createPack(requests)]),
      objects: () => [],
      simulationRunId: () => 'run-test' as SimulationRunId,
      currentTime: () => generatedAt,
      queryCapability,
      queryTimeoutMs: 500,
    })

    const features = await loader({ viewport, zoom: 8 })

    expect(maxActiveQueries).toBe(2)
    expect(features.map(feature => feature.id)).toEqual([
      'sync-feature',
      'query-feature:world.weather-test.first',
      'query-feature:world.weather-test.second',
    ])
  })
})
