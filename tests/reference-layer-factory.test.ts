import { describe, expect, test } from 'bun:test'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { aeroNorwayStyleModule } from '../src/packs/aviation/ui/aero-norway-style.ts'
import { gridNorwayStyleModule } from '../src/packs/electric-grid/ui/grid-norway-style.ts'
import {
  buildReferenceDatasetLayers,
  __internals,
  type DatasetManifestForLayers,
  type DatasetStyleModule,
} from '../src/ui/map/reference-layer-factory.ts'

const baseManifest: DatasetManifestForLayers = {
  datasetId: 'aero-norway',
  artifact: {
    pmtilesPath: 'aero-norway.pmtiles',
    sidecarGeoJsonPath: 'aero-norway.features.geojson',
    outputLayer: 'aero',
  },
  categories: [
    { category: 'tma', minZoom: 6, maxZoom: 14, featureCount: 8 },
    { category: 'ctr', minZoom: 8, maxZoom: 14, featureCount: 4 },
    { category: 'airport', minZoom: 6, maxZoom: 14, featureCount: 42 },
  ],
  licences: [
    { id: 'cc-by-nc-sa-4.0', attribution: '© OpenAIP contributors · CC BY-NC-SA 4.0' },
    { id: 'nlod-2.0', attribution: '© Avinor · NLOD 2.0' },
  ],
}

const expressionContains = (value: unknown, token: string): boolean =>
  Array.isArray(value)
    ? value.some(item => expressionContains(item, token))
    : value === token

const validateMapLibrePaint = (
  type: 'line' | 'circle',
  paint: Record<string, unknown>,
): ReadonlyArray<string> => {
  const errors = validateStyleMin({
    version: 8,
    sources: {
      reference: {
        type: 'vector',
        url: 'pmtiles:///test.pmtiles',
      },
    },
    layers: [{
      id: 'reference-test',
      type,
      source: 'reference',
      'source-layer': 'grid',
      paint,
    }],
  })
  return errors.map(error => error.message)
}

