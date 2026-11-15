import { nowIso, operationalObjectSchema, type ObjectAudience, type OperationalObject } from '../../../core/model/index.ts'
import { lonLat } from './run-harness.ts'

/**
 * Test-only fixtures for the Einsatz links to other Packs
 * (`interactions/`): an object of another Pack that observes. Production
 * code never imports this file.
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

