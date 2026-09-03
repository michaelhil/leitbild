import { situationSourceSchema, type SituationSource } from '../model.ts'
export const sourceAdapters = [
  { id: 'rss', title: 'RSS / Atom', description: 'Headlines and permitted feed excerpts. Stories without locations remain in the list.', modalities: ['report'], minimumIntervalSeconds: 60, defaultParameters: { url: '' } },
  { id: 'geojson', title: 'GeoJSON', description: 'Points, lines and areas. Configure property paths for title, time, ID and original link. Unsupported records are reported.', modalities: ['feature'], minimumIntervalSeconds: 60, defaultParameters: { url: '', mapping: { id: 'id', title: 'properties.title', time: 'properties.time', url: 'properties.url' } } },
  { id: 'usgs', title: 'USGS earthquakes', description: 'Global earthquake reports with magnitude, depth and upstream update time. These are reported events, not simulated damage.', modalities: ['event'], minimumIntervalSeconds: 60, defaultParameters: { url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson' } },
  { id: 'met-forecast', title: 'MET Norway location forecast', description: 'Forecast for a configured point worldwide; coverage, model resolution and valid times vary. Does not drive Weather simulation.', modalities: ['forecast'], minimumIntervalSeconds: 600, defaultParameters: { point: [0, 0] } },
  { id: 'media', title: 'Video / audio', description: 'On-demand provider embed or media playback. No server recording, transcoding or automatic AI video access.', modalities: ['media'], minimumIntervalSeconds: 3600, defaultParameters: { url: '', format: 'video' } },
] as const
export const describeSourceAdapters = () => sourceAdapters.map(adapter => ({ ...adapter, schema: situationSourceSchema.options.find(schema => schema.shape.adapter.value === adapter.id)!.toJSONSchema() }))
export const minimumIntervalFor = (source: SituationSource): number => sourceAdapters.find(adapter => adapter.id === source.adapter)!.minimumIntervalSeconds
export const sourceRequestUrl = (source: SituationSource): string => source.adapter === 'met-forecast'
  ? 'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=' + source.point[1].toFixed(4) + '&lon=' + source.point[0].toFixed(4)
  : source.url
