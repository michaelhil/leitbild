import { z } from 'zod'

// Canonical airspace feature properties.
// All airspace sources (OpenAIP today, others tomorrow) must produce features whose
// properties pass this schema. The reference-data pipeline validates each feature
// against it at build time.

export const verticalReferenceSchema = z.enum(['GND', 'MSL', 'STD', 'UNL'])

export const airspaceClassSchema = z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G'])

export const airspaceCategorySchema = z.enum([
  'fir', 'uir',
  'cta', 'tma', 'ctr', 'atz',
  'restricted', 'prohibited', 'danger', 'warning',
  'rmz', 'tmz', 'matz',
  'training',
  'class_a', 'class_b', 'class_c', 'class_d', 'class_e', 'class_f', 'class_g',
  'unknown',
])

export type AirspaceCategory = z.infer<typeof airspaceCategorySchema>

export const airspaceFeatureSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  classLetter: airspaceClassSchema.nullable(),
  floorM: z.number().nullable(),
  ceilingM: z.number().nullable(),
  floorRef: verticalReferenceSchema,
  ceilingRef: verticalReferenceSchema,
  floorLabel: z.string().min(1),
  ceilingLabel: z.string().min(1),
  activity: z.string().nullable(),
  activatedByNotam: z.boolean(),
  frequencyMhz: z.number().nullable(),
  callsign: z.string().nullable(),
  remarks: z.string().nullable(),
  source: z.literal('openaip'),
  sourceExternalId: z.string().nullable(),
  country: z.string().min(2).max(2),
})

export type AirspaceFeatureProperties = z.infer<typeof airspaceFeatureSchema>
