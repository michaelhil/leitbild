import type { GeoJsonPoint, GeoJsonPolygon, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { geoPointFromLonLat } from '../../core/model/index.ts'
import {
  type WeatherAtmosphere,
  type WeatherDomainData,
  type WeatherFalloffCurve,
  type WeatherInfluenceKeyframe,
  type WeatherSample,
  type WeatherSeverity,
  type WeatherState,
  type WeatherSurface,
  weatherDomainDataSchema,
} from './model.ts'
import { defaultAtmosphere, defaultSurface } from './defaults.ts'

const metersPerDegreeLatitude = 111_320
const sqrt3 = Math.sqrt(3)

interface LocalPoint {
  readonly x: number
  readonly y: number
}

interface AxialCell {
  readonly q: number
  readonly r: number
}

export interface WeatherFieldConfig {
  readonly cellSizeM: number
  readonly referenceLatitude: number
}

export interface WeatherSolvedCell {
  readonly id: string
  readonly center: GeoJsonPoint
  readonly polygon: GeoJsonPolygon
  readonly sample: WeatherSample
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const clamp01 = (value: number): number => clamp(value, 0, 1)

const lerp = (from: number, to: number, fraction: number): number =>
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

const referenceLatitudeFor = (objects: ReadonlyArray<OperationalObject>, fallback: GeoJsonPolygon | GeoJsonPoint): number => {
  const points = objects.flatMap(object => object.spatial.position?.point ? [object.spatial.position.point.coordinates[1]] : [])
  if (points.length > 0) return points.reduce((sum, lat) => sum + lat, 0) / points.length
  if (fallback.type === 'Point') return fallback.coordinates[1]
  const ring = fallback.coordinates[0]
  if (!ring || ring.length === 0) throw new Error('weather viewport polygon has no coordinates')
  return ring.reduce((sum, coordinate) => sum + coordinate[1], 0) / ring.length
}

const axialRound = (q: number, r: number): AxialCell => {
  let roundedQ = Math.round(q)
  let roundedR = Math.round(r)
  const roundedS = Math.round(-q - r)
  const qDiff = Math.abs(roundedQ - q)
  const rDiff = Math.abs(roundedR - r)
  const sDiff = Math.abs(roundedS + q + r)
  if (qDiff > rDiff && qDiff > sDiff) roundedQ = -roundedR - roundedS
  else if (rDiff > sDiff) roundedR = -roundedQ - roundedS
  return { q: roundedQ, r: roundedR }
}

const pointToCell = (point: LocalPoint, cellRadiusM: number): AxialCell =>
  axialRound((2 / 3 * point.x) / cellRadiusM, ((-1 / 3 * point.x) + (sqrt3 / 3 * point.y)) / cellRadiusM)

const cellCenter = (cell: AxialCell, cellRadiusM: number): LocalPoint => ({
  x: cellRadiusM * (3 / 2 * cell.q),
  y: cellRadiusM * (sqrt3 * (cell.r + cell.q / 2)),
})

const cellId = (cell: AxialCell, cellSizeM: number): string =>
  `hex:${Math.round(cellSizeM)}:${cell.q}:${cell.r}`

const hexPolygonAt = (
  center: LocalPoint,
  radiusM: number,
  referenceLatitude: number,
): GeoJsonPolygon => {
  const coordinates = Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (60 * index)
    return fromLocalPoint({
      x: center.x + radiusM * Math.cos(angle),
      y: center.y + radiusM * Math.sin(angle),
    }, referenceLatitude).coordinates
  })
  const first = coordinates[0]
  if (!first) throw new Error('weather hexagon generation produced no coordinates')
  return { type: 'Polygon', coordinates: [[...coordinates, first]] }
}

const localBounds = (
  polygon: GeoJsonPolygon,
  referenceLatitude: number,
): { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } => {
  const points = polygon.coordinates.flatMap(ring => ring.map(coordinate => toLocalPoint({
    type: 'Point',
    coordinates: coordinate,
  }, referenceLatitude)))
  if (points.length === 0) throw new Error('weather viewport polygon has no coordinates')
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }), {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  })
}

const visibleCellsFor = (viewport: GeoJsonPolygon, config: WeatherFieldConfig): ReadonlyArray<AxialCell> => {
  const radiusM = config.cellSizeM / 2
  const bounds = localBounds(viewport, config.referenceLatitude)
  const minCell = pointToCell({ x: bounds.minX - radiusM * 2, y: bounds.minY - radiusM * 2 }, radiusM)
  const maxCell = pointToCell({ x: bounds.maxX + radiusM * 2, y: bounds.maxY + radiusM * 2 }, radiusM)
  const cells: AxialCell[] = []
  for (let q = minCell.q - 2; q <= maxCell.q + 2; q += 1) {
    for (let r = minCell.r - 2; r <= maxCell.r + 2; r += 1) {
      cells.push({ q, r })
    }
  }
  return cells
}

const stateFromData = (data: WeatherDomainData): WeatherState => ({
  atmosphere: data.atmosphere,
  surface: data.surface,
})

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
  labels: [],
})

