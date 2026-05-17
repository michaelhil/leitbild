import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMapCapabilityManifest, mapCapabilityManifestSchema } from '../src/map/capabilities.ts'
import { currentPmtilesResponse } from '../src/map/artifacts.ts'
import { createLeitbildMapStyle } from '../src/map/style.ts'

describe('vector map artifacts', () => {
  test('declares the canonical vector tile capabilities', () => {
    const manifest = mapCapabilityManifestSchema.parse(createMapCapabilityManifest())

    expect(manifest.artifact.format).toBe('pmtiles')
    expect(manifest.artifact.currentTileUrl).toBe('/map/tiles/current.pmtiles')
    expect(manifest.layers.map(layer => layer.id)).toContain('transportation')
    expect(manifest.layers.map(layer => layer.id)).toContain('poi')
    expect(manifest.layers.map(layer => layer.id)).toContain('landuse')
  })

  test('style uses only the self-hosted PMTiles vector source', () => {
    const style = createLeitbildMapStyle()

    expect(style.sources['leitbild-osm']).toEqual({
      type: 'vector',
      url: 'pmtiles:///map/tiles/current.pmtiles',
      attribution: '© OpenStreetMap contributors © OpenMapTiles',
    })
    expect(JSON.stringify(style)).not.toContain('"raster"')
    expect(style.glyphs).toBe('/map/fonts/{fontstack}/{range}.pbf')
  })

  test('PMTiles serving supports byte ranges and fails visibly when missing', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'leitbild-map-test-'))
    const currentDir = join(rootDir, 'current')
    await mkdir(currentDir)
    await Bun.write(join(currentDir, 'norway.pmtiles'), '0123456789')

    const rangeResponse = await currentPmtilesResponse(new Request('http://localhost/map/tiles/current.pmtiles', {
      headers: { range: 'bytes=2-5' },
    }), { rootDir })
    expect(rangeResponse.status).toBe(206)
    expect(rangeResponse.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await rangeResponse.text()).toBe('2345')

    const missingResponse = await currentPmtilesResponse(new Request('http://localhost/map/tiles/current.pmtiles'), {
      rootDir: join(rootDir, 'missing'),
    })
    expect(missingResponse.status).toBe(503)
    expect(await missingResponse.json()).toMatchObject({ ok: false, error: 'vector map artifact unavailable' })
  })
})
