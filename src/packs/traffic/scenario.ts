import { z } from 'zod'
import {
  confirmedFact,
  geoPointFromLonLat,
  objectIdSchema,
  type GeoJsonLineString,
  type GeoJsonPolygon,
  type IsoTimestamp,
  type OperationalObject,
} from '../../core/model/index.ts'
import type { PackScenarioObjectSpec, PackScenarioOperationSpec, PackScenarioSupport } from '../../core/packs/protocol.ts'
import { trafficDomainDataSchema, trafficSeveritySchema, type TrafficDomainData, type TrafficGeometryMode } from './model.ts'
import { trafficSimAdapterId, trafficSimDomain } from './sim/constants.ts'

const lonLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
])

const trafficConditionSpecSchema = z.object({
  pack: z.literal('traffic'),
  type: z.literal('traffic_condition'),
  id: objectIdSchema,
  label: z.string().min(1),
  geometryMode: z.enum(['road_segment', 'area']),
  path: z.array(lonLatSchema).min(2).optional(),
  from: lonLatSchema.optional(),
  to: lonLatSchema.optional(),
  polygon: z.array(lonLatSchema).min(4).optional(),
  condition: z.enum(['free_flow', 'congestion', 'closure', 'slowdown', 'access_restricted']).default('slowdown'),
  severity: trafficSeveritySchema,
  speedFactor: z.number().finite().positive().max(1).optional(),
  reason: z.string().min(1),
})

const lineStringFromPath = (path: ReadonlyArray<readonly [number, number]>): GeoJsonLineString => ({
  type: 'LineString',
  coordinates: path.map(([lon, lat]) => geoPointFromLonLat(lon, lat).coordinates),
})

const polygonFromPath = (path: ReadonlyArray<readonly [number, number]>): GeoJsonPolygon => ({
  type: 'Polygon',
  coordinates: [path.map(([lon, lat]) => geoPointFromLonLat(lon, lat).coordinates)],
})

const trafficConditionObject = (config: {
  readonly spec: z.infer<typeof trafficConditionSpecSchema>
  readonly geometry: GeoJsonLineString | GeoJsonPolygon
  readonly at: IsoTimestamp
}): OperationalObject => ({
  id: config.spec.id,
  kind: 'zone',
  domain: trafficSimDomain,
  label: config.spec.label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    geometry: config.geometry,
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: config.spec.condition,
    priority: config.spec.severity === 'blocked' ? 'critical' : config.spec.severity === 'high' ? 'high' : 'normal',
    mode: 'simulated',
  },
  alerts: config.spec.severity === 'blocked' || config.spec.severity === 'high'
    ? [{
        id: `${config.spec.id}:traffic`,
        kind: 'traffic_condition',
        severity: config.spec.severity === 'blocked' ? 'critical' : 'warning',
        message: config.spec.reason,
        raisedAt: config.at,
        acknowledged: false,
      }]
    : [],
  provenance: {
    source: 'simulator',
    adapterId: trafficSimAdapterId,
    externalId: config.spec.id,
  },
  timestamps: {
    createdAt: config.at,
    updatedAt: config.at,
  },
  domainData: {
    type: 'traffic_condition',
    schemaVersion: 2,
    geometryMode: config.spec.geometryMode as TrafficGeometryMode,
    condition: config.spec.condition,
    severity: config.spec.severity,
    affectedModes: ['road_vehicle', 'emergency_vehicle'],
    ...(config.spec.speedFactor === undefined ? {} : { speedFactor: config.spec.speedFactor }),
    reason: confirmedFact(config.spec.reason, config.at, 'scenario', 1),
    startsAt: config.at,
    sourceKind: 'scenario',
    confidence: 1,
  } satisfies TrafficDomainData,
})

const geometryFor = async (
  spec: z.infer<typeof trafficConditionSpecSchema>,
  context: Parameters<PackScenarioSupport['expandObject']>[1],
): Promise<GeoJsonLineString | GeoJsonPolygon> => {
  if (spec.geometryMode === 'road_segment') {
    if (spec.from && spec.to) {
      const route = await context.routing.route({
        from: geoPointFromLonLat(spec.from[0], spec.from[1]),
        to: geoPointFromLonLat(spec.to[0], spec.to[1]),
      })
      return route.geometry
    }
    if (!spec.path) throw new Error(`traffic condition ${spec.id} requires from/to or path for road_segment geometry`)
    return lineStringFromPath(spec.path)
  }
  if (!spec.polygon) throw new Error(`traffic condition ${spec.id} requires polygon for area geometry`)
  return polygonFromPath(spec.polygon)
}

export const trafficScenarioSupport: PackScenarioSupport = {
  expandObject: async (rawSpec, context): Promise<OperationalObject> => {
    const spec = trafficConditionSpecSchema.parse(rawSpec)
    const object = trafficConditionObject({ spec, geometry: await geometryFor(spec, context), at: context.at })
    const parsed = trafficDomainDataSchema.safeParse(object.domainData)
    if (!parsed.success) throw new Error(`invalid scenario traffic object ${object.id}: ${parsed.error.message}`)
    return { ...object, domainData: parsed.data }
  },
  applyOperation: (rawOperation: PackScenarioOperationSpec): OperationalObject => {
    throw new Error(`traffic scenario operation is not supported yet: ${rawOperation.type}`)
  },
}
