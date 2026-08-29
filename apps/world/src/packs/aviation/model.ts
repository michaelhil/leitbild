import { z } from 'zod'

// Canonical aircraft packData for live-aircraft OperationalObjects emitted
// by the aviation pack's runtimes (OpenSky in B.2, VATSIM in B.3).
//
// Fields are best-effort: OpenSky frequently omits callsign / altitude / squawk
// for partially-observed aircraft, and VATSIM exposes a richer flight-plan
// shape. The schema accepts null for every observable field so runtimes can
// emit partial state without rejection.

export const aviationPackId = 'aviation' as const

export type AviationSourceId = 'opensky' | 'vatsim'

export const aircraftPackDataSchema = z.object({
  type: z.literal('aircraft'),
  schemaVersion: z.literal(1),
  source: z.enum(['opensky', 'vatsim']),
  icao24: z.string().min(1).nullable(),
  callsign: z.string().min(1).nullable(),
  originCountry: z.string().min(1).nullable(),
  altBaroM: z.number().nullable(),
  altGeoM: z.number().nullable(),
  velocityMps: z.number().nullable(),
  headingDeg: z.number().nullable(),
  vertRateMps: z.number().nullable(),
  onGround: z.boolean(),
  squawk: z.string().nullable(),
  /** UNIX timestamp seconds — when the source last had a position fix. */
  lastSeenAt: z.number().nullable(),
  /** VATSIM flight-plan extension, populated in B.3. */
  flightPlan: z.object({
    departure: z.string().min(1).nullable(),
    arrival: z.string().min(1).nullable(),
    aircraftType: z.string().min(1).nullable(),
    cruiseAltitudeFt: z.number().nullable(),
    route: z.string().min(1).nullable(),
  }).nullable().optional(),
})

export type AircraftPackData = z.infer<typeof aircraftPackDataSchema>

/** Aircraft id encoding: `aircraft:<source>:<icao24>` (OpenSky) or
 *  `aircraft:<source>:<cid>` (VATSIM). The source segment lets the runtime
 *  distinguish runtimes without parsing the suffix. */
export const aircraftObjectId = (source: AviationSourceId, externalId: string): string =>
  `aircraft:${source}:${externalId}`

/** Heuristic to recognise an aircraft OperationalObject without parsing
 *  packData (cheap for hot paths like the diff loop). */
export const isAircraftKind = (kind: string): boolean => kind === 'aircraft'

/** Convert metres above sea level to flight level (FL = altitude/100 ft).
 *  Used for display, not for safety-critical comparisons. */
export const altitudeToFlightLevel = (altM: number | null): number | null => {
  if (altM === null) return null
  return Math.round(altM / 30.48)
}

/** Convert m/s to knots (1 m/s = 1.94384 kt). Rounded to integer. */
export const velocityMpsToKnots = (mps: number | null): number | null =>
  mps === null ? null : Math.round(mps * 1.94384)
