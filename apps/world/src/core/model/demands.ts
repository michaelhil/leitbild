import { z } from 'zod'
import { geoJsonPointSchema, type GeoJsonPoint } from './geo.ts'
import { idSchema, objectIdSchema, type ObjectId } from './ids.ts'

export const operationalDemandRequestedSignalType = 'operational.demand.requested'

export const operationalDemandCapabilitySchema = idSchema
export type OperationalDemandCapability = z.infer<typeof operationalDemandCapabilitySchema>

export interface OperationalDemandRequest {
  readonly schemaVersion: 1
  readonly demandId: string
  readonly capability: OperationalDemandCapability
  readonly sourceObjectId?: ObjectId
  readonly location: GeoJsonPoint
  readonly quantity?: number
  readonly severity: 'info' | 'notice' | 'warning' | 'critical'
  readonly title: string
  readonly description: string
}

export const operationalDemandRequestSchema = z.object({
  schemaVersion: z.literal(1),
  demandId: idSchema,
  capability: operationalDemandCapabilitySchema,
  sourceObjectId: objectIdSchema.optional(),
  location: geoJsonPointSchema,
  quantity: z.number().int().positive().optional(),
  severity: z.enum(['info', 'notice', 'warning', 'critical']),
  title: z.string().min(1),
  description: z.string().min(1),
}).strict()
