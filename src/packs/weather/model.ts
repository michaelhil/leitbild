import { z } from 'zod'
import { geoJsonPointSchema } from '../../core/model/index.ts'

export const weatherDomainId = 'weather' as const

export const precipitationTypeSchema = z.enum(['none', 'rain', 'snow', 'sleet', 'freezing_rain', 'hail'])
export type PrecipitationType = z.infer<typeof precipitationTypeSchema>

export const frictionClassSchema = z.enum(['normal', 'wet', 'slippery', 'icy', 'blocked'])
export type FrictionClass = z.infer<typeof frictionClassSchema>

export const weatherProvenanceKindSchema = z.enum(['scenario', 'forecast', 'observed', 'inferred', 'intervention'])
export type WeatherProvenanceKind = z.infer<typeof weatherProvenanceKindSchema>

export const weatherSeveritySchema = z.enum(['normal', 'notice', 'adverse', 'hazard'])
export type WeatherSeverity = z.infer<typeof weatherSeveritySchema>

const normalizedSchema = z.number().finite().min(0).max(1)

const precipitationSchema = z.object({
  type: precipitationTypeSchema,
  intensityMmPerHour: z.number().finite().nonnegative(),
})

export const weatherAtmosphereSchema = z.object({
  airTemperatureC: z.number().finite(),
  humidity: normalizedSchema.optional(),
  windSpeedMps: z.number().finite().nonnegative(),
  windDirectionDeg: z.number().finite().min(0).max(360),
  visibilityM: z.number().finite().nonnegative(),
  cloudCover: normalizedSchema.optional(),
  precipitation: precipitationSchema,
  labels: z.array(z.string().min(1)).default([]),
})
export type WeatherAtmosphere = z.infer<typeof weatherAtmosphereSchema>
export const weatherAtmospherePatchSchema = weatherAtmosphereSchema.partial()
export type WeatherAtmospherePatch = z.infer<typeof weatherAtmospherePatchSchema>

export const weatherSurfaceSchema = z.object({
  groundTemperatureC: z.number().finite(),
  wetness: normalizedSchema,
  standingWater: normalizedSchema,
  snow: normalizedSchema,
  ice: normalizedSchema,
  frost: normalizedSchema,
  frictionEstimate: normalizedSchema.optional(),
  frictionClass: frictionClassSchema,
  labels: z.array(z.string().min(1)).default([]),
})
export type WeatherSurface = z.infer<typeof weatherSurfaceSchema>
export const weatherSurfacePatchSchema = weatherSurfaceSchema.partial()
export type WeatherSurfacePatch = z.infer<typeof weatherSurfacePatchSchema>

export const weatherQualitySchema = z.object({
  provenance: weatherProvenanceKindSchema,
  confidence: normalizedSchema,
  validAt: z.string().datetime(),
})
export type WeatherQuality = z.infer<typeof weatherQualitySchema>

export const numericTrendSchema = z.object({
  from: z.number().finite(),
  to: z.number().finite(),
})
export type NumericTrend = z.infer<typeof numericTrendSchema>

export const precipitationTrendSchema = z.object({
  type: precipitationTypeSchema.optional(),
  intensityMmPerHour: numericTrendSchema.optional(),
})
export type PrecipitationTrend = z.infer<typeof precipitationTrendSchema>

export const weatherEvolutionSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  airTemperatureC: numericTrendSchema.optional(),
  groundTemperatureC: numericTrendSchema.optional(),
  visibilityM: numericTrendSchema.optional(),
  windSpeedMps: numericTrendSchema.optional(),
  humidity: numericTrendSchema.optional(),
  cloudCover: numericTrendSchema.optional(),
  precipitation: precipitationTrendSchema.optional(),
})
export type WeatherEvolution = z.infer<typeof weatherEvolutionSchema>

export const weatherRenderSchema = z.object({
  cellSizeM: z.number().finite().positive(),
  showField: z.boolean().default(true),
})
export type WeatherRender = z.infer<typeof weatherRenderSchema>

export const weatherStateSchema = z.object({
  atmosphere: weatherAtmosphereSchema,
  surface: weatherSurfaceSchema,
})
export type WeatherState = z.infer<typeof weatherStateSchema>

