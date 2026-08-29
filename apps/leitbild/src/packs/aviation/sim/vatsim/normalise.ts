import { z } from 'zod'
import { geoPointFromLonLat, nowIso, type AdapterId, type PackId, type IsoTimestamp, type OperationalObject } from '../../../../core/model/index.ts'
import {
  aircraftPackDataSchema,
  aircraftObjectId,
  aviationPackId,
  type AircraftPackData,
} from '../../model.ts'
import { aviationVatsimAdapterId } from '../constants.ts'
import type { VatsimBbox } from './constants.ts'

// VATSIM /v3/vatsim-data.json — the relevant slice is `pilots[]`. Each pilot
// is a connected flight-simulator client (not a real aircraft, unlike OpenSky).
// We keep the schema loose: VATSIM occasionally rolls out new fields and we
// don't want to brick the adapter on a benign addition.

const nullableNumber = z.union([z.number(), z.null()]).optional().transform(v => v ?? null)
const nullableString = z.union([z.string(), z.null()]).optional().transform(v => v ?? null)

const flightPlanSchema = z.object({
  flight_rules: nullableString,
  aircraft: nullableString,
  aircraft_faa: nullableString,
  aircraft_short: nullableString,
  departure: nullableString,
  arrival: nullableString,
  alternate: nullableString,
  cruise_tas: nullableString,
  altitude: nullableString,
  deptime: nullableString,
  enroute_time: nullableString,
  fuel_time: nullableString,
  remarks: nullableString,
  route: nullableString,
}).partial()

const pilotSchema = z.object({
  cid: z.number(),
  name: nullableString,
  callsign: nullableString,
  server: nullableString,
  pilot_rating: nullableNumber,
  latitude: nullableNumber,
  longitude: nullableNumber,
  altitude: nullableNumber,        // feet
  groundspeed: nullableNumber,     // knots
  transponder: nullableString,
  heading: nullableNumber,         // degrees
  qnh_i_hg: nullableNumber,
  qnh_mb: nullableNumber,
  flight_plan: flightPlanSchema.nullable().optional(),
  logon_time: nullableString,
  last_updated: nullableString,
}).passthrough()

export const vatsimDataSchema = z.object({
  pilots: z.array(pilotSchema).nullable().optional().transform(v => v ?? []),
}).passthrough()

export type VatsimPilot = z.infer<typeof pilotSchema>

export interface NormaliseVatsimOptions {
  /** Filter to a bbox client-side. Omit to keep the entire VATSIM world. */
  readonly bbox?: VatsimBbox
  /** Override `nowIso` for deterministic tests. */
  readonly now?: () => IsoTimestamp
}

const FT_TO_M = 0.3048
const KT_TO_MPS = 0.514444

const isInsideBbox = (lon: number, lat: number, bbox: VatsimBbox): boolean =>
  lat >= bbox.lamin && lat <= bbox.lamax && lon >= bbox.lomin && lon <= bbox.lomax

const buildPackData = (pilot: VatsimPilot): AircraftPackData => {
  const altFt = pilot.altitude
  const altM = altFt === null ? null : altFt * FT_TO_M
  const speedKt = pilot.groundspeed
  const velocityMps = speedKt === null ? null : speedKt * KT_TO_MPS
  const fp = pilot.flight_plan ?? null
  const flightPlan = fp
    ? {
        departure: fp.departure ?? null,
        arrival: fp.arrival ?? null,
        aircraftType: fp.aircraft_short ?? fp.aircraft ?? null,
        cruiseAltitudeFt: fp.altitude !== null && fp.altitude !== undefined
          ? Number.parseInt(fp.altitude, 10) || null
          : null,
        route: fp.route ?? null,
      }
    : null
  return aircraftPackDataSchema.parse({
    type: 'aircraft',
    schemaVersion: 1,
    source: 'vatsim',
    icao24: null,                 // VATSIM doesn't expose ICAO24 — use cid as externalId instead
    callsign: pilot.callsign,
    originCountry: null,          // VATSIM has no origin-country field
    altBaroM: altM,
    altGeoM: altM,
    velocityMps,
    headingDeg: pilot.heading,
    vertRateMps: null,             // VATSIM doesn't publish vertical rate
    onGround: (altFt ?? 0) < 100 && (speedKt ?? 0) < 30,
    squawk: pilot.transponder,
    lastSeenAt: null,              // VATSIM uses ISO timestamps, not unix
    flightPlan,
  })
}

const buildObject = (pilot: VatsimPilot, data: AircraftPackData, at: IsoTimestamp): OperationalObject => {
  if (pilot.longitude === null || pilot.latitude === null) {
    throw new Error('vatsim normalise: pilot missing position')
  }
  const label = data.callsign ?? `cid:${pilot.cid}`
  const externalId = String(pilot.cid)
  return {
    id: aircraftObjectId('vatsim', externalId) as OperationalObject['id'],
    kind: 'aircraft',
    packId: aviationPackId as PackId,
    label,
    lifecycle: 'active',
    revision: 0,
    spatial: {
      position: {
        point: geoPointFromLonLat(pilot.longitude, pilot.latitude),
        observedAt: at,
        staleAfterMs: 120_000,
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
      adapterId: aviationVatsimAdapterId as AdapterId,
      externalId,
    },
    timestamps: {
      createdAt: at,
      updatedAt: at,
    },
    packData: data,
  }
}

/** Normalise VATSIM /v3/vatsim-data.json to canonical aircraft objects.
 *  Pilots without position are dropped; if `bbox` is provided, pilots outside
 *  it are dropped too. */
export const normaliseVatsimData = (
  raw: unknown,
  options: NormaliseVatsimOptions = {},
): ReadonlyArray<OperationalObject> => {
  const parsed = vatsimDataSchema.parse(raw)
  const at = (options.now ?? nowIso)()
  const out: OperationalObject[] = []
  for (const pilot of parsed.pilots) {
    if (pilot.longitude === null || pilot.latitude === null) continue
    if (options.bbox && !isInsideBbox(pilot.longitude, pilot.latitude, options.bbox)) continue
    const data = buildPackData(pilot)
    out.push(buildObject(pilot, data, at))
  }
  return out
}

export const __internals = { pilotSchema, vatsimDataSchema, FT_TO_M, KT_TO_MPS, isInsideBbox }
