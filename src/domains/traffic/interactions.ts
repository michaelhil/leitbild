import { z } from 'zod'
import type { ControlInstanceId, GeoJsonLineString, GeoJsonPoint, InteractionEffect, InteractionHandler, IsoTimestamp, ObjectId, OperationalObject, RouteImpact, SignalId } from '../../core/model/index.ts'
import { assetRoutePlannedSignalType, confirmedFact, notificationIdSchema, pointFromPosition, routeDistanceMeters } from '../../core/model/index.ts'
import { trafficDomainDataSchema, type TrafficDomainData } from './model.ts'

const routePlannedPayloadSchema = z.object({
  objectId: z.string().min(1).transform(value => value as ObjectId),
})

const trafficDataOf = (object: OperationalObject): TrafficDomainData | null => {
  const parsed = trafficDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data : null
}

const pointDistanceToLine = (point: GeoJsonPoint, line: GeoJsonLineString): number =>
  Math.min(...line.coordinates.map(coordinate => routeDistanceMeters(point, pointFromPosition(coordinate))))

const routeIntersectsTraffic = (
  route: GeoJsonLineString,
  traffic: OperationalObject,
): boolean => {
  const geometry = traffic.spatial.geometry
  if (!geometry) return false
  if (geometry.type === 'LineString') {
    return route.coordinates.some(coordinate => pointDistanceToLine(pointFromPosition(coordinate), geometry) <= 220)
  }
  if (geometry.type === 'Polygon') {
    const ring = geometry.coordinates[0]
    if (!ring) return false
    const lons = ring.map(coordinate => coordinate[0])
    const lats = ring.map(coordinate => coordinate[1])
    const minLon = Math.min(...lons)
    const maxLon = Math.max(...lons)
    const minLat = Math.min(...lats)
    const maxLat = Math.max(...lats)
    return route.coordinates.some(([lon, lat]) => lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat)
  }
  return false
}

const existingImpactIds = (object: OperationalObject): ReadonlySet<ObjectId> =>
  new Set((object.spatial.route?.impacts ?? []).map(impact => impact.sourceObjectId))

const impactedObject = (
  object: OperationalObject,
  traffic: OperationalObject,
  data: TrafficDomainData,
  at: IsoTimestamp,
): OperationalObject => {
  const route = object.spatial.route
  if (!route) return object
  const impactIds = existingImpactIds(object)
  const impactAlreadyKnown = impactIds.has(traffic.id)
  const impacts = impactIds.has(traffic.id)
    ? route.impacts ?? []
    : [
        ...(route.impacts ?? []),
        {
          sourceObjectId: traffic.id,
          label: traffic.label,
          severity: data.severity,
          ...(data.speedFactor === undefined ? {} : { speedFactor: data.speedFactor }),
          ...(data.delaySecondsEstimate && data.delaySecondsEstimate.state !== 'unknown' ? { delaySeconds: data.delaySecondsEstimate.value } : {}),
          updatedAt: at,
        } satisfies RouteImpact,
      ]
  const delaySeconds = impacts.reduce((sum, impact) => sum + (impact.delaySeconds ?? 0), 0)
  const routeImpactFact = {
    id: `route-impact.${traffic.id}`,
    key: `route.impact.${traffic.id}`,
    perspective: 'system' as const,
    fact: confirmedFact({
      trafficObjectId: traffic.id,
      label: traffic.label,
      severity: data.severity,
    }, at, 'simulation', 1),
    relatedObjectIds: [traffic.id],
    relatedTaskIds: [],
  }
  return {
    ...object,
    revision: object.revision + 1,
    spatial: {
      ...object.spatial,
      route: {
        ...route,
        impacts,
        ...(route.etaSeconds === undefined ? {} : { etaSeconds: Math.ceil(route.etaSeconds + delaySeconds) }),
      },
    },
    context: {
      schemaVersion: 1,
      facts: [
        ...(object.context?.facts ?? []),
        ...(impactAlreadyKnown ? [] : [routeImpactFact]),
      ],
      activity: object.context?.activity ?? [],
      references: object.context?.references ?? [],
      summaries: object.context?.summaries ?? [],
    },
  }
}

const effectsForRoute = (
  object: OperationalObject,
  trafficObjects: ReadonlyArray<OperationalObject>,
  signalId: SignalId,
  controlInstanceId: ControlInstanceId,
  at: IsoTimestamp,
): ReadonlyArray<InteractionEffect> => {
  const route = object.spatial.route?.planned
  if (!route) return []
  const impacts = trafficObjects
    .map(traffic => ({ traffic, data: trafficDataOf(traffic) }))
    .filter((entry): entry is { readonly traffic: OperationalObject; readonly data: TrafficDomainData } => entry.data !== null)
    .filter(({ traffic }) => routeIntersectsTraffic(route, traffic))
  if (impacts.length === 0) return []
  const updated = impacts.reduce((current, { traffic, data }) => impactedObject(current, traffic, data, at), object)
  return [
    { type: 'object.upsert', object: updated },
    {
      type: 'notification.emit',
      notification: {
        id: notificationIdSchema.parse(`notification:${signalId}`),
        controlInstanceId,
        at,
        title: 'Route affected by traffic',
        message: `${object.label} route intersects ${impacts.map(({ traffic }) => traffic.label).join(', ')}`,
        severity: impacts.some(({ data }) => data.severity === 'blocked' || data.severity === 'high') ? 'warning' : 'notice',
        source: { kind: 'object', id: object.id },
        targets: impacts.map(({ traffic }) => ({ kind: 'object' as const, id: traffic.id })),
        signalId,
      },
    },
  ]
}

export const createTrafficRouteImpactHandler = (): InteractionHandler => ({
  id: 'traffic.route-impact-handler',
  priority: 200,
  accepts: signal => signal.type === assetRoutePlannedSignalType,
  handle: async ({ signal, snapshot }): Promise<ReadonlyArray<InteractionEffect>> => {
    const payload = routePlannedPayloadSchema.safeParse(signal.payload)
    if (!payload.success) return []
    const object = snapshot.objects.find(candidate => candidate.id === payload.data.objectId)
    if (!object) return []
    return effectsForRoute(
      object,
      snapshot.objects.filter(candidate => trafficDataOf(candidate) !== null),
      signal.id,
      signal.controlInstanceId,
      signal.at,
    )
  },
})