describe('buildReferenceDatasetLayers', () => {
  test('emits one fill + one line per category, in deterministic order', () => {
    const built = buildReferenceDatasetLayers(baseManifest, aeroNorwayStyleModule)
    const ids = built.layers.map(l => l.id)
    expect(ids).toContain('reference:aero-norway:tma:fill')
    expect(ids).toContain('reference:aero-norway:tma:line')
    expect(ids).toContain('reference:aero-norway:ctr:fill')
    expect(ids).toContain('reference:aero-norway:ctr:line')
    // Fill layers come before line layers (deterministic ordering for paint stack).
    const tmaFill = ids.indexOf('reference:aero-norway:tma:fill')
    const tmaLine = ids.indexOf('reference:aero-norway:tma:line')
    expect(tmaFill).toBeLessThan(tmaLine)
  })

  test('airport category emits point + label layers', () => {
    const built = buildReferenceDatasetLayers(baseManifest, aeroNorwayStyleModule)
    const ids = built.layers.map(l => l.id)
    expect(ids).toContain('reference:aero-norway:airport:point')
    expect(ids).toContain('reference:aero-norway:airport:label')
  })

  test('non-airport categories do not emit point/label layers', () => {
    const built = buildReferenceDatasetLayers(baseManifest, aeroNorwayStyleModule)
    expect(built.layers.find(l => l.id === 'reference:aero-norway:tma:point')).toBeUndefined()
    expect(built.layers.find(l => l.id === 'reference:aero-norway:ctr:label')).toBeUndefined()
  })

  test('source url uses pmtiles:// + Caddy path', () => {
    const built = buildReferenceDatasetLayers(baseManifest, aeroNorwayStyleModule)
    expect(built.sourceId).toBe('reference:aero-norway')
    expect(built.source.url).toBe('pmtiles:///map/datasets/aero-norway/current/aero-norway.pmtiles')
    expect(built.source.type).toBe('vector')
  })

  test('source attribution composes all licences', () => {
    const built = buildReferenceDatasetLayers(baseManifest, aeroNorwayStyleModule)
    expect(built.source.attribution).toContain('OpenAIP')
    expect(built.source.attribution).toContain('Avinor')
    expect(built.source.attribution).toContain(' • ')
  })

  test('layers carry per-category zoom hints from the manifest', () => {
    const built = buildReferenceDatasetLayers(baseManifest, aeroNorwayStyleModule)
    const tmaFill = built.layers.find(l => l.id === 'reference:aero-norway:tma:fill')!
    expect(tmaFill.minzoom).toBe(6)
    expect(tmaFill.maxzoom).toBe(14)
  })

  test('filter on category property', () => {
    const built = buildReferenceDatasetLayers(baseManifest, aeroNorwayStyleModule)
    const tmaFill = built.layers.find(l => l.id === 'reference:aero-norway:tma:fill')!
    expect(tmaFill.filter).toEqual(['==', ['get', 'category'], 'tma'])
  })

  test('unknown category falls back to default style without throwing', () => {
    const manifest: DatasetManifestForLayers = {
      ...baseManifest,
      categories: [{ category: 'something-novel', minZoom: 5, maxZoom: 12, featureCount: 1 }],
    }
    const built = buildReferenceDatasetLayers(manifest, aeroNorwayStyleModule)
    expect(built.layers.length).toBeGreaterThan(0)
    const fill = built.layers.find(l => l.id.endsWith(':something-novel:fill'))!
    expect(fill.paint).toBeDefined()
  })

  test('layer ids never collide across categories', () => {
    const manifest: DatasetManifestForLayers = {
      ...baseManifest,
      categories: [
        { category: 'a', minZoom: 4, maxZoom: 12, featureCount: 1 },
        { category: 'b', minZoom: 4, maxZoom: 12, featureCount: 1 },
        { category: 'c', minZoom: 4, maxZoom: 12, featureCount: 1 },
      ],
    }
    const built = buildReferenceDatasetLayers(manifest, aeroNorwayStyleModule)
    const ids = built.layers.map(l => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('reference-layer-factory internals', () => {
  test('layerIdFor encodes dataset + category + kind', () => {
    expect(__internals.layerIdFor('aero-norway', 'tma', 'fill')).toBe('reference:aero-norway:tma:fill')
  })

  test('tileUrlFor builds Caddy-served pmtiles path', () => {
    expect(__internals.tileUrlFor('foo', 'foo.pmtiles')).toBe('pmtiles:///map/datasets/foo/current/foo.pmtiles')
  })

  test('categoryFilter is the canonical MapLibre expression', () => {
    expect(__internals.categoryFilter('exclusion')).toEqual(['==', ['get', 'category'], 'exclusion'])
  })
})

describe('aero-norway style module', () => {
  test('fill paint uses hover feature-state', () => {
    const paint = aeroNorwayStyleModule.fillFor('tma')
    const opacity = paint['fill-opacity']
    expect(Array.isArray(opacity)).toBe(true)
  })

  test('prohibited line is dashed', () => {
    const paint = aeroNorwayStyleModule.lineFor('prohibited')
    expect(paint['line-dasharray']).toEqual([4, 2])
  })

  test('exclusion has the operator-attention dashed pattern', () => {
    const paint = aeroNorwayStyleModule.lineFor('exclusion')
    expect(paint['line-dasharray']).toEqual([2, 2])
  })

  test('non-airport categories return null for point/label', () => {
    expect(aeroNorwayStyleModule.pointFor?.('tma')).toBeNull()
    expect(aeroNorwayStyleModule.labelFor?.('tma')).toBeNull()
  })

  test('airport has both point and label specs', () => {
    expect(aeroNorwayStyleModule.pointFor?.('airport')).not.toBeNull()
    expect(aeroNorwayStyleModule.labelFor?.('airport')).not.toBeNull()
  })

  test('airport labels use the self-hosted glyph stack', () => {
    expect(aeroNorwayStyleModule.labelFor?.('airport')?.layout['text-font']).toEqual(['Noto Sans Regular'])
  })

  test('unknown category produces a fallback paint (no throw)', () => {
    const paint = aeroNorwayStyleModule.fillFor('something-future-airac-introduces')
    expect(paint['fill-color']).toBeDefined()
  })
})

describe('grid-norway style module', () => {
  test('line and cable categories render as lines without point symbols', () => {
    expect(gridNorwayStyleModule.lineFor('line')['line-color']).toBeDefined()
    expect(gridNorwayStyleModule.lineFor('cable')['line-dasharray']).toEqual([4, 2])
    expect(gridNorwayStyleModule.pointFor?.('line')).toBeNull()
    expect(gridNorwayStyleModule.pointFor?.('cable')).toBeNull()
  })

  test('substations and plants render as point and label layers', () => {
    expect(gridNorwayStyleModule.pointFor?.('substation')).not.toBeNull()
    expect(gridNorwayStyleModule.labelFor?.('substation')).not.toBeNull()
    expect(gridNorwayStyleModule.pointFor?.('plant')).not.toBeNull()
    expect(gridNorwayStyleModule.labelFor?.('plant')).not.toBeNull()
  })

  test('grid labels show named high-voltage sites without falling back to raw OSM ids', () => {
    const label = gridNorwayStyleModule.labelFor?.('substation')
    expect(label?.layout?.['text-field']).toEqual([
      'case',
      ['all', ['>=', ['coalesce', ['get', 'maxVoltageKv'], 0], 300], ['has', 'name']],
      ['get', 'name'],
      '',
    ])
    expect(label?.layout?.['text-font']).toEqual(['Noto Sans Regular'])
  })

  test('grid opacity expressions are valid MapLibre style expressions', () => {
    const linePaint = gridNorwayStyleModule.lineFor('line')
    const substationPaint = gridNorwayStyleModule.pointFor?.('substation')?.paint
    const transformerPaint = gridNorwayStyleModule.pointFor?.('transformer')?.paint

    expect(expressionContains(linePaint['line-opacity'], 'zoom')).toBe(true)
    expect(validateMapLibrePaint('line', linePaint)).toEqual([])
    expect(validateMapLibrePaint('circle', substationPaint ?? {})).toEqual([])
    expect(validateMapLibrePaint('circle', transformerPaint ?? {})).toEqual([])
  })
})

describe('style module abstraction', () => {
  test('factory accepts any DatasetStyleModule', () => {
    const minimalStyle: DatasetStyleModule = {
      outputLayer: 'aero',
      fillFor: () => ({ 'fill-color': '#000', 'fill-opacity': 0.1 }),
      lineFor: () => ({ 'line-color': '#000', 'line-width': 1 }),
    }
    const built = buildReferenceDatasetLayers(baseManifest, minimalStyle)
    // No point/label layers since the minimal style omits those callbacks.
    expect(built.layers.find(l => l.type === 'circle')).toBeUndefined()
    expect(built.layers.find(l => l.type === 'symbol')).toBeUndefined()
  })
})
