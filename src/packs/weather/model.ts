import { z } from 'zod'
import { geoJsonPointSchema } from '../../core/model/index.ts'

export const weatherDomainId = 'weather' as const

export const precipitationTypeSchema = z.enum(['none', 'rain', 'snow', 'sleet', 'freezing_rain', 'hail'])
export type PrecipitationType = z.infer<typeof precipitationTypeSchema>

export const weatherProvenanceKindSchema = z.enum(['scenario', 'forecast', 'observed', 'inferred', 'intervention'])
export type WeatherProvenanceKind = z.infer<typeof weatherProvenanceKindSchema>

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
})
export type WeatherSurface = z.infer<typeof weatherSurfaceSchema>
export const weatherSurfacePatchSchema = weatherSurfaceSchema.partial()
export type WeatherSurfacePatch = z.infer<typeof weatherSurfacePatchSchema>

export const weatherExtensionValueSchema = z.union([
  z.number().finite(),
  z.string(),
  z.boolean(),
])
export type WeatherExtensionValue = z.infer<typeof weatherExtensionValueSchema>

export const weatherExtensionsSchema = z.record(weatherExtensionValueSchema).default({})
export type WeatherExtensions = z.infer<typeof weatherExtensionsSchema>

export const weatherExtensionDefinitionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('number'),
    default: z.number().finite(),
    unit: z.string().min(1).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    interpolation: z.literal('linear').default('linear'),
  }),
  z.object({
    type: z.literal('string'),
    default: z.string(),
    interpolation: z.literal('step').default('step'),
  }),
  z.object({
    type: z.literal('boolean'),
    default: z.boolean(),
    interpolation: z.literal('step').default('step'),
  }),
])
export type WeatherExtensionDefinition = z.infer<typeof weatherExtensionDefinitionSchema>

export const weatherExtensionDefinitionsSchema = z.record(weatherExtensionDefinitionSchema).default({})
export type WeatherExtensionDefinitions = z.infer<typeof weatherExtensionDefinitionsSchema>

export const weatherQualitySchema = z.object({
  provenance: weatherProvenanceKindSchema,
  confidence: normalizedSchema,
  validAt: z.string().datetime(),
})
export type WeatherQuality = z.infer<typeof weatherQualitySchema>

export const weatherRenderSchema = z.object({
  cellSizeM: z.number().finite().positive(),
  showField: z.boolean().default(true),
})
export type WeatherRender = z.infer<typeof weatherRenderSchema>

export const weatherStateSchema = z.object({
  atmosphere: weatherAtmosphereSchema,
  surface: weatherSurfaceSchema,
  extensions: weatherExtensionsSchema,
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
  state: weatherStateSchema,
  quality: weatherQualitySchema,
  influence: weatherInfluenceSchema.optional(),
  render: weatherRenderSchema.optional(),
  summary: z.string().min(1),
})
export type WeatherDomainData = z.infer<typeof weatherDomainDataSchema>

export const createWeatherAreaPayloadSchema = z.object({
  objectType: z.literal('weather_area'),
  label: z.string().min(1).max(80),
  summary: z.string().min(1).max(180).default('Operator-created weather area'),
  atmosphere: weatherAtmospherePatchSchema.optional(),
  surface: weatherSurfacePatchSchema.optional(),
  extensions: weatherExtensionsSchema.optional(),
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
  readonly state: WeatherState
  readonly quality: WeatherQuality
  readonly activeInfluenceIds: ReadonlyArray<string>
}
