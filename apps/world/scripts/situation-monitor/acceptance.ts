import source from '../../src/scenarios/norway-situation-monitor.scenario.json'
import { situationConfigSchema } from '../../src/packs/situation-monitor/model.ts'
import { sourceRequestUrl } from '../../src/packs/situation-monitor/adapters/catalog.ts'
import { decodeSource } from '../../src/packs/situation-monitor/adapters/decode.ts'
import { publicHttp } from '../../src/packs/situation-monitor/ingestion/public-http.ts'
import { openRecordStore } from '../../src/packs/situation-monitor/ingestion/store.ts'

// Explicit live-provider acceptance, not a network-dependent unit test or a runtime source list.
const config = situationConfigSchema.parse(source.packs[0]!.config), store = openRecordStore(':memory:')
try {
  for (const item of config.sources) {
    const start = performance.now(), response = await publicHttp(sourceRequestUrl(item))
    if (response.status !== 200) throw new Error(`${item.id}: HTTP ${response.status}`)
    const records = decodeSource(item, response.text, new Date().toISOString())
    if (new Set(records.map(record => record.id)).size !== records.length) throw new Error(`${item.id}: Duplicate provider record IDs`)
    store.replace(item.id, records, item.retentionHours)
    console.log(JSON.stringify({ source: item.id, records: records.length, bytes: Buffer.byteLength(response.text), ms: Math.round(performance.now() - start), images: records.filter(record => record.media.some(media => media.format === 'image')).length, streams: records.filter(record => record.media.some(media => media.format === 'hls')).length, sample: records[0]?.title }))
  }
} finally { store.close() }
