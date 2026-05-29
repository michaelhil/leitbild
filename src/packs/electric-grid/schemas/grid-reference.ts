import { z } from 'zod'

const provenanceSchema = z.enum(['observed', 'converted', 'inferred', 'configured', 'defaulted', 'unknown'])
const confidenceSchema = z.enum(['high', 'medium', 'low'])

export const gridReferenceCategorySchema = z.enum([
  'line',
  'cable',
  'substation',
  'transformer',
  'plant',
  'generator',
  'load',
  'unknown',
])

export type GridReferenceCategory = z.infer<typeof gridReferenceCategorySchema>

export const gridReferenceFeatureSchema = z.object({
  source: z.string().min(1),
  category: gridReferenceCategorySchema,
  assetKind: z.enum(['branch', 'node', 'generator', 'load', 'unknown']),
  externalId: z.string().min(1),
  name: z.string().min(1).nullable(),
  operator: z.string().min(1).nullable(),
  voltageKv: z.array(z.number().finite().positive()),
  maxVoltageKv: z.number().finite().positive().nullable(),
  frequencyHz: z.number().finite().positive().nullable(),
  circuits: z.number().int().positive().nullable(),
  cables: z.number().int().positive().nullable(),
  power: z.string().min(1).nullable(),
  plantSource: z.string().min(1).nullable(),
  outputMw: z.number().finite().nonnegative().nullable(),
  geometrySource: z.enum(['osm-geometry', 'osm-node', 'source-geometry', 'bounds-centroid', 'manual']),
  propertyProvenance: provenanceSchema,
  confidence: confidenceSchema,
  tags: z.record(z.string()),
})

export type GridReferenceFeatureProperties = z.infer<typeof gridReferenceFeatureSchema>
