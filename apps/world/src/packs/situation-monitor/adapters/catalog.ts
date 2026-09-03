import { situationSourceSchema, type SituationSource } from '../model.ts'
export const sourceAdapters = [
  { id: 'rss', title: 'RSS / Atom', description: 'Headlines and permitted feed excerpts. Stories without locations remain in the list.', modalities: ['report'], minimumIntervalSeconds: 60, defaultParameters: { url: '' } },
  { id: 'geojson', title: 'GeoJSON', description: 'Points, lines and areas. Configure JSON Pointers (including array indices and literal dots) for title, time, ID and original link.', modalities: ['feature'], minimumIntervalSeconds: 60, defaultParameters: { url: '', mapping: { id: '/id', title: '/properties/title', time: '/properties/time', url: '/properties/url' } } },
  { id: 'usgs', title: 'USGS earthquakes', description: 'Global earthquake reports with magnitude, depth and upstream update time. These are reported events, not simulated damage.', modalities: ['event'], minimumIntervalSeconds: 60, defaultParameters: { url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson' } },
  { id: 'met-forecast', title: 'MET Norway location forecast', description: 'Forecast for a configured point worldwide; coverage, model resolution and valid times vary. Does not drive Weather simulation.', modalities: ['forecast'], minimumIntervalSeconds: 600, defaultParameters: { point: [0, 0] } },
  { id: 'met-alerts', title: 'MET Norway warnings', description: 'Current warning polygons, severity, validity, consequences and advice from MET. Provider warnings, not simulated weather.', modalities: ['event'], minimumIntervalSeconds: 600, defaultParameters: { url: 'https://api.met.no/weatherapi/metalerts/2.0/current.json?lang=no' } },
  { id: 'vegvesen', title: 'Norwegian roads · live catalogues', description: 'Discover cameras (published still images and HLS), observed road weather, or traffic incidents from Statens vegvesen. One source collects a complete bounded catalogue; no hardcoded camera or station list.', modalities: ['media', 'observation', 'event'], minimumIntervalSeconds: 300, defaultParameters: { url: 'https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/ows', dataset: 'cameras' } },
  { id: 'media', title: 'Image / video / audio', description: 'On-demand provider image, embed or media playback. No server recording, transcoding or automatic AI video access.', modalities: ['media'], minimumIntervalSeconds: 3600, defaultParameters: { url: '', format: 'video' } },
] as const
export const describeSourceAdapters = () => sourceAdapters.map(adapter => ({ ...adapter, schema: situationSourceSchema.options.find(schema => schema.shape.adapter.value === adapter.id)!.toJSONSchema() }))
export const minimumIntervalFor = (source: SituationSource): number => sourceAdapters.find(adapter => adapter.id === source.adapter)!.minimumIntervalSeconds
// These are provider formats, not instances. Camera/station/incident identities come from the live catalogue.
export const roadDatasets = [
  { id: 'cameras', typeName: 'datex_3_1:CctvSimple', title: 'Cameras', icon: 'cctv' },
  { id: 'road-weather', typeName: 'datex_3_1:WeatherSimple_v2', title: 'Road weather observations', icon: 'thermometer' },
  { id: 'traffic', typeName: 'datex_3_1:SituationSimple_v2', title: 'Traffic and roadworks', icon: 'construction' },
] as const
export const sourceRequestUrl = (source: SituationSource): string => {
  if (source.adapter === 'met-forecast') return 'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=' + source.point[1].toFixed(4) + '&lon=' + source.point[0].toFixed(4)
  if (source.adapter !== 'vegvesen') return source.url
  const url = new URL(source.url)
  for (const [key, value] of Object.entries({ service: 'WFS', version: '1.0.0', request: 'GetFeature', outputFormat: 'application/json', srsName: 'EPSG:4326', typeName: roadDatasets.find(item => item.id === source.dataset)!.typeName, maxFeatures: '10000' })) url.searchParams.set(key, value)
  // The provider publishes a display point separately from potentially enormous road polylines.
  // Request the useful national incident summary, not a bulk geometry export.
  if (source.dataset === 'traffic') url.searchParams.set('propertyName', ['RECORD_ID','SITUATION_ID','LOCATION_DESCRIPTION','DESCRIPTION','ROAD_NUMBER','SITUATION_TYPE','SECONDARY_TYPES','SEVERITY','ACTIVE','NUM_PERIODS','CREATION_DATE','LAST_UPDATE_TIME','START_TIME','END_TIME','COORDINATES_FOR_DISPLAY_LONGITUDE','COORDINATES_FOR_DISPLAY_LATITUDE'].join(','))
  if (source.bounds) url.searchParams.set('bbox', source.bounds.join(',') + ',EPSG:4326')
  return url.href
}
