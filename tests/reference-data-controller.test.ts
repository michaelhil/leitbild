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
  readonly url: string
  readonly attribution: string
}

const makeFakeMap = () => {
  const layers = new Map<string, FakeLayer>()
  const sources = new Map<string, FakeSource>()
  const calls: Array<{ readonly type: string; readonly args: unknown[] }> = []
  const map = {
    addSource: (id: string, spec: { url: string; attribution: string }) => {
      calls.push({ type: 'addSource', args: [id, spec] })
      sources.set(id, { id, url: spec.url, attribution: spec.attribution })
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
  const datasetId = extra.datasetId ?? 'aero-norway'
  const categories = (extra.categories ?? ['tma', 'ctr', 'airport']).map(category => ({
    category, minZoom: 6, maxZoom: 14, featureCount: 5,
  }))
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
          outputLayer: 'aero',
        },
        categories,
        sources: [{ id: 'openaip', kind: 'remote' }],
        licences: [{ id: 'cc-by-nc-sa-4.0', attribution: '© OpenAIP · CC BY-NC-SA 4.0' }],
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
  test('registers source + fill/line/point/label layers for aero-norway', async () => {
    const { map, layers, sources } = makeFakeMap()
    const controller = await createReferenceDataController({
      map,
      fetchFn: fakeFetch(200, referenceManifestBody()),
    })
    expect(controller.registered.length).toBe(1)
    expect(controller.registered[0]!.datasetId).toBe('aero-norway')
    expect(sources.get('reference:aero-norway')).toBeDefined()
    expect(sources.get('reference:aero-norway')!.url).toContain('pmtiles:///map/datasets/aero-norway/current/')
    // tma + ctr each have fill + line; airport has fill + line + point + label.
    expect(layers.has('reference:aero-norway:tma:fill')).toBe(true)
    expect(layers.has('reference:aero-norway:tma:line')).toBe(true)
    expect(layers.has('reference:aero-norway:airport:fill')).toBe(true)
    expect(layers.has('reference:aero-norway:airport:point')).toBe(true)
    expect(layers.has('reference:aero-norway:airport:label')).toBe(true)
  })

  test('setCategoryVisibility flips all layers in a category', async () => {
    const { map, layers } = makeFakeMap()
    const controller = await createReferenceDataController({
      map,
      fetchFn: fakeFetch(200, referenceManifestBody()),
    })
    controller.setCategoryVisibility('aero-norway', 'tma', false)
    expect(layers.get('reference:aero-norway:tma:fill')!.visibility).toBe('none')
    expect(layers.get('reference:aero-norway:tma:line')!.visibility).toBe('none')
    controller.setCategoryVisibility('aero-norway', 'tma', true)
    expect(layers.get('reference:aero-norway:tma:fill')!.visibility).toBe('visible')
  })

  test('setBulkVisibility applies a whole map of categories', async () => {
    const { map, layers } = makeFakeMap()
    const controller = await createReferenceDataController({
      map,
      fetchFn: fakeFetch(200, referenceManifestBody()),
    })
    controller.setBulkVisibility('aero-norway', { tma: false, ctr: false, airport: true })
    expect(layers.get('reference:aero-norway:tma:fill')!.visibility).toBe('none')
    expect(layers.get('reference:aero-norway:ctr:fill')!.visibility).toBe('none')
    expect(layers.get('reference:aero-norway:airport:fill')!.visibility).toBe('visible')
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
      'reference:aero-norway:tma:fill',
      'reference:aero-norway:tma:line',
      'reference:aero-norway:ctr:fill',
      'reference:aero-norway:airport:label',
    ]
    const grouped = __internals.collectLayerIdsByCategory(layerIds.map(id => ({ id } as never)))
    expect(grouped['tma']!.sort()).toEqual(['reference:aero-norway:tma:fill', 'reference:aero-norway:tma:line'])
    expect(grouped['ctr']).toEqual(['reference:aero-norway:ctr:fill'])
    expect(grouped['airport']).toEqual(['reference:aero-norway:airport:label'])
  })
})
