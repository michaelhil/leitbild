import { z } from 'zod'
import { knowledgeFactSchema } from '../../core/model/index.ts'

export const trafficDomainId = 'traffic' as const

export const trafficConditionSchema = z.enum(['congestion', 'closure', 'slowdown', 'access_restricted'])
export type TrafficCondition = z.infer<typeof trafficConditionSchema>

export const trafficSeveritySchema = z.enum(['low', 'moderate', 'high', 'blocked'])
export type TrafficSeverity = z.infer<typeof trafficSeveritySchema>

export const trafficDomainDataSchema = z.object({
  type: z.literal('traffic_condition'),
  schemaVersion: z.literal(1),
  condition: trafficConditionSchema,
  severity: trafficSeveritySchema,
  affectedModes: z.array(z.enum(['road_vehicle', 'emergency_vehicle'])),
  speedFactor: z.number().finite().positive().optional(),
  delaySecondsEstimate: knowledgeFactSchema(z.number().finite().nonnegative()).optional(),
  reason: knowledgeFactSchema(z.string().min(1)),
  startsAt: z.string().datetime(),
  clearsAt: knowledgeFactSchema(z.string().datetime()).optional(),
})
export type TrafficDomainData = z.infer<typeof trafficDomainDataSchema>
