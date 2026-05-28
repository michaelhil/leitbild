import { z } from 'zod'
import { geoPointFromLonLat, nowIso, type AdapterId, type PackId, type IsoTimestamp, type OperationalObject } from '../../../../core/model/index.ts'
import {
  aircraftPackDataSchema,
  aircraftObjectId,
  aviationPackId,
  type AircraftPackData,
} from '../../model.ts'
import { aviationOpenSkyAdapterId } from '../constants.ts'

// OpenSky V2 /api/states/all returns:
//   { time: number, states: ReadonlyArray<StateVectorRow> | null }
// Each row is a positional array:
//   [icao24, callsign, origin_country, time_position, last_contact,
//    longitude, latitude, baro_altitude, on_ground, velocity, true_track,
//    vertical_rate, sensors, geo_altitude, squawk, spi, position_source, category]
//
// Many fields are nullable for partially-observed aircraft. We accept everything
// the API can throw at us and degrade gracefully to "unknown" when needed.

const nullableNumber = z.number().nullable().or(z.null()).optional().transform(v => v ?? null)
const nullableString = z.string().nullable().or(z.null()).optional().transform(v => v ?? null)

const stateVectorRow = z.tuple([
  z.string(),                                // 0: icao24
  z.string().nullable(),                      // 1: callsign
  z.string().nullable(),                      // 2: origin_country
  z.number().nullable(),                      // 3: time_position
  z.number().nullable(),                      // 4: last_contact
  z.number().nullable(),                      // 5: longitude
  z.number().nullable(),                      // 6: latitude
  z.number().nullable(),                      // 7: baro_altitude (metres)
  z.boolean(),                                // 8: on_ground
  z.number().nullable(),                      // 9: velocity (m/s)
  z.number().nullable(),                      // 10: true_track (degrees)
  z.number().nullable(),                      // 11: vertical_rate (m/s)
  z.array(z.number()).nullable(),             // 12: sensors
  z.number().nullable(),                      // 13: geo_altitude (metres)
  z.string().nullable(),                      // 14: squawk
  z.boolean().nullable(),                     // 15: spi
  z.number().nullable(),                      // 16: position_source
]).rest(z.unknown()) // tolerate trailing fields (e.g. category)

export const statesAllSchema = z.object({
  time: z.number(),
  states: z.array(stateVectorRow).nullable().transform(v => v ?? []),
})

export type OpenSkyStatesAllPayload = z.infer<typeof statesAllSchema>

const trimmedOrNull = (s: string | null): string | null => {
  if (s === null) return null
  const t = s.trim()
  return t.length === 0 ? null : t
}

const ALL_AIRCRAFT_CATEGORY = 'aircraft'

export interface NormaliseOpenSkyOptions {
  /** Drop entries without a lat/lon fix. Default true — operational displays need a position. */
  readonly requirePosition?: boolean
  /** Override `nowIso` for deterministic tests. */
  readonly now?: () => IsoTimestamp
}

const buildAircraftPackData = (row: z.infer<typeof stateVectorRow>): AircraftPackData =>
  aircraftPackDataSchema.parse({
    type: 'aircraft',
    schemaVersion: 1,
    source: 'opensky',
    icao24: trimmedOrNull(row[0]),
    callsign: trimmedOrNull(row[1]),
    originCountry: trimmedOrNull(row[2]),
    altBaroM: row[7],
    altGeoM: row[13],
    velocityMps: row[9],
    headingDeg: row[10],
    vertRateMps: row[11],
    onGround: row[8],
    squawk: trimmedOrNull(row[14]),
    lastSeenAt: row[4],
  })

const buildOperationalObject = (
  row: z.infer<typeof stateVectorRow>,
  data: AircraftPackData,
  at: IsoTimestamp,
): OperationalObject => {
  const lon = row[5]
  const lat = row[6]
  if (lon === null || lat === null) throw new Error('opensky normalise: row has no position')
  const callsign = data.callsign ?? data.icao24 ?? 'unknown'
  return {
    id: aircraftObjectId('opensky', row[0]) as OperationalObject['id'],
    kind: 'aircraft',
    packId: aviationPackId as PackId,
    label: callsign,
    lifecycle: 'active',
    revision: 0,
    spatial: {
      position: {
        point: geoPointFromLonLat(lon, lat),
        observedAt: at,
        staleAfterMs: 60_000,
      },
      frame: { kind: 'wgs84' },
    },
    operational: {
      status: data.onGround ? 'idle' : 'active',
      mode: 'live',
    },
    alerts: [],
    provenance: {
      source: 'simulator',
      adapterId: aviationOpenSkyAdapterId as AdapterId,
      externalId: row[0],
    },
    timestamps: {
      createdAt: at,
      updatedAt: at,
    },
    packData: data,
  }
}

/** Normalise the OpenSky /states/all payload to canonical aircraft OperationalObjects.
 *  Rows without a position are dropped by default. */
export const normaliseOpenSkyStates = (
  raw: unknown,
  options: NormaliseOpenSkyOptions = {},
): ReadonlyArray<OperationalObject> => {
  const parsed = statesAllSchema.parse(raw)
  const at = (options.now ?? nowIso)()
  const requirePosition = options.requirePosition ?? true
  const out: OperationalObject[] = []
  for (const row of parsed.states) {
    if (requirePosition && (row[5] === null || row[6] === null)) continue
    const data = buildAircraftPackData(row)
    out.push(buildOperationalObject(row, data, at))
  }
  return out
}

export const __internals = { stateVectorRow, statesAllSchema, ALL_AIRCRAFT_CATEGORY }
