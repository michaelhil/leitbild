import type { GeoJsonPoint, OperationalObject } from '../core/model/index.ts'
import { geoPointFromLonLat } from '../core/model/index.ts'
import { pointOf } from './map-features.ts'

export interface DisplayMotionTrack {
  readonly objectId: string
  readonly from: GeoJsonPoint
  readonly to: GeoJsonPoint
  readonly startedAtMs: number
  readonly durationMs: number
  readonly routeKey: string
}

export interface DisplayMotionState {
  readonly tracks: ReadonlyMap<string, DisplayMotionTrack>
}

export interface ReconcileDisplayMotionConfig {
  readonly previousState: DisplayMotionState
  readonly previousObjects: ReadonlyArray<OperationalObject>
  readonly nextObjects: ReadonlyArray<OperationalObject>
  readonly nowMs: number
  readonly interpolationMs?: number
  readonly maxAnimatedJumpMeters?: number
}

export const createDisplayMotionState = (): DisplayMotionState => ({
  tracks: new Map(),
})

const distanceMeters = (from: GeoJsonPoint, to: GeoJsonPoint): number => {
  const [fromLon, fromLat] = from.coordinates
  const [toLon, toLat] = to.coordinates
  const meanLatRad = ((fromLat + toLat) / 2) * Math.PI / 180
  const dx = (toLon - fromLon) * 111_320 * Math.cos(meanLatRad)
  const dy = (toLat - fromLat) * 110_540
  return Math.sqrt(dx * dx + dy * dy)
}

const interpolatePoint = (from: GeoJsonPoint, to: GeoJsonPoint, ratio: number): GeoJsonPoint => {
  const boundedRatio = Math.max(0, Math.min(1, ratio))
  const [fromLon, fromLat] = from.coordinates
  const [toLon, toLat] = to.coordinates
  return geoPointFromLonLat(
    fromLon + (toLon - fromLon) * boundedRatio,
    fromLat + (toLat - fromLat) * boundedRatio,
  )
}

export const displayPointForTrack = (track: DisplayMotionTrack, nowMs: number): GeoJsonPoint => {
  if (track.durationMs <= 0) return track.to
  return interpolatePoint(track.from, track.to, (nowMs - track.startedAtMs) / track.durationMs)
}

const isActiveTrack = (track: DisplayMotionTrack, nowMs: number): boolean =>
  track.durationMs > 0 && nowMs < track.startedAtMs + track.durationMs

export const hasActiveDisplayMotion = (state: DisplayMotionState, nowMs: number): boolean =>
  [...state.tracks.values()].some(track => isActiveTrack(track, nowMs))

const routeKeyFor = (object: OperationalObject): string => {
  const route = object.spatial.route?.planned
  if (!route) return ''
  return [
    object.tasking?.currentTaskId ?? '',
    object.operational.status,
    object.spatial.route?.source ?? '',
    route.coordinates.map(coordinate => `${coordinate[0]},${coordinate[1]}`).join(';'),
  ].join('|')
}

const shouldAnimateObject = (object: OperationalObject): boolean =>
  object.kind === 'mobile_entity'
  && (object.spatial.position?.speedMps ?? 0) > 0
  && object.operational.status !== 'available'
  && object.operational.status !== 'on_scene'

export const reconcileDisplayMotionState = (config: ReconcileDisplayMotionConfig): DisplayMotionState => {
  const interpolationMs = config.interpolationMs ?? 1_000
  const maxAnimatedJumpMeters = config.maxAnimatedJumpMeters ?? 250
  const previousObjectsById = new Map(config.previousObjects.map(object => [object.id, object]))
  const tracks = new Map<string, DisplayMotionTrack>()

  for (const nextObject of config.nextObjects) {
    const nextPoint = pointOf(nextObject)
    if (!nextPoint) continue

    const previousObject = previousObjectsById.get(nextObject.id)
    const previousPoint = previousObject ? pointOf(previousObject) : null
    const previousTrack = config.previousState.tracks.get(nextObject.id)
    const nextRouteKey = routeKeyFor(nextObject)
    const previousRouteKey = previousObject ? routeKeyFor(previousObject) : ''
    const shouldSnap = !previousPoint
      || !shouldAnimateObject(nextObject)
      || previousRouteKey !== nextRouteKey
      || distanceMeters(previousPoint, nextPoint) > maxAnimatedJumpMeters

    if (shouldSnap) {
      tracks.set(nextObject.id, {
        objectId: nextObject.id,
        from: nextPoint,
        to: nextPoint,
        startedAtMs: config.nowMs,
        durationMs: 0,
        routeKey: nextRouteKey,
      })
      continue
    }

    const from = previousTrack && isActiveTrack(previousTrack, config.nowMs)
      ? displayPointForTrack(previousTrack, config.nowMs)
      : previousPoint
    tracks.set(nextObject.id, {
      objectId: nextObject.id,
      from,
      to: nextPoint,
      startedAtMs: config.nowMs,
      durationMs: interpolationMs,
      routeKey: nextRouteKey,
    })
  }

  return { tracks }
}

export const displayObjectsFor = (
  objects: ReadonlyArray<OperationalObject>,
  state: DisplayMotionState,
  nowMs: number,
): ReadonlyArray<OperationalObject> =>
  objects.map(object => {
    const track = state.tracks.get(object.id)
    if (!track || !object.spatial.position) return object
    return {
      ...object,
      spatial: {
        ...object.spatial,
        position: {
          ...object.spatial.position,
          point: displayPointForTrack(track, nowMs),
        },
      },
    }
  })
