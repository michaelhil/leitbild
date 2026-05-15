import { z } from 'zod'
import { knowledgeFactSchema, type KnowledgeFact, type ObjectId } from '../../core/model/index.ts'

export const ambulanceDomainId = 'ambulance_dispatch' as const

export const ambulanceStatusSchema = z.enum([
  'available',
  'assigned',
  'en_route',
  'on_scene',
  'transporting',
  'at_hospital',
  'out_of_service',
])
export type AmbulanceStatus = z.infer<typeof ambulanceStatusSchema>

export const incidentStatusSchema = z.enum(['open', 'assigned', 'responding', 'resolved'])
export type IncidentStatus = z.infer<typeof incidentStatusSchema>

export const ambulanceDomainDataSchema = z.object({
  type: z.literal('ambulance'),
  schemaVersion: z.literal(1),
  capabilities: z.array(z.enum([
    'advanced_life_support',
    'basic_life_support',
    'defibrillator',
    'oxygen',
    'stretcher',
    'ventilator',
  ])),
  crew: z.object({
    status: z.enum(['ready', 'busy', 'unavailable']),
    level: knowledgeFactSchema(z.enum(['basic', 'advanced', 'critical_care'])),
    availableSeats: knowledgeFactSchema(z.number().int().nonnegative()),
  }),
})
export type AmbulanceDomainData = z.infer<typeof ambulanceDomainDataSchema>

export const injurySummarySchema = z.object({
  category: z.enum(['trauma', 'cardiac', 'respiratory', 'burn', 'unknown']),
  severity: z.enum(['minor', 'serious', 'critical', 'unknown']),
  count: z.number().int().positive(),
})
export type InjurySummary = z.infer<typeof injurySummarySchema>

export const incidentDomainDataSchema = z.object({
  type: z.literal('incident'),
  schemaVersion: z.literal(1),
  triage: knowledgeFactSchema(z.enum(['green', 'yellow', 'red'])),
  victims: z.object({
    count: knowledgeFactSchema(z.number().int().nonnegative()),
    injuries: knowledgeFactSchema(z.array(injurySummarySchema)),
    entrapment: knowledgeFactSchema(z.boolean()),
  }),
  hazards: knowledgeFactSchema(z.array(z.string().min(1))),
  assignedAmbulanceId: z.string().optional(),
})
export type IncidentDomainData = z.infer<typeof incidentDomainDataSchema>

export const hospitalDomainDataSchema = z.object({
  type: z.literal('hospital'),
  schemaVersion: z.literal(1),
  emergencyDepartment: z.object({
    traumaBedsAvailable: knowledgeFactSchema(z.number().int().nonnegative()),
    ambulanceBaysAvailable: knowledgeFactSchema(z.number().int().nonnegative()),
    diversionStatus: knowledgeFactSchema(z.enum(['open', 'limited', 'closed'])),
  }),
  capabilities: z.array(z.enum([
    'trauma_center',
    'stroke_unit',
    'cardiac_catheterization',
    'pediatric_emergency',
    'burn_unit',
  ])),
})
export type HospitalDomainData = z.infer<typeof hospitalDomainDataSchema>

export type AmbulanceControlDomainData = AmbulanceDomainData | IncidentDomainData | HospitalDomainData

export const factSummary = <T>(fact: KnowledgeFact<T>, formatter: (value: T) => string = String): string =>
  fact.state === 'unknown' ? 'unknown' : formatter(fact.value)

export interface AmbulanceAssignment {
  readonly ambulanceId: ObjectId
  readonly incidentId: ObjectId
}
