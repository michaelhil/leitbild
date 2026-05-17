import type { GeoJsonLineString, ObjectId } from '../../core/model/index.ts'
import { lat, lon } from '../../core/model/index.ts'
import type { TrafficCondition, TrafficSeverity } from './model.ts'

export interface TrafficConditionSeed {
  readonly id: ObjectId
  readonly label: string
  readonly geometry: GeoJsonLineString
  readonly condition: TrafficCondition
  readonly severity: TrafficSeverity
  readonly speedFactor: number
  readonly delaySecondsEstimate: number
  readonly reason: string
}

export interface TrafficScenario {
  readonly conditions: ReadonlyArray<TrafficConditionSeed>
}

export const createOsloTrafficScenario = (): TrafficScenario => ({
  conditions: [
    {
      id: 'traffic:ring2-slowdown' as ObjectId,
      label: 'Ring 2 slowdown',
      geometry: {
        type: 'LineString',
        coordinates: [
          [lon(10.7400), lat(59.9355)],
          [lon(10.7500), lat(59.9290)],
          [lon(10.7600), lat(59.9220)],
        ],
      },
      condition: 'slowdown',
      severity: 'high',
      speedFactor: 0.55,
      delaySecondsEstimate: 90,
      reason: 'Heavy traffic near the hospital access corridor',
    },
  ],
})
