import type { IsoTimestamp } from '../../core/model/index.ts'
import type { WeatherAtmosphere, WeatherSurface } from './model.ts'

export const defaultAtmosphere = (_at: IsoTimestamp): WeatherAtmosphere => ({
  airTemperatureC: 8,
  humidity: 0.65,
  windSpeedMps: 3,
  windDirectionDeg: 240,
  visibilityM: 12000,
  cloudCover: 0.45,
  precipitation: { type: 'none', intensityMmPerHour: 0 },
  labels: ['calm'],
})

export const defaultSurface = (): WeatherSurface => ({
  groundTemperatureC: 8,
  wetness: 0,
  standingWater: 0,
  snow: 0,
  ice: 0,
  frost: 0,
  frictionEstimate: 1,
  frictionClass: 'normal',
  labels: ['dry'],
})
