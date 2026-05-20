import type { GeoJsonPoint, IsoTimestamp, ObjectId, OperationalObject } from '../../core/model/index.ts'
import { geoPointFromLonLat } from '../../core/model/index.ts'
import {
  evolveSurfaceWithResidual,
  surfaceIsDefaultLike,
} from './conditions.ts'
import { defaultAtmosphere, defaultSurface } from './defaults.ts'
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

const metersPerDegreeLatitude = 111_320
const sqrt3 = Math.sqrt(3)
const minimumStoredResidual = 0.005

interface LocalPoint {
  readonly x: number
  readonly y: number
}

export interface WeatherAxialCell {
  readonly q: number
  readonly r: number
}

export type WeatherCellId = string

export interface WeatherGridDefinition {
  readonly gridId: string
  readonly cellSizeM: number
  readonly referenceLatitude: number
}

export interface WeatherCellState {
  readonly id: WeatherCellId
  readonly q: number
  readonly r: number
  readonly center: GeoJsonPoint
  readonly atmosphere: WeatherAtmosphere
  readonly surface: WeatherSurface
  readonly sourceObjectIds: ReadonlyArray<ObjectId>
  readonly residual: number
  readonly updatedAt: IsoTimestamp
}

export interface WeatherSparseField {
  readonly grid: WeatherGridDefinition
  readonly cells: ReadonlyMap<WeatherCellId, WeatherCellState>
  readonly activeCellIds: ReadonlySet<WeatherCellId>
}

export interface WeatherFieldUpdate {
  readonly field: WeatherSparseField
  readonly touchedCellIds: ReadonlySet<WeatherCellId>
  readonly deletedCellIds: ReadonlySet<WeatherCellId>
}

