import { geoPointFromLonLat, type IsoTimestamp, type OperationalObject } from '../../core/model/index.ts'
import type { PackScenarioSupport } from '../../core/packs/protocol.ts'
import { createWeatherField, sampleWeather, setWeatherObjects } from './cell-field.ts'
import {
  weatherAreaSchema,
  weatherProbeSchema,
  weatherItemSchema,
  weatherPackConfigSchema,
  type WeatherConfig,
  type WeatherItem,
} from './model.ts'
import { weatherSimPackId, weatherSimAdapterId } from './sim/constants.ts'
export { weatherPackConfigSchema } from './model.ts'

export const createWeatherObject = (item: WeatherItem, at: IsoTimestamp, config: WeatherConfig): OperationalObject => {
  const definition = weatherItemSchema.parse(item)
  const coordinates = definition.type === 'weather_area' ? definition.center : definition.point
  const point = geoPointFromLonLat(...coordinates)
  const field = createWeatherField(config, at)
  return {
    id: definition.id,
    kind: definition.type === 'weather_area' ? 'zone' : 'observation',
    packId: weatherSimPackId,
    label: definition.label,
    lifecycle: 'active',
    revision: 0,
    spatial: { position: { point, observedAt: at, staleAfterMs: 600000 }, frame: { kind: 'wgs84' } },
    operational: { status: 'active', priority: 'low', mode: 'simulated' },
    alerts: [],
    provenance: { source: 'simulator', adapterId: weatherSimAdapterId, externalId: definition.id },
    timestamps: { createdAt: at, updatedAt: at },
    packData: { definition, startsAt: at, sample: sampleWeather(field, point) },
  }
}
export const weatherScenarioSupport: PackScenarioSupport = {
  validateInitialObjects: (objects, config, at) =>
    setWeatherObjects(createWeatherField(weatherPackConfigSchema.parse(config), at), objects),
  itemSchemas: { weather_area: weatherAreaSchema, weather_probe: weatherProbeSchema },
  expandItem: (raw, context) => ({
    objects: [
      createWeatherObject(
        weatherItemSchema.parse(raw),
        context.at,
        weatherPackConfigSchema.parse(context.packConfigs.weather),
      ),
    ],
  }),
}
