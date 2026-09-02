import { z } from 'zod'
import type { IsoTimestamp, RouteImpact } from '../../core/model/index.ts'
import { geoJsonPointSchema } from '../../core/model/index.ts'
import type { PackScenarioAuthoringField } from '../../core/packs/protocol.ts'

const fraction = z.number().finite().min(0).max(1)
export const roadWeatherPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    wetnessFactor: fraction.default(0.8),
    iceFactor: fraction.default(0.35),
    snowFactor: fraction.default(0.55),
    visibilityThresholdM: z.number().finite().min(1).max(100000).default(1000),
    lowVisibilityFactor: fraction.default(0.5),
  })
  .strict()
  .default({
    enabled: false,
    wetnessFactor: 0.8,
    iceFactor: 0.35,
    snowFactor: 0.55,
    visibilityThresholdM: 1000,
    lowVisibilityFactor: 0.5,
  })
export const ambulancePackConfigSchema = z
  .object({ roadWeather: roadWeatherPolicySchema })
  .strict()
  .default({ roadWeather: roadWeatherPolicySchema.parse({}) })
export type RoadWeatherPolicy = z.infer<typeof roadWeatherPolicySchema>
export const roadWeatherCapability = 'world.weather.sample-points'
export const setRoadWeatherPolicyCapability = 'world.ambulance.set-road-weather-policy'

/** Consumer-owned read contract: no Weather implementation or state imports. */
export const roadWeatherSamplesSchema = z
  .array(
    z.object({
      point: geoJsonPointSchema,
      sample: z.object({
        state: z.object({
          atmosphere: z.object({ visibilityM: z.number().nonnegative() }),
          surface: z.object({ wetness: fraction, ice: fraction, snow: fraction }),
        }),
        quality: z.object({ validAt: z.string().datetime() }),
      }),
    }),
  )
  .max(512)
export type RoadWeatherSample = z.infer<typeof roadWeatherSamplesSchema>[number]['sample']
export const roadWeatherImpact = (policy: RoadWeatherPolicy, sample: RoadWeatherSample): RouteImpact | undefined => {
  const { surface, atmosphere } = sample.state
  const factors = [
    1 - surface.wetness * (1 - policy.wetnessFactor),
    1 - surface.ice * (1 - policy.iceFactor),
    1 - surface.snow * (1 - policy.snowFactor),
    atmosphere.visibilityM < policy.visibilityThresholdM ? policy.lowVisibilityFactor : 1,
  ]
  const speedFactor = Math.min(...factors)
  if (!policy.enabled || speedFactor >= 0.999) return
  return {
    source: { kind: 'runtime', id: 'ambulance.road-weather' },
    label: `Road-weather policy: ${Math.round(speedFactor * 100)}% speed (wet ${Math.round(surface.wetness * 100)}%, ice ${Math.round(surface.ice * 100)}%, snow ${Math.round(surface.snow * 100)}%, visibility ${Math.round(atmosphere.visibilityM)} m)`,
    severity: speedFactor === 0 ? 'blocked' : speedFactor < 0.5 ? 'high' : speedFactor < 0.8 ? 'moderate' : 'low',
    speedFactor,
    updatedAt: sample.quality.validAt as IsoTimestamp,
  }
}
const defaults = roadWeatherPolicySchema.parse({})
export const roadWeatherFields: ReadonlyArray<PackScenarioAuthoringField> = [
  {
    target: 'item',
    path: ['roadWeather', 'enabled'],
    label: 'Respond to Weather (requires Weather Pack)',
    control: { kind: 'boolean', defaultValue: false },
  },
  ...(['wetnessFactor', 'iceFactor', 'snowFactor', 'lowVisibilityFactor', 'visibilityThresholdM'] as const).map(
    (key) => ({
      target: 'item' as const,
      path: ['roadWeather', key],
      label: key === 'visibilityThresholdM' ? 'Low visibility below (m)' : key.replace('Factor', ' speed factor'),
      control: {
        kind: 'number' as const,
        defaultValue: defaults[key],
        min: key === 'visibilityThresholdM' ? 1 : 0,
        max: key === 'visibilityThresholdM' ? 100000 : 1,
        step: key === 'visibilityThresholdM' ? 100 : 0.05,
      },
    }),
  ),
]
