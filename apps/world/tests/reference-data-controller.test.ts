import { describe, expect, test } from 'bun:test'
import {
  __internals,
  createReferenceDataController,
} from '../src/ui/map/reference-data-controller.ts'

interface FakeLayer {
  readonly id: string
  visibility: 'visible' | 'none'
}

interface FakeSource {
  readonly id: string
  readonly tiles: ReadonlyArray<string>
  readonly minzoom: number
  readonly maxzoom: number
  readonly attribution: string
}

const makeFakeMap = () => {
  const layers = new Map<string, FakeLayer>()
  const sources = new Map<string, FakeSource>()
  const calls: Array<{ readonly type: string; readonly args: unknown[] }> = []
  const map = {
    addSource: (id: string, spec: { tiles: ReadonlyArray<string>; minzoom: number; maxzoom: number; attribution: string }) => {
      calls.push({ type: 'addSource', args: [id, spec] })
      sources.set(id, {
        id,
        tiles: spec.tiles,
        minzoom: spec.minzoom,
        maxzoom: spec.maxzoom,
        attribution: spec.attribution,
      })
    },
    getSource: (id: string) => sources.get(id) ?? null,
    addLayer: (spec: { id: string }, before?: string) => {
      calls.push({ type: 'addLayer', args: [spec.id, before ?? null] })
      layers.set(spec.id, { id: spec.id, visibility: 'visible' })
    },
    getLayer: (id: string) => layers.get(id) ?? null,
    setLayoutProperty: (id: string, prop: string, value: unknown) => {
      calls.push({ type: 'setLayoutProperty', args: [id, prop, value] })
      const layer = layers.get(id)
      if (layer && prop === 'visibility' && (value === 'visible' || value === 'none')) {
        layer.visibility = value
      }
    },
  } as never
  return { map, layers, sources, calls }
}

const referenceManifestBody = (extra: Partial<{ datasetId: string; categories: ReadonlyArray<string> }> = {}) => {
  const datasetId = extra.datasetId ?? 'grid-norway'
  const categories = (extra.categories ?? ['substation', 'plant', 'generator']).map(category => ({
    category, minZoom: 6, maxZoom: 14, featureCount: 5,
  }))
  const outputLayer = 'grid'
  return {
    schemaVersion: 2,
    tilesets: [
      {
        kind: 'base',
        id: 'leitbild-osm-norway',
      },
      {
        kind: 'reference',
        datasetId,
        schemaVersion: 1,
        builtAt: '2026-05-26T20:00:00Z',
        buildId: '20260526-2000',
        artifact: {
          pmtilesPath: `${datasetId}.pmtiles`,
          sidecarGeoJsonPath: `${datasetId}.features.geojson`,
          outputLayer,
        },
        categories,
        sources: [{ id: 'osm', kind: 'remote' }],
        licences: [{ id: 'odbl-1.0', attribution: '© OpenStreetMap contributors · ODbL' }],
      },
    ],
  }
}

