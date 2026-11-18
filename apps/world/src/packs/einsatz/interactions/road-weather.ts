import { z } from 'zod'
import { geoJsonPointSchema, type IsoTimestamp, type RouteImpact } from '../../../core/model/index.ts'
import type { PackRuntimeQueries } from '../../../simulation/protocol.ts'
import { setRouteImpacts } from '../engine/engine.ts'
import { motionOf, unitTypeOf, type EngineState } from '../engine/model.ts'
import { sameValue } from '../engine/values.ts'

/**
 * Road weather. In a Run whose Scenario also has the Weather Pack, each
 * road unit moves at the pace that the ground and the visibility at its
 * position allow. Einsatz reads Weather only through its published
 * `world.weather.sample-points` query, with a schema owned here, and imports
 * nothing of the Weather Pack. The pace is a canonical route impact set with
 * the engine's `setRouteImpacts`, so the engine's movement, every ETA and
 * `world.einsatz.recommend` slow by it alike.
 *
 * It is a heuristic: sampled at the unit's position each time the runtime
 * advances, and applied to its whole leg until the next sample. It is not a
 * whole-route forecast or a tyre-friction model. Units that fly straight
 * lines (`direct` mobility) are not slowed.
 */

export const roadWeatherQueryId = 'world.weather.sample-points'
const roadWeatherSource = { kind: 'runtime', id: 'einsatz.road-weather' } as const

/** The pace each ground condition allows at full strength, and the pace below `lowVisibilityBelowM`. */
const paceAtFull = { wetness: 0.8, ice: 0.35, snow: 0.55 } as const
const lowVisibilityPace = 0.5
const lowVisibilityBelowM = 1_000
/** The most points one Weather read takes. */
const pointsPerRead = 512

const fraction = z.number().finite().min(0).max(1)
/** The part of a Weather sample Einsatz reads; Weather's other fields are not Einsatz's concern. */
const samplesSchema = z.array(z.object({
  point: geoJsonPointSchema,
  sample: z.object({
    state: z.object({
      atmosphere: z.object({ visibilityM: z.number().finite().nonnegative() }),
      surface: z.object({ wetness: fraction, ice: fraction, snow: fraction }),
    }),
    quality: z.object({ validAt: z.string().datetime() }),
  }),
})).max(pointsPerRead)
export type RoadWeatherSample = z.output<typeof samplesSchema>[number]['sample']

const percent = (value: number): number => Math.round(value * 100)

/** The route impact of the weather at one point, or undefined where it does not slow a road unit. */
export const roadWeatherImpact = (sample: RoadWeatherSample): RouteImpact | undefined => {
  const { surface, atmosphere } = sample.state
  const speedFactor = Math.min(
    1 - surface.wetness * (1 - paceAtFull.wetness),
    1 - surface.ice * (1 - paceAtFull.ice),
    1 - surface.snow * (1 - paceAtFull.snow),
    atmosphere.visibilityM < lowVisibilityBelowM ? lowVisibilityPace : 1,
  )
  if (speedFactor >= 0.999) return undefined
  return {
    source: roadWeatherSource,
    label: `Road weather: ${percent(speedFactor)}% speed (wet ${percent(surface.wetness)}%, ice ${percent(surface.ice)}%, snow ${percent(surface.snow)}%, visibility ${Math.round(atmosphere.visibilityM)} m)`,
    severity: speedFactor < 0.5 ? 'high' : speedFactor < 0.8 ? 'moderate' : 'low',
    speedFactor,
    updatedAt: sample.quality.validAt as IsoTimestamp,
  }
}

const isRoadWeather = (impact: RouteImpact): boolean => impact.source.kind === roadWeatherSource.kind && impact.source.id === roadWeatherSource.id
/** Impacts compared without their sample time, so a sample that slows a unit the same way changes nothing. */
const sameImpacts = (a: ReadonlyArray<RouteImpact>, b: ReadonlyArray<RouteImpact>): boolean =>
  sameValue(a.map(({ updatedAt: _, ...impact }) => impact), b.map(({ updatedAt: _, ...impact }) => impact))

/**
 * The state with each road unit's road-weather impact read from Weather at
 * its position now. Without the Weather Pack in the Run it is the state
 * itself. A Weather answer for other points than asked is an error.
 */
export const withRoadWeather = async (state: EngineState, queries: PackRuntimeQueries | undefined): Promise<EngineState> => {
  if (queries === undefined || !queries.has(roadWeatherQueryId)) return state
  const road = [...state.units.values()].filter(unit => unitTypeOf(state.catalog, unit).components.mobility?.mode === 'road')
  let next = state
  for (let offset = 0; offset < road.length; offset += pointsPerRead) {
    const batch = road.slice(offset, offset + pointsPerRead)
    const points = batch.map(unit => motionOf(state, unit.id).point)
    const samples = samplesSchema.parse(await queries.invoke({ capabilityId: roadWeatherQueryId, input: { points } }))
    if (samples.length !== batch.length) throw new Error(`Weather answered ${samples.length} samples for ${batch.length} road units`)
    batch.forEach((unit, index) => {
      const sampled = samples[index]!
      if (!sameValue(sampled.point.coordinates, points[index]!.coordinates)) throw new Error(`Weather answered for another point than ${unit.label}'s`)
      const previous = motionOf(next, unit.id).impacts
      const impact = roadWeatherImpact(sampled.sample)
      const impacts = [...previous.filter(entry => !isRoadWeather(entry)), ...(impact === undefined ? [] : [impact])]
      if (!sameImpacts(previous, impacts)) next = setRouteImpacts(next, unit.id, impacts)
    })
  }
  return next
}