const frictionClassFor = (surface: Pick<WeatherSurface, 'wetness' | 'standingWater' | 'snow' | 'ice' | 'frost'>): WeatherSurface['frictionClass'] => {
  const blackIceRisk = clamp01(surface.ice + surface.frost * 0.35 + surface.wetness * 0.25)
  if (blackIceRisk > 0.6) return 'icy'
  if (surface.snow > 0.45 || blackIceRisk > 0.35) return 'slippery'
  if (surface.wetness > 0.2 || surface.standingWater > 0.15) return 'wet'
  return 'normal'
}

const labelsForSurface = (surface: Pick<WeatherSurface, 'wetness' | 'standingWater' | 'snow' | 'ice' | 'frost'>): ReadonlyArray<string> => {
  const labels = [
    ...(surface.wetness > 0.2 ? ['wet'] : []),
    ...(surface.standingWater > 0.2 ? ['standing-water'] : []),
    ...(surface.snow > 0.2 ? ['snow'] : []),
    ...(surface.ice > 0.25 ? ['ice'] : []),
    ...(surface.frost > 0.25 ? ['frost'] : []),
  ]
  return labels.length > 0 ? labels : ['dry']
}

const mixSurface = (current: WeatherSurface, target: WeatherSurface, weight: number): WeatherSurface => {
  const mixed = {
    groundTemperatureC: lerp(current.groundTemperatureC, target.groundTemperatureC, weight),
    wetness: clamp01(lerp(current.wetness, target.wetness, weight)),
    standingWater: clamp01(lerp(current.standingWater, target.standingWater, weight)),
    snow: clamp01(lerp(current.snow, target.snow, weight)),
    ice: clamp01(lerp(current.ice, target.ice, weight)),
    frost: clamp01(lerp(current.frost, target.frost, weight)),
  }
  const frictionClass = frictionClassFor(mixed)
  const frictionEstimate = clamp01(1 - Math.max(mixed.wetness * 0.25, mixed.snow * 0.55, mixed.ice * 0.8, mixed.standingWater * 0.35, mixed.frost * 0.35))
  return {
    ...mixed,
    frictionEstimate,
    frictionClass,
    labels: [...labelsForSurface(mixed)],
  }
}

const mixState = (current: WeatherState, target: WeatherState, weight: number): WeatherState => ({
  atmosphere: mixAtmosphere(current.atmosphere, target.atmosphere, weight),
  surface: mixSurface(current.surface, target.surface, weight),
})

const atmosphereLabelsFor = (atmosphere: WeatherAtmosphere): ReadonlyArray<string> => {
  const labels = [
    ...(atmosphere.precipitation.type !== 'none' ? [atmosphere.precipitation.type.replaceAll('_', '-')] : []),
    ...(atmosphere.visibilityM < 2000 ? ['low-visibility'] : []),
    ...(atmosphere.windSpeedMps > 10 ? ['windy'] : []),
    ...(atmosphere.cloudCover !== undefined && atmosphere.cloudCover > 0.7 ? ['cloudy'] : []),
  ]
  return labels.length > 0 ? labels : ['fair']
}

const severityFor = (state: WeatherState): WeatherSeverity =>
  state.surface.frictionClass === 'icy' || state.atmosphere.visibilityM < 800
    ? 'hazard'
    : state.surface.frictionClass === 'slippery' || state.atmosphere.visibilityM < 2000
      ? 'adverse'
      : state.atmosphere.precipitation.type !== 'none' || state.surface.frictionClass === 'wet'
        ? 'notice'
        : 'normal'

const sortedInfluenceObjects = (
  objects: ReadonlyArray<OperationalObject>,
): ReadonlyArray<{ readonly object: OperationalObject; readonly data: WeatherDomainData }> =>
  objects.flatMap(object => {
    const parsed = weatherDomainDataSchema.safeParse(object.domainData)
    if (!parsed.success || parsed.data.conditionKind !== 'weather_influence' || !parsed.data.influence) return []
    return [{ object, data: parsed.data }]
  }).sort((a, b) => (a.data.influence!.priority - b.data.influence!.priority) || a.object.id.localeCompare(b.object.id))

const activeFrameAt = (
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
  return interpolateFrame(previous, next, fraction)
}

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

const interpolateFrame = (
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
  state: mixState(from.state, to.state, fraction),
  falloffCurve: interpolateCurve(from.falloffCurve, to.falloffCurve, fraction),
})

