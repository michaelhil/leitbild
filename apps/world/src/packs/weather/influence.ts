import {
  geoPointFromLonLat,
  type GeoJsonPoint,
  type GeoJsonPolygon,
  type OperationalObject,
} from '../../core/model/index.ts'
import {
  weatherPackDataSchema,
  type WeatherArea,
  type WeatherAtmosphere,
  type WeatherAtmospherePatch,
} from './model.ts'

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const precipitationBlend = (a: WeatherAtmosphere['precipitation'], b: WeatherAtmosphere['precipitation'], t: number): WeatherAtmosphere['precipitation'] => {
  const intensityMmPerHour = lerp(a.intensityMmPerHour, b.intensityMmPerHour, t)
  if (intensityMmPerHour <= 0) return { type: 'none', intensityMmPerHour: 0 }
  return { type: a.type === 'none' ? b.type : b.type === 'none' ? a.type : t < .5 ? a.type : b.type, intensityMmPerHour }
}
const angle = (a: number, b: number, t: number): number => (((a + (((b - a + 540) % 360) - 180) * t) % 360) + 360) % 360
export interface WeatherInfluenceEntry {
  readonly objectId: string
  readonly label: string
  readonly area: WeatherArea
  readonly startsAt: string
}
export const weatherInfluences = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<WeatherInfluenceEntry> =>
  objects
    .filter((o) => o.packId === 'weather')
    .flatMap((object) => {
      const data = weatherPackDataSchema.parse(object.packData)
      return data.definition.type === 'weather_area' && data.definition.enabled
        ? [{ objectId: object.id, label: object.label, area: data.definition, startsAt: data.startsAt }]
        : []
    })
    .sort((a, b) => a.area.priority - b.area.priority || a.objectId.localeCompare(b.objectId))
export const frameAt = (entry: WeatherInfluenceEntry, at: string): WeatherArea => {
  const base = entry.area
  const seconds = Math.max(0, (Date.parse(at) - Date.parse(entry.startsAt)) / 1000)
  let from = base,
    fromTime = 0
  for (const key of base.keyframes) {
    const to: WeatherArea = {
      ...from,
      center: key.center ?? from.center,
      semiMajorAxisM: key.semiMajorAxisM ?? from.semiMajorAxisM,
      semiMinorAxisM: key.semiMinorAxisM ?? from.semiMinorAxisM,
      rotationDeg: key.rotationDeg ?? from.rotationDeg,
      atmosphere: { ...from.atmosphere, ...key.atmosphere },
    }
    if (seconds < key.atSeconds) {
      const t = (seconds - fromTime) / (key.atSeconds - fromTime)
      const patch: WeatherAtmospherePatch = { ...from.atmosphere }
      // Only explicitly authored quantities participate in interpolation.
      for (const k of Object.keys(to.atmosphere) as Array<keyof WeatherAtmosphere>) {
        const a = from.atmosphere[k],
          b = to.atmosphere[k]
        if (a === undefined || b === undefined) {
          if (t >= 1 && b !== undefined) Object.assign(patch, { [k]: b })
          continue
        }
        if (typeof a === 'number' && typeof b === 'number')
          Object.assign(patch, { [k]: k === 'windDirectionDeg' ? angle(a, b, t) : lerp(a, b, t) })
        else if (k === 'precipitation' && typeof a === 'object' && typeof b === 'object')
          patch.precipitation = precipitationBlend(a, b, t)
      }
      return {
        ...from,
        center: [lerp(from.center[0], to.center[0], t), lerp(from.center[1], to.center[1], t)],
        semiMajorAxisM: lerp(from.semiMajorAxisM, to.semiMajorAxisM, t),
        semiMinorAxisM: lerp(from.semiMinorAxisM, to.semiMinorAxisM, t),
        rotationDeg: angle(from.rotationDeg, to.rotationDeg, t),
        atmosphere: patch,
      }
    }
    from = to
    fromTime = key.atSeconds
  }
  return from
}
export const weatherInfluenceWeightForPoint = (point: GeoJsonPoint, area: WeatherArea): number => {
  const dx = (point.coordinates[0] - area.center[0]) * 111320 * Math.cos((area.center[1] * Math.PI) / 180)
  const dy = (point.coordinates[1] - area.center[1]) * 111320
  const theta = (area.rotationDeg * Math.PI) / 180
  const d = Math.hypot(
    (dx * Math.cos(theta) + dy * Math.sin(theta)) / area.semiMajorAxisM,
    (-dx * Math.sin(theta) + dy * Math.cos(theta)) / area.semiMinorAxisM,
  )
  return d > 1 ? 0 : area.falloff === 'uniform' ? 1 : Math.max(0, 1 - d)
}
export const atmosphereAt = (
  baseline: WeatherAtmosphere,
  entries: ReadonlyArray<WeatherInfluenceEntry>,
  point: GeoJsonPoint,
  at: string,
): { atmosphere: WeatherAtmosphere; activeInfluenceIds: string[] } => {
  const state = structuredClone(baseline),
    ids: string[] = []
  for (const entry of entries) {
    const frame = frameAt(entry, at),
      weight = weatherInfluenceWeightForPoint(point, frame)
    if (weight <= 0) continue
    ids.push(entry.objectId)
    for (const [key, value] of Object.entries(frame.atmosphere)) {
      if (typeof value === 'number') {
        const k = key as Exclude<keyof WeatherAtmosphere, 'precipitation'>
        state[k] = k === 'windDirectionDeg' ? angle(state[k], value, weight) : lerp(state[k], value, weight)
      } else if (key === 'precipitation' && value !== undefined) {
        state.precipitation = precipitationBlend(state.precipitation, value, weight)
      }
    }
  }
  return { atmosphere: state, activeInfluenceIds: ids }
}
export const weatherInfluenceEllipsePolygon = (area: WeatherArea): GeoJsonPolygon => {
  const theta = (area.rotationDeg * Math.PI) / 180
  const coordinates = Array.from({ length: 48 }, (_, i) => {
    const a = (i * Math.PI * 2) / 48,
      x = Math.cos(a) * area.semiMajorAxisM,
      y = Math.sin(a) * area.semiMinorAxisM
    return geoPointFromLonLat(
      area.center[0] +
        (x * Math.cos(theta) - y * Math.sin(theta)) / (111320 * Math.cos((area.center[1] * Math.PI) / 180)),
      area.center[1] + (x * Math.sin(theta) + y * Math.cos(theta)) / 111320,
    ).coordinates
  })
  return { type: 'Polygon', coordinates: [[...coordinates, coordinates[0]!]] }
}
