import { z } from 'zod'
import { geoJsonPolygonSchema, nowIso, type GeoJsonPoint, type IsoTimestamp, type OperationalObject } from '../../core/model/index.ts'
import type { PackMapAreaFeature, PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import { defaultDroneProfiles, dronePackDataSchema, type DroneControllerBinding, type DroneProfile, type DroneSceneObject } from './model.ts'
import { movePointByMeters } from './sim/flight-math.ts'

export const droneSceneQueryKind = 'drone.scene'
export const droneControllerBindingsQueryKind = 'drone.controllerBindings'
export const droneProfilesQueryKind = 'drone.profiles'
export const droneMapFeaturesQueryKind = 'drone.mapFeatures'

export const droneQueryKinds = [
  droneSceneQueryKind,
  droneControllerBindingsQueryKind,
  droneProfilesQueryKind,
  droneMapFeaturesQueryKind,
] as const

const mapFeaturesPayloadSchema = z.object({
  viewport: geoJsonPolygonSchema.optional(),
  zoom: z.number().finite().min(0).max(24).optional(),
  layers: z.array(z.enum(['sensor-footprints', 'effect-ranges', 'swarm-envelopes'])).default(['sensor-footprints', 'effect-ranges', 'swarm-envelopes']),
}).strict().default({
  layers: ['sensor-footprints', 'effect-ranges', 'swarm-envelopes'],
})

const ok = (request: PackQueryRequest, result: unknown, at: IsoTimestamp): PackQueryResponse => ({
  ok: true,
  packId: request.packId,
  kind: request.kind,
  result,
  generatedAt: at,
})

const fail = (request: PackQueryRequest, reason: string, at: IsoTimestamp): PackQueryResponse => ({
  ok: false,
  packId: request.packId,
  kind: request.kind,
  reason,
  generatedAt: at,
})

const droneDataFor = (object: OperationalObject) => {
  const parsed = dronePackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data : null
}

export const droneSceneObjects = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<DroneSceneObject> =>
  objects.flatMap(object => {
    const data = droneDataFor(object)
    const point = object.spatial.position?.point
    if (!data || !point) return []
    return [{
      id: object.id,
      label: object.label,
      point,
      altitudeM: data.kinematics.altitudeM,
      headingDeg: data.kinematics.yawDeg,
      mode: data.control.mode,
      health: data.health.state,
      profileId: data.profile.id,
      color: data.profile.visual.color,
      ...(data.swarm?.swarmId === undefined ? {} : { swarmId: data.swarm.swarmId }),
    }]
  })

export const droneControllerBindings = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<DroneControllerBinding> =>
  objects.flatMap(object => {
    const data = droneDataFor(object)
    if (!data) return []
    return [{
      droneId: object.id,
      ...(data.control.pilotActorId === undefined ? {} : { actorId: data.control.pilotActorId }),
      ...(data.control.inputSource?.clientId === undefined ? {} : { clientId: data.control.inputSource.clientId }),
      ...(data.control.inputSource?.kind === undefined ? {} : { inputKind: data.control.inputSource.kind }),
      ...(data.control.inputSource?.label === undefined ? {} : { label: data.control.inputSource.label }),
      ...(data.control.inputExpiresAt === undefined ? {} : { inputExpiresAt: data.control.inputExpiresAt }),
    }]
  })

const circlePolygon = (
  center: GeoJsonPoint,
  radiusM: number,
  vertices = 40,
): PackMapAreaFeature['geometry'] => {
  const coordinates: GeoJsonPoint['coordinates'][] = []
  for (let index = 0; index < vertices; index += 1) {
    const angle = index / vertices * Math.PI * 2
    coordinates.push(movePointByMeters(center, {
      eastM: Math.sin(angle) * radiusM,
      northM: Math.cos(angle) * radiusM,
    }).coordinates)
  }
  coordinates.push(coordinates[0]!)
  return {
    type: 'Polygon',
    coordinates: [coordinates],
  }
}

const mapFeatures = (
  objects: ReadonlyArray<OperationalObject>,
  layers: ReadonlyArray<'sensor-footprints' | 'effect-ranges' | 'swarm-envelopes'>,
): ReadonlyArray<PackMapAreaFeature> => {
  const enabled = new Set(layers)
  const features: PackMapAreaFeature[] = []
  for (const object of objects) {
    const data = droneDataFor(object)
    const point = object.spatial.position?.point
    if (!data || !point) continue
    if (enabled.has('sensor-footprints')) {
      const longestSensorRange = Math.max(0, ...data.profile.sensors.map(sensor => sensor.rangeM))
      if (longestSensorRange > 0) {
        features.push({
          id: `${object.id}:sensor-footprint`,
          categoryId: 'drone-sensor-footprints',
          geometry: circlePolygon(point, longestSensorRange),
          anchorPoint: point,
          color: data.profile.visual.color,
          opacity: 0.08,
          lineColor: data.profile.visual.color,
          lineOpacity: 0.28,
          lineWidth: 1,
          summary: `${object.label} sensor footprint`,
          sortKey: 40,
        })
      }
    }
    if (enabled.has('effect-ranges')) {
      const longestEffectRange = Math.max(0, ...data.profile.payloads.flatMap(payload => payload.effect && payload.rangeM ? [payload.rangeM] : []))
      if (longestEffectRange > 0) {
        features.push({
          id: `${object.id}:effect-range`,
          categoryId: 'drone-effect-ranges',
          geometry: circlePolygon(point, longestEffectRange),
          anchorPoint: point,
          color: '#dc2626',
          opacity: 0.05,
          lineColor: '#dc2626',
          lineOpacity: 0.35,
          lineWidth: 1.2,
          summary: `${object.label} effect range`,
          sortKey: 60,
        })
      }
    }
  }
  return features
}

export const answerDroneQuery = (config: {
  readonly request: PackQueryRequest
  readonly objects: ReadonlyArray<OperationalObject>
  readonly at?: IsoTimestamp
  readonly profiles?: ReadonlyArray<DroneProfile>
}): PackQueryResponse => {
  const at = config.at ?? nowIso()
  try {
    if (config.request.kind === droneSceneQueryKind) {
      return ok(config.request, { drones: droneSceneObjects(config.objects) }, at)
    }
    if (config.request.kind === droneControllerBindingsQueryKind) {
      return ok(config.request, { bindings: droneControllerBindings(config.objects) }, at)
    }
    if (config.request.kind === droneProfilesQueryKind) {
      return ok(config.request, { profiles: config.profiles ?? defaultDroneProfiles }, at)
    }
    if (config.request.kind === droneMapFeaturesQueryKind) {
      const payload = mapFeaturesPayloadSchema.parse(config.request.payload)
      return ok(config.request, { features: mapFeatures(config.objects, payload.layers) }, at)
    }
    return fail(config.request, `unsupported drone query kind: ${config.request.kind}`, at)
  } catch (err) {
    return fail(config.request, err instanceof Error ? err.message : String(err), at)
  }
}
