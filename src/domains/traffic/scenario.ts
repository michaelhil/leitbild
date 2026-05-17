import type { GeoJsonLineString, GeoJsonPolygon, ObjectId } from '../../core/model/index.ts'
import type { TrafficCondition, TrafficGeometryMode, TrafficSeverity } from './model.ts'

export interface TrafficConditionSeed {
  readonly id: ObjectId
  readonly label: string
  readonly geometryMode: TrafficGeometryMode
  readonly geometry: GeoJsonLineString | GeoJsonPolygon
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
  conditions: [],
})
