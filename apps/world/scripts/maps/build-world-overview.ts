import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { $ } from 'bun'
import { PMTiles, TileType } from 'pmtiles'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'

// Original provider data, public domain. Deliberately coarse global context, not routing or street detail.
// Pin inputs for reproducible builds; updating this revision is an explicit data-publication decision.
const revision = 'ca96624a56bd078437bca8184e78163e5039ad19'
const destination = process.argv[2]
if (!destination) throw new Error('Usage: bun scripts/maps/build-world-overview.ts <output-directory>')
const root = resolve(destination)
await mkdir(root, { recursive: true })
const scratch = await mkdtemp(join(root, '.build-'))
try {
  const load = async (name: string) => {
    const url = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${revision}/geojson/${name}.geojson`
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok || !response.body) throw new Error(`Natural Earth download failed: ${response.status}`)
    const chunks: Uint8Array[] = []; let bytes = 0
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 32 * 1024 ** 2) throw new Error('Natural Earth source exceeds download budget'); chunks.push(chunk) }
    const data = JSON.parse(Buffer.concat(chunks).toString()) as { type: string; features: { type: string; geometry: unknown; properties: Record<string, unknown> }[] }
    if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('Invalid Natural Earth feature collection')
    return data.features
  }
  const [countries, cities] = await Promise.all([load('ne_50m_admin_0_countries'), load('ne_50m_populated_places_simple')])
  await Bun.write(join(scratch, 'countries.geojson'), JSON.stringify({ type: 'FeatureCollection', features: countries.map(feature => ({ type: 'Feature', geometry: feature.geometry, properties: { name: feature.properties.NAME_EN ?? feature.properties.NAME } })) }))
  const places = [
    ...countries.flatMap(feature => typeof feature.properties.LABEL_X === 'number' && typeof feature.properties.LABEL_Y === 'number' ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [feature.properties.LABEL_X, feature.properties.LABEL_Y] }, properties: { name: feature.properties.NAME_EN ?? feature.properties.NAME, kind: 'country' } }] : []),
    ...cities.map(feature => ({ type: 'Feature', geometry: feature.geometry, properties: { name: feature.properties.name, kind: 'city' } })),
  ]
  await Bun.write(join(scratch, 'places.geojson'), JSON.stringify({ type: 'FeatureCollection', features: places }))
  const output = join(scratch, 'overview.pmtiles')
  // This small reference layer retains its labels; MapLibre declutters them.
  await $`tippecanoe --output=${output} --minimum-zoom=0 --maximum-zoom=6 --simplification=4 --drop-rate=1 --maximum-tile-bytes=500000 --named-layer=countries:${join(scratch, 'countries.geojson')} --named-layer=places:${join(scratch, 'places.geojson')}`.quiet()
  const file = Bun.file(output)
  if (file.size > 32 * 1024 ** 2) throw new Error('World overview exceeds 32 MiB artifact budget')
  const archive = new PMTiles({ getKey: () => output, getBytes: async (offset, length) => ({ data: await file.slice(offset, offset + length).arrayBuffer() }) })
  const header = await archive.getHeader()
  if (header.tileType !== TileType.Mvt || !await archive.getZxy(0,0,0)) throw new Error('Invalid overview PMTiles')
  const metadata = await archive.getMetadata() as { vector_layers?: { id: string }[] }
  if (!['countries', 'places'].every(id => metadata.vector_layers?.some(layer => layer.id === id))) throw new Error('Overview must retain separate country geometry and place-label layers')
  const worldTile = new VectorTile(new PbfReader(new Uint8Array((await archive.getZxy(0,0,0))!.data)))
  if ((worldTile.layers.places?.length ?? 0) < 50) throw new Error('Overview country labels were unexpectedly thinned')
  await Bun.write(join(root, 'build.json'), JSON.stringify({ builtAt: new Date().toISOString(), provider: 'Natural Earth', license: 'Public domain', sourceRevision: revision, bytes: file.size, minZoom: header.minZoom, maxZoom: header.maxZoom }, null, 2))
  await rename(output, join(root, 'current.pmtiles'))
  console.log(`Published global overview: ${file.size} bytes at ${root}`)
} finally { await rm(scratch, { recursive: true, force: true }) }
