import type { GeoJsonPoint, GeoJsonPolygon, IsoTimestamp, ObjectId, OperationalObject } from '../../core/model/index.ts'
import { geoPointFromLonLat } from '../../core/model/index.ts'
import {
  type WeatherAtmosphere,
  type WeatherDomainData,
  type WeatherExtensions,
  type WeatherFalloffCurve,
  type WeatherInfluenceKeyframe,
  type WeatherState,
  type WeatherSurface,
  weatherDomainDataSchema,
} from './model.ts'

const metersPerDegreeLatitude = 111_320

interface LocalPoint {
  readonly x: number
  readonly y: number
}

export interface WeatherInfluenceEntry {
  readonly objectId: ObjectId
  readonly label: string
  readonly priority: number
  readonly frame: WeatherInfluenceKeyframe
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

export const clamp01 = (value: number): number => clamp(value, 0, 1)

export const lerp = (from: number, to: number, fraction: number): number =>
  from + (to - from) * fraction

const normalizeDeg = (value: number): number =>
  ((value % 360) + 360) % 360

const lerpAngleDeg = (from: number, to: number, fraction: number): number => {
  const delta = ((to - from + 540) % 360) - 180
  return normalizeDeg(from + delta * fraction)
}

const metersPerDegreeLongitude = (latitudeDeg: number): number =>
  Math.max(1, metersPerDegreeLatitude * Math.cos(latitudeDeg * Math.PI / 180))

const toLocalPoint = (
  point: GeoJsonPoint,
  referenceLatitude: number,
): LocalPoint => ({
  x: point.coordinates[0] * metersPerDegreeLongitude(referenceLatitude),
  y: point.coordinates[1] * metersPerDegreeLatitude,
})

const fromLocalPoint = (
  point: LocalPoint,
  referenceLatitude: number,
): GeoJsonPoint => geoPointFromLonLat(
  point.x / metersPerDegreeLongitude(referenceLatitude),
  point.y / metersPerDegreeLatitude,
)

export const evaluateWeatherFalloffCurve = (
  curve: WeatherFalloffCurve,
  normalizedDistance: number,
): number => {
  const distance = clamp01(normalizedDistance)
  const first = curve[0]
  const last = curve[curve.length - 1]
  if (!first || !last) throw new Error('weather falloff curve requires points')
  if (distance <= first.x) return first.y
  if (distance >= last.x) return last.y
  for (let index = 1; index < curve.length; index += 1) {
    const previous = curve[index - 1]
    const next = curve[index]
    if (!previous || !next) continue
    if (distance > next.x) continue
    const span = next.x - previous.x
    const fraction = span <= 0 ? 1 : (distance - previous.x) / span
    return clamp01(lerp(previous.y, next.y, fraction))
  }
  return last.y
}

const precipitationTypeFor = (
  current: WeatherAtmosphere['precipitation']['type'],
  target: WeatherAtmosphere['precipitation']['type'],
  weight: number,
): WeatherAtmosphere['precipitation']['type'] =>
  weight >= 0.5 ? target : current

const mixAtmosphere = (current: WeatherAtmosphere, target: WeatherAtmosphere, weight: number): WeatherAtmosphere => ({
  airTemperatureC: lerp(current.airTemperatureC, target.airTemperatureC, weight),
  humidity: current.humidity === undefined && target.humidity === undefined
    ? undefined
    : clamp01(lerp(current.humidity ?? 0, target.humidity ?? 0, weight)),
  windSpeedMps: Math.max(0, lerp(current.windSpeedMps, target.windSpeedMps, weight)),
  windDirectionDeg: lerpAngleDeg(current.windDirectionDeg, target.windDirectionDeg, weight),
  visibilityM: Math.max(0, lerp(current.visibilityM, target.visibilityM, weight)),
  cloudCover: current.cloudCover === undefined && target.cloudCover === undefined
    ? undefined
    : clamp01(lerp(current.cloudCover ?? 0, target.cloudCover ?? 0, weight)),
  precipitation: {
    type: precipitationTypeFor(current.precipitation.type, target.precipitation.type, weight),
    intensityMmPerHour: Math.max(0, lerp(current.precipitation.intensityMmPerHour, target.precipitation.intensityMmPerHour, weight)),
  },
})

const mixSurface = (current: WeatherSurface, target: WeatherSurface, weight: number): WeatherSurface => ({
  groundTemperatureC: lerp(current.groundTemperatureC, target.groundTemperatureC, weight),
  wetness: clamp01(lerp(current.wetness, target.wetness, weight)),
  standingWater: clamp01(lerp(current.standingWater, target.standingWater, weight)),
  snow: clamp01(lerp(current.snow, target.snow, weight)),
  ice: clamp01(lerp(current.ice, target.ice, weight)),
  frost: clamp01(lerp(current.frost, target.frost, weight)),
})

const mixExtensionValue = (
  current: WeatherExtensions[string] | undefined,
  target: WeatherExtensions[string],
  weight: number,
): WeatherExtensions[string] => {
  if (typeof target === 'number') return lerp(typeof current === 'number' ? current : 0, target, weight)
  if (typeof target === 'string') return weight >= 0.5 ? target : (typeof current === 'string' ? current : target)
  if (typeof target === 'boolean') return weight >= 0.5 ? target : (typeof current === 'boolean' ? current : target)
  throw new Error('unsupported weather extension value')
}

const mixExtensions = (
  current: WeatherExtensions,
  target: WeatherExtensions,
  weight: number,
): WeatherExtensions => {
  const mixed: Record<string, WeatherExtensions[string]> = { ...current }
  for (const [key, value] of Object.entries(target)) {
    mixed[key] = mixExtensionValue(current[key], value, weight)
  }
  return mixed
}

export const mixWeatherState = (current: WeatherState, target: WeatherState, weight: number): WeatherState => ({
  atmosphere: mixAtmosphere(current.atmosphere, target.atmosphere, weight),
  surface: mixSurface(current.surface, target.surface, weight),
  extensions: mixExtensions(current.extensions, target.extensions, weight),
})

const interpolateCurve = (
  from: WeatherFalloffCurve,
  to: WeatherFalloffCurve,
  fraction: number,
): WeatherFalloffCurve => {
  if (from.length !== to.length) throw new Error('weather keyframe falloff curves must have the same number of points')
  return from.map((point, index) => {
    const target = to[index]
    if (!target) throw new Error('weather keyframe falloff curve target point missing')
    if (Math.abs(point.x - target.x) > 0.000001) throw new Error('weather keyframe falloff curve x values must match across keyframes')
    return { x: point.x, y: clamp01(lerp(point.y, target.y, fraction)) }
  })
}

export const interpolateWeatherInfluenceFrame = (
  from: WeatherInfluenceKeyframe,
  to: WeatherInfluenceKeyframe,
  fraction: number,
): WeatherInfluenceKeyframe => ({
  atSeconds: lerp(from.atSeconds, to.atSeconds, fraction),
  center: geoPointFromLonLat(
    lerp(from.center.coordinates[0], to.center.coordinates[0], fraction),
    lerp(from.center.coordinates[1], to.center.coordinates[1], fraction),
  ) as WeatherInfluenceKeyframe['center'],
  semiMajorAxisM: lerp(from.semiMajorAxisM, to.semiMajorAxisM, fraction),
  semiMinorAxisM: lerp(from.semiMinorAxisM, to.semiMinorAxisM, fraction),
  rotationDeg: lerpAngleDeg(from.rotationDeg, to.rotationDeg, fraction),
  state: mixWeatherState(from.state, to.state, fraction),
  falloffCurve: interpolateCurve(from.falloffCurve, to.falloffCurve, fraction),
})

export const activeWeatherInfluenceFrameAt = (
  data: WeatherDomainData,
  at: IsoTimestamp,
): WeatherInfluenceKeyframe | null => {
  const influence = data.influence
  if (!influence) return null
  const elapsedSeconds = Math.max(0, (Date.parse(at) - Date.parse(data.quality.validAt)) / 1000)
  const frames = [...influence.keyframes].sort((a, b) => a.atSeconds - b.atSeconds)
  const first = frames[0]
  const last = frames[frames.length - 1]
  if (!first || !last) return null
  if (elapsedSeconds <= first.atSeconds) return first
  if (elapsedSeconds >= last.atSeconds) return last
  const nextIndex = frames.findIndex(frame => frame.atSeconds >= elapsedSeconds)
  const next = frames[nextIndex]
  const previous = frames[nextIndex - 1]
  if (!previous || !next) return first
  const span = next.atSeconds - previous.atSeconds
  const fraction = span <= 0 ? 1 : clamp01((elapsedSeconds - previous.atSeconds) / span)
  return interpolateWeatherInfluenceFrame(previous, next, fraction)
}

export const weatherInfluenceWeightForPoint = (
  point: GeoJsonPoint,
  frame: WeatherInfluenceKeyframe,
): number => {
  const referenceLatitude = frame.center.coordinates[1]
  const localPoint = toLocalPoint(point, referenceLatitude)
  const center = toLocalPoint(frame.center, referenceLatitude)
  const dx = localPoint.x - center.x
  const dy = localPoint.y - center.y
  const angle = -frame.rotationDeg * Math.PI / 180
  const rotatedX = dx * Math.cos(angle) - dy * Math.sin(angle)
  const rotatedY = dx * Math.sin(angle) + dy * Math.cos(angle)
  const normalizedDistance = Math.sqrt(
    (rotatedX / frame.semiMajorAxisM) ** 2 +
    (rotatedY / frame.semiMinorAxisM) ** 2,
  )
  if (normalizedDistance > 1) return 0
  return evaluateWeatherFalloffCurve(frame.falloffCurve, normalizedDistance)
}

export const weatherInfluenceEllipsePolygon = (frame: WeatherInfluenceKeyframe): GeoJsonPolygon => {
  const referenceLatitude = frame.center.coordinates[1]
  const center = toLocalPoint(frame.center, referenceLatitude)
  const angle = frame.rotationDeg * Math.PI / 180
  const pointCount = 72
  const coordinates = Array.from({ length: pointCount }, (_, index) => {
    const theta = (Math.PI * 2 * index) / pointCount
    const localX = Math.cos(theta) * frame.semiMajorAxisM
    const localY = Math.sin(theta) * frame.semiMinorAxisM
    const rotatedX = localX * Math.cos(angle) - localY * Math.sin(angle)
    const rotatedY = localX * Math.sin(angle) + localY * Math.cos(angle)
    return fromLocalPoint({
      x: center.x + rotatedX,
      y: center.y + rotatedY,
    }, referenceLatitude).coordinates
  })
  const first = coordinates[0]
  if (!first) throw new Error('weather influence polygon generation produced no coordinates')
  return { type: 'Polygon', coordinates: [[...coordinates, first]] }
}

export const activeWeatherInfluencesAt = (
  objects: ReadonlyArray<OperationalObject>,
  at: IsoTimestamp,
): ReadonlyArray<WeatherInfluenceEntry> =>
  objects.flatMap(object => {
    const parsed = weatherDomainDataSchema.safeParse(object.domainData)
    if (!parsed.success || parsed.data.conditionKind !== 'weather_influence' || !parsed.data.influence) return []
    const frame = activeWeatherInfluenceFrameAt(parsed.data, at)
    if (!frame) return []
    return [{
      objectId: object.id,
      label: object.label,
      priority: parsed.data.influence.priority,
      frame,
    }]
  }).sort((left, right) => (left.priority - right.priority) || left.objectId.localeCompare(right.objectId))

export const weatherObjectCurrentCenter = (
  data: WeatherDomainData,
  at: IsoTimestamp,
): GeoJsonPoint | null =>
  activeWeatherInfluenceFrameAt(data, at)?.center ?? null

export const weatherDataAtTime = (
  data: WeatherDomainData,
  at: IsoTimestamp,
): WeatherDomainData => {
  if (data.conditionKind !== 'weather_influence') return data
  const frame = activeWeatherInfluenceFrameAt(data, at)
  if (!frame) return data
  return {
    ...data,
    state: frame.state,
    quality: { ...data.quality, validAt: data.quality.validAt },
  }
}
