import { describe, expect, test } from 'bun:test'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { gridNorwayStyleModule } from '../src/packs/electric-grid/ui/grid-norway-style.ts'
import {
  buildReferenceDatasetLayers,
  __internals,
  type DatasetManifestForLayers,
  type DatasetStyleModule,
} from '../src/ui/map/reference-layer-factory.ts'

const testStyle: DatasetStyleModule = {
  outputLayer: 'areas',
  fillFor: () => ({ 'fill-color': '#345', 'fill-opacity': 0.2 }),
  lineFor: () => ({ 'line-color': '#345', 'line-width': 1 }),
  pointFor: category => category === 'landmark' ? { paint: { 'circle-radius': 4, 'circle-color': '#345' } } : null,
  labelFor: category => category === 'landmark' ? { layout: { 'text-field': ['get', 'name'] }, paint: {} } : null,
}

const baseManifest: DatasetManifestForLayers = {
  datasetId: 'reference-areas',
  artifact: {
    pmtilesPath: 'reference-areas.pmtiles',
    sidecarGeoJsonPath: 'reference-areas.features.geojson',
    outputLayer: 'areas',
  },
  categories: [
    { category: 'area-a', minZoom: 6, maxZoom: 14, featureCount: 8 },
    { category: 'area-b', minZoom: 8, maxZoom: 14, featureCount: 4 },
    { category: 'landmark', minZoom: 6, maxZoom: 14, featureCount: 42 },
  ],
  licences: [
    { id: 'cc-by-nc-sa-4.0', attribution: '© Map dataset A contributors · CC BY-NC-SA 4.0' },
    { id: 'nlod-2.0', attribution: '© Map dataset B · NLOD 2.0' },
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
        tiles: ['/test/{z}/{x}/{y}.mvt'],
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
    const built = buildReferenceDatasetLayers(baseManifest, testStyle)
    const ids = built.layers.map(l => l.id)
    expect(ids).toContain('reference:reference-areas:area-a:fill')
    expect(ids).toContain('reference:reference-areas:area-a:line')
    expect(ids).toContain('reference:reference-areas:area-b:fill')
    expect(ids).toContain('reference:reference-areas:area-b:line')
    // Fill layers come before line layers (deterministic ordering for paint stack).
    const areaAFill = ids.indexOf('reference:reference-areas:area-a:fill')
    const areaALine = ids.indexOf('reference:reference-areas:area-a:line')
    expect(areaAFill).toBeLessThan(areaALine)
  })

  test('landmark category emits point + label layers', () => {
    const built = buildReferenceDatasetLayers(baseManifest, testStyle)
    const ids = built.layers.map(l => l.id)
    expect(ids).toContain('reference:reference-areas:landmark:point')
    expect(ids).toContain('reference:reference-areas:landmark:label')
  })

  test('non-landmark categories do not emit point/label layers', () => {
    const built = buildReferenceDatasetLayers(baseManifest, testStyle)
    expect(built.layers.find(l => l.id === 'reference:reference-areas:area-a:point')).toBeUndefined()
    expect(built.layers.find(l => l.id === 'reference:reference-areas:area-b:label')).toBeUndefined()
  })

  test('source tiles use plain HTTP MVT templates', () => {
    const built = buildReferenceDatasetLayers(baseManifest, testStyle)
    expect(built.sourceId).toBe('reference:reference-areas')
    expect(built.source.tiles).toEqual(['/map/datasets/reference-areas/current/reference-areas/{z}/{x}/{y}.mvt'])
    expect(built.source.minzoom).toBe(6)
    expect(built.source.maxzoom).toBe(14)
    expect(built.source.type).toBe('vector')
  })

  test('source attribution composes all licences', () => {
    const built = buildReferenceDatasetLayers(baseManifest, testStyle)
    expect(built.source.attribution).toContain('Map dataset A')
    expect(built.source.attribution).toContain('Map dataset B')
    expect(built.source.attribution).toContain(' • ')
  })

  test('layers carry per-category zoom hints from the manifest', () => {
    const built = buildReferenceDatasetLayers(baseManifest, testStyle)
    const areaAFill = built.layers.find(l => l.id === 'reference:reference-areas:area-a:fill')!
    expect(areaAFill.minzoom).toBe(6)
    expect(areaAFill.maxzoom).toBe(14)
  })

  test('filter on category property', () => {
    const built = buildReferenceDatasetLayers(baseManifest, testStyle)
    const areaAFill = built.layers.find(l => l.id === 'reference:reference-areas:area-a:fill')!
    expect(areaAFill.filter).toEqual(['==', ['get', 'category'], 'area-a'])
  })

  test('unknown category falls back to default style without throwing', () => {
    const manifest: DatasetManifestForLayers = {
      ...baseManifest,
      categories: [{ category: 'something-novel', minZoom: 5, maxZoom: 12, featureCount: 1 }],
    }
    const built = buildReferenceDatasetLayers(manifest, testStyle)
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
    const built = buildReferenceDatasetLayers(manifest, testStyle)
    const ids = built.layers.map(l => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('reference-layer-factory internals', () => {
  test('layerIdFor encodes dataset + category + kind', () => {
    expect(__internals.layerIdFor('reference-areas', 'area-a', 'fill')).toBe('reference:reference-areas:area-a:fill')
  })

  test('sourceTilesFor builds the API-served MVT tile template', () => {
    expect(__internals.sourceTilesFor('foo', 'foo.pmtiles')).toEqual(['/map/datasets/foo/current/foo/{z}/{x}/{y}.mvt'])
  })

  test('categoryFilter is the canonical MapLibre expression', () => {
    expect(__internals.categoryFilter('exclusion')).toEqual(['==', ['get', 'category'], 'exclusion'])
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
      outputLayer: 'areas',
      fillFor: () => ({ 'fill-color': '#000', 'fill-opacity': 0.1 }),
      lineFor: () => ({ 'line-color': '#000', 'line-width': 1 }),
    }
    const built = buildReferenceDatasetLayers(baseManifest, minimalStyle)
    // No point/label layers since the minimal style omits those callbacks.
    expect(built.layers.find(l => l.type === 'circle')).toBeUndefined()
    expect(built.layers.find(l => l.type === 'symbol')).toBeUndefined()
  })
})