export const weatherFalloffPointSchema = z.object({
  x: normalizedSchema,
  y: normalizedSchema,
})
export type WeatherFalloffPoint = z.infer<typeof weatherFalloffPointSchema>

export const weatherFalloffCurveSchema = z.array(weatherFalloffPointSchema).min(2)
  .superRefine((points, ctx) => {
    let previousX = Number.NEGATIVE_INFINITY
    for (const [index, point] of points.entries()) {
      if (point.x < previousX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'falloff curve x values must be sorted ascending',
          path: [index, 'x'],
        })
      }
      previousX = point.x
    }
  })
export type WeatherFalloffCurve = z.infer<typeof weatherFalloffCurveSchema>

export const weatherInfluenceKeyframeSchema = z.object({
  atSeconds: z.number().finite().nonnegative(),
  center: geoJsonPointSchema,
  semiMajorAxisM: z.number().finite().positive(),
  semiMinorAxisM: z.number().finite().positive(),
  rotationDeg: z.number().finite(),
  state: weatherStateSchema,
  falloffCurve: weatherFalloffCurveSchema,
})
export type WeatherInfluenceKeyframe = z.infer<typeof weatherInfluenceKeyframeSchema>

export const weatherInfluenceSchema = z.object({
  priority: z.number().int().default(0),
  keyframes: z.array(weatherInfluenceKeyframeSchema).min(1),
})
export type WeatherInfluence = z.infer<typeof weatherInfluenceSchema>

export const weatherDomainDataSchema = z.object({
  type: z.literal('weather_condition'),
  schemaVersion: z.literal(1),
  conditionKind: z.enum(['weather_influence', 'point_observation']),
  severity: weatherSeveritySchema,
  atmosphere: weatherAtmosphereSchema,
  surface: weatherSurfaceSchema,
  quality: weatherQualitySchema,
  influence: weatherInfluenceSchema.optional(),
  evolution: weatherEvolutionSchema.optional(),
  render: weatherRenderSchema.optional(),
  summary: z.string().min(1),
})
export type WeatherDomainData = z.infer<typeof weatherDomainDataSchema>

export const createWeatherAreaPayloadSchema = z.object({
  objectType: z.literal('weather_area'),
  label: z.string().min(1).max(80),
  summary: z.string().min(1).max(180).default('Operator-created weather area'),
  severity: weatherSeveritySchema.default('notice'),
  atmosphere: weatherAtmospherePatchSchema.optional(),
  surface: weatherSurfacePatchSchema.optional(),
  center: geoJsonPointSchema.optional(),
  semiMajorAxisM: z.number().finite().positive().optional(),
  semiMinorAxisM: z.number().finite().positive().optional(),
  rotationDeg: z.number().finite().default(0),
  falloffCurve: weatherFalloffCurveSchema.default([{ x: 0, y: 1 }, { x: 1, y: 0 }]),
}).superRefine((payload, ctx) => {
  if (!payload.center) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'weather area requires center', path: ['center'] })
  }
  if (payload.semiMajorAxisM === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'weather area requires semiMajorAxisM', path: ['semiMajorAxisM'] })
  }
  if (payload.semiMinorAxisM === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'weather area requires semiMinorAxisM', path: ['semiMinorAxisM'] })
  }
})
export type CreateWeatherAreaPayload = z.infer<typeof createWeatherAreaPayloadSchema>

export const createWeatherProbePayloadSchema = z.object({
  objectType: z.literal('weather_probe'),
  label: z.string().min(1).max(80),
  point: geoJsonPointSchema,
})
export type CreateWeatherProbePayload = z.infer<typeof createWeatherProbePayloadSchema>

export const createWeatherConditionPayloadSchema = z.union([
  createWeatherAreaPayloadSchema,
  createWeatherProbePayloadSchema,
])
export type CreateWeatherConditionPayload = z.infer<typeof createWeatherConditionPayloadSchema>

export interface WeatherSample {
  readonly severity: WeatherSeverity
  readonly atmosphere: WeatherAtmosphere
  readonly surface: WeatherSurface
  readonly quality: WeatherQuality
  readonly sourceObjectIds: ReadonlyArray<string>
}