const evaluateCurve = (curve: WeatherFalloffCurve, normalizedDistance: number): number => {
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

const influenceWeightFor = (
  point: LocalPoint,
  frame: WeatherInfluenceKeyframe,
  referenceLatitude: number,
): number => {
  const center = toLocalPoint(frame.center, referenceLatitude)
  const dx = point.x - center.x
  const dy = point.y - center.y
  const angle = -frame.rotationDeg * Math.PI / 180
  const rotatedX = dx * Math.cos(angle) - dy * Math.sin(angle)
  const rotatedY = dx * Math.sin(angle) + dy * Math.cos(angle)
  const normalizedDistance = Math.sqrt(
    (rotatedX / frame.semiMajorAxisM) ** 2 +
    (rotatedY / frame.semiMinorAxisM) ** 2,
  )
  if (normalizedDistance > 1) return 0
  return evaluateCurve(frame.falloffCurve, normalizedDistance)
}

const baseStateFor = (at: IsoTimestamp): WeatherState => ({
  atmosphere: defaultAtmosphere(at),
  surface: defaultSurface(),
})

const fieldCellSizeFor = (objects: ReadonlyArray<OperationalObject>, zoom?: number): number => {
  const configured = objects.flatMap(object => {
    const parsed = weatherDomainDataSchema.safeParse(object.domainData)
    return parsed.success && parsed.data.render?.cellSizeM ? [parsed.data.render.cellSizeM] : []
  })
  const truthCellSize = configured.length > 0 ? Math.min(...configured) : 750
  if (zoom === undefined) return truthCellSize
  if (zoom < 7) return Math.max(truthCellSize * 8, 6000)
  if (zoom < 9) return Math.max(truthCellSize * 4, 3000)
  if (zoom < 11) return Math.max(truthCellSize * 2, 1500)
  return truthCellSize
}

const solveStateAtLocalPoint = (
  objects: ReadonlyArray<OperationalObject>,
  localPoint: LocalPoint,
  config: WeatherFieldConfig,
  at: IsoTimestamp,
): WeatherSample => {
  let state = baseStateFor(at)
  const sourceObjectIds: string[] = []
  for (const entry of sortedInfluenceObjects(objects)) {
    const frame = activeFrameAt(entry.data, at)
    if (!frame) continue
    const weight = influenceWeightFor(localPoint, frame, config.referenceLatitude)
    if (weight <= 0) continue
    state = mixState(state, frame.state, weight)
    sourceObjectIds.push(entry.object.id)
  }
  const normalizedState = {
    atmosphere: { ...state.atmosphere, labels: [...atmosphereLabelsFor(state.atmosphere)] },
    surface: state.surface,
  }
  return {
    severity: severityFor(normalizedState),
    atmosphere: normalizedState.atmosphere,
    surface: normalizedState.surface,
    quality: { provenance: sourceObjectIds.length > 0 ? 'inferred' : 'scenario', confidence: sourceObjectIds.length > 0 ? 0.85 : 0.6, validAt: at },
    sourceObjectIds,
  }
}

export const weatherFieldConfigFor = (config: {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly viewport: GeoJsonPolygon | GeoJsonPoint
  readonly zoom?: number
}): WeatherFieldConfig => ({
  cellSizeM: fieldCellSizeFor(config.objects, config.zoom),
  referenceLatitude: referenceLatitudeFor(config.objects, config.viewport),
})

export const weatherSampleAtPointFromField = (
  objects: ReadonlyArray<OperationalObject>,
  point: GeoJsonPoint,
  at: IsoTimestamp,
): WeatherSample => {
  const config = weatherFieldConfigFor({ objects, viewport: point })
  const radiusM = config.cellSizeM / 2
  const localPoint = toLocalPoint(point, config.referenceLatitude)
  const cell = pointToCell(localPoint, radiusM)
  const center = cellCenter(cell, radiusM)
  return solveStateAtLocalPoint(objects, center, config, at)
}

export const weatherCellsForViewport = (config: {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly viewport: GeoJsonPolygon
  readonly at: IsoTimestamp
  readonly zoom: number
}): ReadonlyArray<WeatherSolvedCell> => {
  const fieldConfig = weatherFieldConfigFor({
    objects: config.objects,
    viewport: config.viewport,
    zoom: config.zoom,
  })
  const radiusM = fieldConfig.cellSizeM / 2
  return visibleCellsFor(config.viewport, fieldConfig).map(cell => {
    const center = cellCenter(cell, radiusM)
    const point = fromLocalPoint(center, fieldConfig.referenceLatitude)
    const sample = solveStateAtLocalPoint(config.objects, center, fieldConfig, config.at)
    return {
      id: cellId(cell, fieldConfig.cellSizeM),
      center: point,
      polygon: hexPolygonAt(center, radiusM, fieldConfig.referenceLatitude),
      sample,
    }
  })
}

export const weatherObjectCurrentCenter = (
  data: WeatherDomainData,
  at: IsoTimestamp,
): GeoJsonPoint | null =>
  activeFrameAt(data, at)?.center ?? null

export const weatherDataAtTime = (
  data: WeatherDomainData,
  at: IsoTimestamp,
): WeatherDomainData => {
  if (data.conditionKind !== 'weather_influence') return data
  const frame = activeFrameAt(data, at)
  if (!frame) return data
  const state = {
    atmosphere: { ...frame.state.atmosphere, labels: [...atmosphereLabelsFor(frame.state.atmosphere)] },
    surface: frame.state.surface,
  }
  return {
    ...data,
    atmosphere: state.atmosphere,
    surface: state.surface,
    severity: severityFor(state),
    quality: { ...data.quality, validAt: data.quality.validAt },
  }
}

export const weatherStateFromData = stateFromData
