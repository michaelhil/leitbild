import { z } from 'zod'
import { geoJsonLineStringSchema, geoJsonPointSchema, geoJsonPolygonSchema, knowledgeFactSchema } from '../../core/model/index.ts'

export const trafficDomainId = 'traffic' as const

export const trafficConditionSchema = z.enum(['free_flow', 'congestion', 'closure', 'slowdown', 'access_restricted'])
export type TrafficCondition = z.infer<typeof trafficConditionSchema>

export const trafficSeveritySchema = z.enum(['low', 'moderate', 'high', 'blocked'])
export type TrafficSeverity = z.infer<typeof trafficSeveritySchema>

export const trafficGeometryModeSchema = z.enum(['road_segment', 'area'])
export type TrafficGeometryMode = z.infer<typeof trafficGeometryModeSchema>

export const trafficMobilityModeSchema = z.enum(['road_vehicle', 'emergency_vehicle', 'drone', 'vessel', 'pedestrian'])
export type TrafficMobilityMode = z.infer<typeof trafficMobilityModeSchema>

export const trafficDomainDataSchema = z.object({
  type: z.literal('traffic_condition'),
  schemaVersion: z.literal(2),
  geometryMode: trafficGeometryModeSchema,
  condition: trafficConditionSchema,
  severity: trafficSeveritySchema,
  affectedModes: z.array(trafficMobilityModeSchema),
  speedFactor: z.number().finite().positive().optional(),
  averageSpeedMps: z.number().finite().positive().optional(),
  delaySecondsEstimate: knowledgeFactSchema(z.number().finite().nonnegative()).optional(),
  reason: knowledgeFactSchema(z.string().min(1)),
  startsAt: z.string().datetime(),
  clearsAt: knowledgeFactSchema(z.string().datetime()).optional(),
  sourceKind: z.enum(['scenario', 'operator', 'simulation', 'external_feed']),
  confidence: z.number().finite().min(0).max(1).optional(),
})
export type TrafficDomainData = z.infer<typeof trafficDomainDataSchema>

export const createTrafficRoadSegmentPayloadSchema = z.object({
  objectType: z.literal('traffic_road_segment'),
  label: z.string().min(1).max(80),
  from: geoJsonPointSchema,
  to: geoJsonPointSchema,
  condition: trafficConditionSchema.default('slowdown'),
  severity: trafficSeveritySchema,
  speedFactor: z.number().finite().positive().max(1).optional(),
  reason: z.string().min(1).max(160),
})
export type CreateTrafficRoadSegmentPayload = z.infer<typeof createTrafficRoadSegmentPayloadSchema>

export const createTrafficAreaPayloadSchema = z.object({
  objectType: z.literal('traffic_area'),
  label: z.string().min(1).max(80),
  polygon: geoJsonPolygonSchema,
  condition: trafficConditionSchema.default('slowdown'),
  severity: trafficSeveritySchema,
  speedFactor: z.number().finite().positive().max(1).optional(),
  reason: z.string().min(1).max(160),
})
export type CreateTrafficAreaPayload = z.infer<typeof createTrafficAreaPayloadSchema>

export const createTrafficConditionPayloadSchema = z.union([
  createTrafficRoadSegmentPayloadSchema,
  createTrafficAreaPayloadSchema,
])
export type CreateTrafficConditionPayload = z.infer<typeof createTrafficConditionPayloadSchema>

export const trafficGeometrySchema = z.union([
  geoJsonLineStringSchema,
  geoJsonPolygonSchema,
])
