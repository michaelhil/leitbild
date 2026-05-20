import type { GeoJsonPoint, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { weatherDomainDataSchema, type WeatherAtmosphere, type WeatherDomainData, type WeatherEvolution, type WeatherSample, type WeatherSurface } from './model.ts'
import { defaultAtmosphere, defaultSurface } from './defaults.ts'
import { weatherSampleAtPointFromField } from './field.ts'

export { defaultAtmosphere, defaultSurface } from './defaults.ts'

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const clamp01 = (value: number): number => clamp(value, 0, 1)

const lerp = (from: number, to: number, fraction: number): number =>
  from + (to - from) * fraction

const surfaceEpsilon = 0.005

const fractionFor = (evolution: WeatherEvolution, at: IsoTimestamp): number => {
  const start = Date.parse(evolution.startsAt)
  const end = Date.parse(evolution.endsAt)
  if (end <= start) return 1
  return clamp((Date.parse(at) - start) / (end - start), 0, 1)
}

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
  evolution: WeatherEvolution | undefined,
  at: IsoTimestamp,
): WeatherAtmosphere => {
  if (!evolution) return atmosphere
  const fraction = fractionFor(evolution, at)
  return {
    ...atmosphere,
    airTemperatureC: evolution.airTemperatureC ? lerp(evolution.airTemperatureC.from, evolution.airTemperatureC.to, fraction) : atmosphere.airTemperatureC,
    humidity: evolution.humidity ? clamp01(lerp(evolution.humidity.from, evolution.humidity.to, fraction)) : atmosphere.humidity,
    windSpeedMps: evolution.windSpeedMps ? Math.max(0, lerp(evolution.windSpeedMps.from, evolution.windSpeedMps.to, fraction)) : atmosphere.windSpeedMps,
    visibilityM: evolution.visibilityM ? Math.max(0, lerp(evolution.visibilityM.from, evolution.visibilityM.to, fraction)) : atmosphere.visibilityM,
    cloudCover: evolution.cloudCover ? clamp01(lerp(evolution.cloudCover.from, evolution.cloudCover.to, fraction)) : atmosphere.cloudCover,
    precipitation: {
      type: evolution.precipitation?.type ?? atmosphere.precipitation.type,
      intensityMmPerHour: evolution.precipitation?.intensityMmPerHour
        ? Math.max(0, lerp(evolution.precipitation.intensityMmPerHour.from, evolution.precipitation.intensityMmPerHour.to, fraction))
        : atmosphere.precipitation.intensityMmPerHour,
    },
  }
}

export const evolveSurface = (config: {
  readonly surface: WeatherSurface
  readonly atmosphere: WeatherAtmosphere
  readonly evolution?: WeatherEvolution
  readonly at: IsoTimestamp
  readonly elapsedSeconds: number
}): WeatherSurface => {
  const dtMinutes = Math.max(0, config.elapsedSeconds / 60)
  const targetGroundTemperature = config.evolution?.groundTemperatureC
    ? lerp(config.evolution.groundTemperatureC.from, config.evolution.groundTemperatureC.to, fractionFor(config.evolution, config.at))
    : config.atmosphere.airTemperatureC
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

  const blackIceRisk = clamp01(ice + (groundTemperatureC < 0 && wetness > 0.1 ? wetness * 0.7 : 0))
  const frictionEstimate = clamp01(1 - Math.max(wetness * 0.25, snow * 0.55, blackIceRisk * 0.8, standingWater * 0.35))
  const frictionClass = blackIceRisk > 0.65
    ? 'icy'
    : snow > 0.45 || blackIceRisk > 0.35
      ? 'slippery'
      : wetness > 0.2 || standingWater > 0.15
        ? 'wet'
        : 'normal'
  const labels = [
    ...(wetness > 0.2 ? ['wet'] : []),
    ...(standingWater > 0.2 ? ['standing-water'] : []),
    ...(snow > 0.2 ? ['snow'] : []),
    ...(blackIceRisk > 0.35 ? ['black-ice-risk'] : []),
    ...(frost > 0.25 ? ['frost'] : []),
    ...(wetness <= 0.2 && snow <= 0.2 && blackIceRisk <= 0.35 ? ['dry'] : []),
  ]

  return {
    groundTemperatureC,
    wetness,
    standingWater,
    snow,
    ice,
    frost,
    frictionEstimate,
    frictionClass,
    labels,
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
  readonly evolution?: WeatherEvolution
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
  const atmosphere = deriveAtmosphere(data.atmosphere, data.evolution, at)
  const surface = evolveSurface({
    surface: data.surface,
    atmosphere,
    at,
    elapsedSeconds,
    ...(data.evolution ? { evolution: data.evolution } : {}),
  })
  const labels = [
    ...(atmosphere.precipitation.type !== 'none' ? [atmosphere.precipitation.type.replaceAll('_', '-')] : []),
    ...(atmosphere.visibilityM < 2000 ? ['low-visibility'] : []),
    ...(atmosphere.windSpeedMps > 10 ? ['windy'] : []),
    ...(atmosphere.cloudCover !== undefined && atmosphere.cloudCover > 0.7 ? ['cloudy'] : []),
  ]
  return {
    ...data,
    atmosphere: { ...atmosphere, labels: labels.length > 0 ? labels : ['fair'] },
    surface,
    severity: surface.frictionClass === 'icy' || atmosphere.visibilityM < 800
      ? 'hazard'
      : surface.frictionClass === 'slippery' || atmosphere.visibilityM < 2000
        ? 'adverse'
        : atmosphere.precipitation.type !== 'none' || surface.frictionClass === 'wet'
          ? 'notice'
          : 'normal',
    quality: { ...data.quality, validAt: at },
  }
}

export const weatherSampleAtPoint = (
  objects: ReadonlyArray<OperationalObject>,
  point: GeoJsonPoint,
  at: IsoTimestamp,
): WeatherSample => weatherSampleAtPointFromField(objects, point, at)
