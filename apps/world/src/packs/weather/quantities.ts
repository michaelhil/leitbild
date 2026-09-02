import type { WeatherState } from './model.ts'

/** One list feeds discovery, object inspection and optional probe recordings. */
export const weatherQuantities: ReadonlyArray<{
  id: string
  title: string
  unit: string
  value: (state: WeatherState) => number | string
}> = [
  { id: 'airTemperatureC', title: 'Air temperature', unit: '°C', value: (s) => s.atmosphere.airTemperatureC },
  { id: 'humidity', title: 'Humidity', unit: 'fraction', value: (s) => s.atmosphere.humidity },
  { id: 'windSpeedMps', title: 'Wind speed', unit: 'm/s', value: (s) => s.atmosphere.windSpeedMps },
  {
    id: 'windDirectionDeg',
    title: 'Wind direction',
    unit: 'degrees FROM north',
    value: (s) => s.atmosphere.windDirectionDeg,
  },
  { id: 'visibilityM', title: 'Visibility', unit: 'm', value: (s) => s.atmosphere.visibilityM },
  { id: 'cloudCover', title: 'Cloud cover', unit: 'fraction', value: (s) => s.atmosphere.cloudCover },
  { id: 'precipitationType', title: 'Precipitation', unit: '', value: (s) => s.atmosphere.precipitation.type },
  {
    id: 'intensityMmPerHour',
    title: 'Precipitation rate',
    unit: 'mm/h',
    value: (s) => s.atmosphere.precipitation.intensityMmPerHour,
  },
  { id: 'groundTemperatureC', title: 'Ground temperature', unit: '°C', value: (s) => s.surface.groundTemperatureC },
  ...(['wetness', 'standingWater', 'snow', 'ice', 'frost'] as const).map((id) => ({
    id,
    title: id,
    unit: 'fraction',
    value: (s: WeatherState) => s.surface[id],
  })),
]
export const weatherRecordingProfiles = [
  {
    id: 'probes',
    title: 'Weather probes',
    description: 'Record atmospheric and ground quantities at explicit probes only; no whole-grid logging.',
    defaultIntervalMs: 5000,
    minimumIntervalMs: 1000,
  },
]
