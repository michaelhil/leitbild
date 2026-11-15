import { nowIso, operationalObjectSchema, type ObjectAudience, type OperationalObject } from '../../../core/model/index.ts'
import { lonLat } from './run-harness.ts'

/**
 * Test-only fixtures for the Einsatz links to other Packs
 * (`interactions/`): an object of another Pack that observes, and the
 * Weather Pack Selection of a Run whose ground and air slow road units.
 * Production code never imports this file.
 */

/** An object of another Pack, such as a Drone Pack drone, at a point east of the fixture origin. */
export const observerObject = (id: string, label: string, options: { readonly packId?: string; readonly east?: number; readonly audience?: ObjectAudience } = {}): OperationalObject => {
  const at = nowIso()
  return operationalObjectSchema.parse({
    id,
    kind: 'mobile_entity',
    packId: options.packId ?? 'drone',
    label,
    lifecycle: 'active',
    revision: 0,
    spatial: { frame: { kind: 'wgs84' }, position: { point: { type: 'Point', coordinates: lonLat(options.east ?? 0.01) }, observedAt: at } },
    operational: { status: 'airborne', mode: 'simulated' },
    alerts: [],
    provenance: { source: 'simulator' },
    timestamps: { createdAt: at, updatedAt: at },
    ...(options.audience === undefined ? {} : { audience: options.audience }),
  }) as OperationalObject
}

/**
 * A Weather Pack Selection: dry, unfrozen ground under one area of 700 m
 * visibility, uniform over the fixture origin and far beyond it, so every
 * Einsatz unit near the origin stands in fog.
 */
export const foggyWeather = {
  id: 'weather',
  config: { gridResolution: 8, surface: { groundTemperatureC: 4, wetness: 0, standingWater: 0, snow: 0, ice: 0, frost: 0 } },
  items: [{
    type: 'weather_area', id: 'weather:fog', label: 'Fog bank', center: lonLat(0), semiMajorAxisM: 20_000, semiMinorAxisM: 20_000, falloff: 'uniform',
    atmosphere: { visibilityM: 700 },
  }],
} as const
