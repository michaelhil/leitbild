import type { GeoJsonPoint, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { type WeatherAtmosphere, type WeatherDomainData, type WeatherSample, type WeatherSurface } from './model.ts'
import { defaultAtmosphere, defaultSurface } from './defaults.ts'
import { weatherSampleAtPointFromField } from './field.ts'

export { defaultAtmosphere, defaultSurface } from './defaults.ts'

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const clamp01 = (value: number): number => clamp(value, 0, 1)

const surfaceEpsilon = 0.005

const precipitationAddsWetness = (type: string): boolean =>
  type === 'rain' || type === 'freezing_rain' || type === 'sleet' || type === 'hail'

const precipitationAddsSnow = (type: string): boolean =>
  type === 'snow' || type === 'sleet'

export const surfaceDeltaFromDefault = (
  surface: WeatherSurface,
  defaultValue: WeatherSurface = defaultSurface(),
): number => Math.max(
  Math.abs(surface.groundTemperatureC - defaultValue.groundTemperatureC) / 40,
  Math.abs(surface.wetness - defaultValue.wetness),
  Math.abs(surface.standingWater - defaultValue.standingWater),
  Math.abs(surface.snow - defaultValue.snow),
  Math.abs(surface.ice - defaultValue.ice),
  Math.abs(surface.frost - defaultValue.frost),
)

export const surfaceIsDefaultLike = (
  surface: WeatherSurface,
  defaultValue: WeatherSurface = defaultSurface(),
): boolean => surfaceDeltaFromDefault(surface, defaultValue) <= surfaceEpsilon

export const deriveAtmosphere = (
  atmosphere: WeatherAtmosphere,
  _at: IsoTimestamp,
): WeatherAtmosphere => {
  return atmosphere
}

export const evolveSurface = (config: {
  readonly surface: WeatherSurface
  readonly atmosphere: WeatherAtmosphere
  readonly at: IsoTimestamp
  readonly elapsedSeconds: number
}): WeatherSurface => {
  const dtMinutes = Math.max(0, config.elapsedSeconds / 60)
  const targetGroundTemperature = config.atmosphere.airTemperatureC
  const groundTemperatureC = config.surface.groundTemperatureC + (targetGroundTemperature - config.surface.groundTemperatureC) * clamp01(dtMinutes / 20)
  const precipitation = config.atmosphere.precipitation
  const precipitationAmount = precipitation.intensityMmPerHour * dtMinutes / 60
  let wetness = config.surface.wetness
  let standingWater = config.surface.standingWater
  let snow = config.surface.snow
  let ice = config.surface.ice
  let frost = config.surface.frost

  if (precipitationAddsWetness(precipitation.type)) {
    wetness = clamp01(wetness + precipitationAmount / 4)
    standingWater = clamp01(standingWater + precipitationAmount / 12)
  }
  if (precipitationAddsSnow(precipitation.type)) {
    snow = clamp01(snow + precipitationAmount / 5)
  }

  if (groundTemperatureC < 0) {
    const freeze = clamp01((-groundTemperatureC / 8) * wetness * dtMinutes * 0.12)
    wetness = clamp01(wetness - freeze)
    standingWater = clamp01(standingWater - freeze * 0.6)
    ice = clamp01(ice + freeze)
    frost = clamp01(frost + (-groundTemperatureC / 12) * dtMinutes * 0.03)
  } else {
    const melt = clamp01((groundTemperatureC / 8) * dtMinutes * 0.08)
    const snowMelt = Math.min(snow, melt)
    const iceMelt = Math.min(ice, melt * 0.65)
    snow = clamp01(snow - snowMelt)
    ice = clamp01(ice - iceMelt)
    wetness = clamp01(wetness + snowMelt * 0.55 + iceMelt * 0.7)
    frost = clamp01(frost - melt)
  }

  if (precipitation.intensityMmPerHour === 0) {
    const drying = clamp01((Math.max(0, groundTemperatureC) / 20 + Math.min(config.atmosphere.windSpeedMps, 12) / 30) * dtMinutes * 0.08)
    wetness = clamp01(wetness - drying)
    standingWater = clamp01(standingWater - drying * 0.7)
  }

  return {
    groundTemperatureC,
    wetness,
    standingWater,
    snow,
    ice,
    frost,
  }
}

export const surfaceEvolutionResidual = (config: {
  readonly previous: WeatherSurface
  readonly next: WeatherSurface
  readonly defaultSurface?: WeatherSurface
  readonly atmosphere: WeatherAtmosphere
}): number => {
  const stepDelta = Math.max(
    Math.abs(config.next.groundTemperatureC - config.previous.groundTemperatureC) / 40,
    Math.abs(config.next.wetness - config.previous.wetness),
    Math.abs(config.next.standingWater - config.previous.standingWater),
    Math.abs(config.next.snow - config.previous.snow),
    Math.abs(config.next.ice - config.previous.ice),
    Math.abs(config.next.frost - config.previous.frost),
  )
  const precipitationForcing = config.atmosphere.precipitation.intensityMmPerHour > 0 ? 1 : 0
  const freezePotential = config.next.groundTemperatureC < 0 && (config.next.wetness > surfaceEpsilon || config.next.standingWater > surfaceEpsilon) ? 1 : 0
  const meltPotential = config.next.groundTemperatureC > 0 && (config.next.snow > surfaceEpsilon || config.next.ice > surfaceEpsilon || config.next.frost > surfaceEpsilon) ? 1 : 0
  const dryingPotential = config.atmosphere.precipitation.intensityMmPerHour === 0 && config.next.groundTemperatureC > 0 && (config.next.wetness > surfaceEpsilon || config.next.standingWater > surfaceEpsilon) ? 1 : 0
  return Math.max(stepDelta, precipitationForcing, freezePotential, meltPotential, dryingPotential)
}

export const evolveSurfaceWithResidual = (config: {
  readonly surface: WeatherSurface
  readonly atmosphere: WeatherAtmosphere
  readonly at: IsoTimestamp
  readonly elapsedSeconds: number
  readonly defaultSurface?: WeatherSurface
}): {
  readonly surface: WeatherSurface
  readonly residual: number
  readonly defaultLike: boolean
} => {
  const next = evolveSurface(config)
  const defaultValue = config.defaultSurface ?? defaultSurface()
  return {
    surface: next,
    residual: surfaceEvolutionResidual({
      previous: config.surface,
      next,
      defaultSurface: defaultValue,
      atmosphere: config.atmosphere,
    }),
    defaultLike: surfaceIsDefaultLike(next, defaultValue),
  }
}

export const evolveWeatherData = (
  data: WeatherDomainData,
  at: IsoTimestamp,
  elapsedSeconds: number,
): WeatherDomainData => {
  const atmosphere = deriveAtmosphere(data.state.atmosphere, at)
  const surface = evolveSurface({
    surface: data.state.surface,
    atmosphere,
    at,
    elapsedSeconds,
  })
  return {
    ...data,
    state: {
      atmosphere,
      surface,
      extensions: data.state.extensions,
    },
    quality: { ...data.quality, validAt: at },
  }
}

export const weatherSampleAtPoint = (
  objects: ReadonlyArray<OperationalObject>,
  point: GeoJsonPoint,
  at: IsoTimestamp,
): WeatherSample => weatherSampleAtPointFromField(objects, point, at)
