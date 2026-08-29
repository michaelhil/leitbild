import { z } from 'zod'

// Canonical airport feature properties.
// All airport sources (GeoNorge Avinor today, others tomorrow) must produce features
// whose properties pass this schema. The reference-data pipeline validates each feature
// against it at build time.

export const airportFeatureSchema = z.object({
  name: z.string().min(1),
  icao: z.string().regex(/^[A-Z]{4}$/).nullable(),
  iata: z.string().regex(/^[A-Z]{3}$/).nullable(),
  elevationM: z.number().nullable(),
  municipalityCode: z.string().nullable(),
  localId: z.string(),
  country: z.string().min(2).max(2),
  source: z.string().min(1),
  sourceExternalId: z.string(),
})

export type AirportFeatureProperties = z.infer<typeof airportFeatureSchema>