const fakeFetch = (status: number, body: unknown) => async (_input: string): Promise<Response> =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('createReferenceDataController', () => {
  test('registers source + fill/line/point/label layers for grid-norway', async () => {
    const { map, layers, sources } = makeFakeMap()
    const controller = await createReferenceDataController({
      map,
      fetchFn: fakeFetch(200, referenceManifestBody()),
    })
    expect(controller.registered.length).toBe(1)
    expect(controller.registered[0]!.datasetId).toBe('grid-norway')
    expect(sources.get('reference:grid-norway')).toBeDefined()
    expect(sources.get('reference:grid-norway')!.tiles[0]).toContain('/map/datasets/grid-norway/current/')
    // Site categories expose polygon outlines, markers and labels.
    expect(layers.has('reference:grid-norway:substation:fill')).toBe(true)
    expect(layers.has('reference:grid-norway:substation:line')).toBe(true)
    expect(layers.has('reference:grid-norway:generator:fill')).toBe(true)
    expect(layers.has('reference:grid-norway:generator:point')).toBe(true)
    expect(layers.has('reference:grid-norway:generator:label')).toBe(true)
  })

  test('registers grid-norway reference lines and site markers', async () => {
    const { map, layers, sources } = makeFakeMap()
    const controller = await createReferenceDataController({
      map,
      fetchFn: fakeFetch(200, referenceManifestBody({
        datasetId: 'grid-norway',
        categories: ['line', 'cable', 'substation', 'plant'],
      })),
    })

    expect(controller.registered.length).toBe(1)
    expect(controller.registered[0]!.datasetId).toBe('grid-norway')
    expect(sources.get('reference:grid-norway')!.tiles[0]).toContain('/grid-norway/')
    expect(layers.has('reference:grid-norway:line:line')).toBe(true)
    expect(layers.has('reference:grid-norway:cable:line')).toBe(true)
    expect(layers.has('reference:grid-norway:substation:point')).toBe(true)
    expect(layers.has('reference:grid-norway:plant:label')).toBe(true)
  })

  test('setCategoryVisibility flips all layers in a category', async () => {
    const { map, layers } = makeFakeMap()
    const controller = await createReferenceDataController({
      map,
      fetchFn: fakeFetch(200, referenceManifestBody()),
    })
    controller.setCategoryVisibility('grid-norway', 'substation', false)
    expect(layers.get('reference:grid-norway:substation:fill')!.visibility).toBe('none')
    expect(layers.get('reference:grid-norway:substation:line')!.visibility).toBe('none')
    controller.setCategoryVisibility('grid-norway', 'substation', true)
    expect(layers.get('reference:grid-norway:substation:fill')!.visibility).toBe('visible')
  })

  test('setBulkVisibility applies a whole map of categories', async () => {
    const { map, layers } = makeFakeMap()
    const controller = await createReferenceDataController({
      map,
      fetchFn: fakeFetch(200, referenceManifestBody()),
    })
    controller.setBulkVisibility('grid-norway', { substation: false, plant: false, generator: true })
    expect(layers.get('reference:grid-norway:substation:fill')!.visibility).toBe('none')
    expect(layers.get('reference:grid-norway:plant:fill')!.visibility).toBe('none')
    expect(layers.get('reference:grid-norway:generator:fill')!.visibility).toBe('visible')
  })

  test('manifest 404 results in zero registered datasets, no throw', async () => {
    const { map } = makeFakeMap()
    const captured: string[] = []
    const controller = await createReferenceDataController({
      map,
      fetchFn: fakeFetch(404, 'not found'),
      logger: m => captured.push(m),
    })
    expect(controller.registered).toEqual([])
    expect(captured.join('\n')).toMatch(/HTTP 404/)
  })

  test('unknown dataset (no style module) is skipped with a warning', async () => {
    const { map } = makeFakeMap()
    const captured: string[] = []
    const controller = await createReferenceDataController({
      map,
      fetchFn: fakeFetch(200, referenceManifestBody({ datasetId: 'unknown-dataset' })),
      logger: m => captured.push(m),
    })
    expect(controller.registered).toEqual([])
    expect(captured.join('\n')).toMatch(/no style module registered/i)
  })

  test('non-reference tilesets in manifest are ignored', async () => {
    const { map } = makeFakeMap()
    const controller = await createReferenceDataController({
      map,
      fetchFn: fakeFetch(200, { schemaVersion: 2, tilesets: [{ kind: 'base' }] }),
    })
    expect(controller.registered).toEqual([])
  })

  test('datasetIds limits registration to active pack reference datasets', async () => {
    const { map, sources } = makeFakeMap()
    const controller = await createReferenceDataController({
      map,
      datasetIds: ['grid-norway'],
      fetchFn: fakeFetch(200, {
        schemaVersion: 2,
        tilesets: [
          referenceManifestBody({ datasetId: 'grid-norway' }).tilesets[1],
          referenceManifestBody({ datasetId: 'other-dataset' }).tilesets[1],
        ],
      }),
    })

    expect(controller.registered.map(entry => entry.datasetId)).toEqual(['grid-norway'])
    expect(sources.get('reference:grid-norway')).toBeDefined()
    expect(sources.get('reference:other-dataset')).toBeUndefined()
  })

  test('empty datasetIds registers no reference datasets', async () => {
    const { map, sources } = makeFakeMap()
    let fetches = 0
    const controller = await createReferenceDataController({
      map,
      datasetIds: [],
      fetchFn: async (input: string): Promise<Response> => {
        fetches += 1
        return await fakeFetch(200, referenceManifestBody())(input)
      },
    })

    expect(controller.registered).toEqual([])
    expect(sources.get('reference:grid-norway')).toBeUndefined()
    expect(fetches).toBe(0)
  })

  test('manifest parse failure logs and returns gracefully', async () => {
    const { map } = makeFakeMap()
    const captured: string[] = []
    const controller = await createReferenceDataController({
      map,
      fetchFn: fakeFetch(200, 'not json'),
      logger: m => captured.push(m),
    })
    expect(controller.registered).toEqual([])
    expect(captured.length).toBeGreaterThan(0)
  })

  test('beforeLayerId is passed to addLayer when that layer already exists', async () => {
    const { map, calls } = makeFakeMap()
    // Pre-seed an operational "anchor" layer so beforeId is honoured.
    ;(map as unknown as { addLayer: (s: { id: string }) => void }).addLayer({ id: 'weather:base-grid-outline' })
    await createReferenceDataController({
      map,
      fetchFn: fakeFetch(200, referenceManifestBody()),
      beforeLayerId: 'weather:base-grid-outline',
    })
    const addLayerCalls = calls.filter(c => c.type === 'addLayer' && (c.args[0] as string).startsWith('reference:'))
    for (const call of addLayerCalls) {
      expect(call.args[1]).toBe('weather:base-grid-outline')
    }
  })

  test('layer-id partitioning groups by category', () => {
    const layerIds = [
      'reference:grid-norway:substation:fill',
      'reference:grid-norway:substation:line',
      'reference:grid-norway:plant:fill',
      'reference:grid-norway:generator:label',
    ]
    const grouped = __internals.collectLayerIdsByCategory(layerIds.map(id => ({ id } as never)))
    expect(grouped['substation']!.sort()).toEqual(['reference:grid-norway:substation:fill', 'reference:grid-norway:substation:line'])
    expect(grouped['plant']).toEqual(['reference:grid-norway:plant:fill'])
    expect(grouped['generator']).toEqual(['reference:grid-norway:generator:label'])
  })
})