interface WeatherInfluenceEntry {
  readonly objectId: ObjectId
  readonly priority: number
  readonly frame: WeatherInfluenceKeyframe
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

const axialRound = (q: number, r: number): WeatherAxialCell => {
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

const pointToCell = (point: LocalPoint, cellRadiusM: number): WeatherAxialCell =>
  axialRound((2 / 3 * point.x) / cellRadiusM, ((-1 / 3 * point.x) + (sqrt3 / 3 * point.y)) / cellRadiusM)

const cellCenter = (cell: WeatherAxialCell, cellRadiusM: number): LocalPoint => ({
  x: cellRadiusM * (3 / 2 * cell.q),
  y: cellRadiusM * (sqrt3 * (cell.r + cell.q / 2)),
})

export const weatherCellId = (grid: WeatherGridDefinition, cell: WeatherAxialCell): WeatherCellId =>
  `${grid.gridId}:${Math.round(grid.cellSizeM)}:${cell.q}:${cell.r}`

export const weatherCellForPoint = (grid: WeatherGridDefinition, point: GeoJsonPoint): WeatherAxialCell =>
  pointToCell(toLocalPoint(point, grid.referenceLatitude), grid.cellSizeM / 2)

export const weatherCellCenter = (grid: WeatherGridDefinition, cell: WeatherAxialCell): GeoJsonPoint =>
  fromLocalPoint(cellCenter(cell, grid.cellSizeM / 2), grid.referenceLatitude)

const defaultStateFor = (at: IsoTimestamp): WeatherState => ({
  atmosphere: defaultAtmosphere(at),
  surface: defaultSurface(),
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

const mixSurface = (current: WeatherSurface, target: WeatherSurface, weight: number): WeatherSurface => ({
  ...target,
  groundTemperatureC: lerp(current.groundTemperatureC, target.groundTemperatureC, weight),
  wetness: clamp01(lerp(current.wetness, target.wetness, weight)),
  standingWater: clamp01(lerp(current.standingWater, target.standingWater, weight)),
  snow: clamp01(lerp(current.snow, target.snow, weight)),
  ice: clamp01(lerp(current.ice, target.ice, weight)),
  frost: clamp01(lerp(current.frost, target.frost, weight)),
})

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

const activeInfluencesAt = (
  objects: ReadonlyArray<OperationalObject>,
  at: IsoTimestamp,
): ReadonlyArray<WeatherInfluenceEntry> =>
  objects.flatMap(object => {
    const parsed = weatherDomainDataSchema.safeParse(object.domainData)
    if (!parsed.success || parsed.data.conditionKind !== 'weather_influence' || !parsed.data.influence) return []
    const frame = activeFrameAt(parsed.data, at)
    if (!frame) return []
    return [{
      objectId: object.id,
      priority: parsed.data.influence.priority,
      frame,
    }]
  }).sort((left, right) => (left.priority - right.priority) || left.objectId.localeCompare(right.objectId))

const influenceBounds = (
  grid: WeatherGridDefinition,
  frame: WeatherInfluenceKeyframe,
): { readonly minQ: number; readonly minR: number; readonly maxQ: number; readonly maxR: number } => {
  const center = toLocalPoint(frame.center, grid.referenceLatitude)
  const angle = frame.rotationDeg * Math.PI / 180
  const corners = [
    { x: frame.semiMajorAxisM, y: frame.semiMinorAxisM },
    { x: -frame.semiMajorAxisM, y: frame.semiMinorAxisM },
    { x: -frame.semiMajorAxisM, y: -frame.semiMinorAxisM },
    { x: frame.semiMajorAxisM, y: -frame.semiMinorAxisM },
  ].map(corner => ({
    x: center.x + corner.x * Math.cos(angle) - corner.y * Math.sin(angle),
    y: center.y + corner.x * Math.sin(angle) + corner.y * Math.cos(angle),
  }))
  const radiusM = grid.cellSizeM / 2
  const cells = corners.flatMap(corner => [
    pointToCell(corner, radiusM),
    pointToCell({ x: corner.x - radiusM * 2, y: corner.y - radiusM * 2 }, radiusM),
    pointToCell({ x: corner.x + radiusM * 2, y: corner.y + radiusM * 2 }, radiusM),
  ])
  return cells.reduce((bounds, cell) => ({
    minQ: Math.min(bounds.minQ, cell.q),
    minR: Math.min(bounds.minR, cell.r),
    maxQ: Math.max(bounds.maxQ, cell.q),
    maxR: Math.max(bounds.maxR, cell.r),
  }), {
    minQ: Number.POSITIVE_INFINITY,
    minR: Number.POSITIVE_INFINITY,
    maxQ: Number.NEGATIVE_INFINITY,
    maxR: Number.NEGATIVE_INFINITY,
  })
}

const cellsUnderInfluences = (
  grid: WeatherGridDefinition,
  influences: ReadonlyArray<WeatherInfluenceEntry>,
): ReadonlyMap<WeatherCellId, WeatherAxialCell> => {
  const cells = new Map<WeatherCellId, WeatherAxialCell>()
  const radiusM = grid.cellSizeM / 2
  for (const influence of influences) {
    const bounds = influenceBounds(grid, influence.frame)
    for (let q = bounds.minQ; q <= bounds.maxQ; q += 1) {
      for (let r = bounds.minR; r <= bounds.maxR; r += 1) {
        const cell = { q, r }
        const center = cellCenter(cell, radiusM)
        if (influenceWeightFor(center, influence.frame, grid.referenceLatitude) <= 0) continue
        cells.set(weatherCellId(grid, cell), cell)
      }
    }
  }
  return cells
}

const candidateCell = (field: WeatherSparseField, id: WeatherCellId): WeatherAxialCell => {
  const existing = field.cells.get(id)
  if (existing) return { q: existing.q, r: existing.r }
  const parts = id.split(':')
  const q = Number(parts[parts.length - 2])
  const r = Number(parts[parts.length - 1])
  if (!Number.isInteger(q) || !Number.isInteger(r)) throw new Error(`invalid weather cell id: ${id}`)
  return { q, r }
}

const solveForcedState = (config: {
  readonly base: WeatherState
  readonly center: LocalPoint
  readonly influences: ReadonlyArray<WeatherInfluenceEntry>
  readonly referenceLatitude: number
}): { readonly state: WeatherState; readonly sourceObjectIds: ReadonlyArray<ObjectId> } => {
  let state = config.base
  const sourceObjectIds: ObjectId[] = []
  for (const influence of config.influences) {
    const weight = influenceWeightFor(config.center, influence.frame, config.referenceLatitude)
    if (weight <= 0) continue
    state = mixState(state, influence.frame.state, weight)
    sourceObjectIds.push(influence.objectId)
  }
  return { state, sourceObjectIds }
}

const cellStateFrom = (config: {
  readonly field: WeatherSparseField
  readonly cell: WeatherAxialCell
  readonly at: IsoTimestamp
  readonly elapsedSeconds: number
  readonly influences: ReadonlyArray<WeatherInfluenceEntry>
}): WeatherCellState | null => {
  const centerLocal = cellCenter(config.cell, config.field.grid.cellSizeM / 2)
  const id = weatherCellId(config.field.grid, config.cell)
  const previous = config.field.cells.get(id)
  const defaultState = defaultStateFor(config.at)
  const base = {
    atmosphere: defaultState.atmosphere,
    surface: previous?.surface ?? defaultState.surface,
  }
  const forced = solveForcedState({
    base,
    center: centerLocal,
    influences: config.influences,
    referenceLatitude: config.field.grid.referenceLatitude,
  })
  const evolved = evolveSurfaceWithResidual({
    surface: forced.state.surface,
    atmosphere: forced.state.atmosphere,
    at: config.at,
    elapsedSeconds: config.elapsedSeconds,
    defaultSurface: defaultState.surface,
  })
  if (forced.sourceObjectIds.length === 0 && evolved.defaultLike) return null
  return {
    id,
    q: config.cell.q,
    r: config.cell.r,
    center: weatherCellCenter(config.field.grid, config.cell),
    atmosphere: {
      ...forced.state.atmosphere,
      labels: [...atmosphereLabelsFor(forced.state.atmosphere)],
    },
    surface: evolved.surface,
    sourceObjectIds: forced.sourceObjectIds,
    residual: evolved.residual,
    updatedAt: config.at,
  }
}

export const createWeatherSparseField = (grid: WeatherGridDefinition): WeatherSparseField => ({
  grid,
  cells: new Map(),
  activeCellIds: new Set(),
})

export const weatherGridForObjects = (config: {
  readonly gridId: string
  readonly objects: ReadonlyArray<OperationalObject>
  readonly fallbackPoint: GeoJsonPoint
  readonly fallbackCellSizeM?: number
}): WeatherGridDefinition => {
  const latitudes = config.objects.flatMap(object => object.spatial.position?.point ? [object.spatial.position.point.coordinates[1]] : [])
  const cellSizes = config.objects.flatMap(object => {
    const parsed = weatherDomainDataSchema.safeParse(object.domainData)
    return parsed.success && parsed.data.render?.cellSizeM ? [parsed.data.render.cellSizeM] : []
  })
  return {
    gridId: config.gridId,
    cellSizeM: cellSizes.length > 0 ? Math.min(...cellSizes) : config.fallbackCellSizeM ?? 750,
    referenceLatitude: latitudes.length > 0
      ? latitudes.reduce((sum, latitude) => sum + latitude, 0) / latitudes.length
      : config.fallbackPoint.coordinates[1],
  }
}

export const updateWeatherSparseField = (config: {
  readonly field: WeatherSparseField
  readonly objects: ReadonlyArray<OperationalObject>
  readonly at: IsoTimestamp
  readonly elapsedSeconds: number
}): WeatherFieldUpdate => {
  const influences = activeInfluencesAt(config.objects, config.at)
  const forcedCells = cellsUnderInfluences(config.field.grid, influences)
  const candidateIds = new Set<WeatherCellId>([
    ...forcedCells.keys(),
    ...config.field.activeCellIds,
  ])
  const cells = new Map(config.field.cells)
  const activeCellIds = new Set<WeatherCellId>()
  const touchedCellIds = new Set<WeatherCellId>()
  const deletedCellIds = new Set<WeatherCellId>()

  for (const id of candidateIds) {
    const cell = forcedCells.get(id) ?? candidateCell(config.field, id)
    const next = cellStateFrom({
      field: { ...config.field, cells },
      cell,
      at: config.at,
      elapsedSeconds: config.elapsedSeconds,
      influences,
    })
    touchedCellIds.add(id)
    if (!next) {
      if (cells.delete(id)) deletedCellIds.add(id)
      continue
    }
    cells.set(id, next)
    if (next.residual > minimumStoredResidual) activeCellIds.add(id)
  }

  return {
    field: {
      grid: config.field.grid,
      cells,
      activeCellIds,
    },
    touchedCellIds,
    deletedCellIds,
  }
}

export const weatherSampleAtPointFromSparseField = (config: {
  readonly field: WeatherSparseField
  readonly point: GeoJsonPoint
  readonly at: IsoTimestamp
}): WeatherSample => {
  const cell = weatherCellForPoint(config.field.grid, config.point)
  const id = weatherCellId(config.field.grid, cell)
  const existing = config.field.cells.get(id)
  if (!existing) {
    const state = defaultStateFor(config.at)
    return {
      severity: severityFor(state),
      atmosphere: { ...state.atmosphere, labels: [...atmosphereLabelsFor(state.atmosphere)] },
      surface: state.surface,
      quality: { provenance: 'scenario', confidence: 0.6, validAt: config.at },
      sourceObjectIds: [],
    }
  }
  const state = { atmosphere: existing.atmosphere, surface: existing.surface }
  return {
    severity: severityFor(state),
    atmosphere: existing.atmosphere,
    surface: existing.surface,
    quality: {
      provenance: existing.sourceObjectIds.length > 0 ? 'inferred' : 'scenario',
      confidence: existing.sourceObjectIds.length > 0 ? 0.85 : 0.7,
      validAt: existing.updatedAt,
    },
    sourceObjectIds: existing.sourceObjectIds,
  }
}

export const weatherSparseFieldStats = (field: WeatherSparseField): {
  readonly cellCount: number
  readonly activeCellCount: number
} => ({
  cellCount: field.cells.size,
  activeCellCount: field.activeCellIds.size,
})
