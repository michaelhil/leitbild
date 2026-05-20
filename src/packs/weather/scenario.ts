import { z } from 'zod'
import {
  geoPointFromLonLat,
  objectIdSchema,
  type IsoTimestamp,
  type OperationalObject,
} from '../../core/model/index.ts'
import type { PackScenarioObjectSpec, PackScenarioOperationSpec, PackScenarioSupport } from '../../core/packs/protocol.ts'
import { defaultAtmosphere, defaultSurface } from './defaults.ts'
import {
  weatherAtmosphereSchema,
  weatherDomainDataSchema,
  weatherAtmospherePatchSchema,
  weatherExtensionDefinitionsSchema,
  weatherExtensionsSchema,
  weatherSurfacePatchSchema,
  weatherSurfaceSchema,
  weatherFalloffCurveSchema,
  weatherInfluenceSchema,
  type WeatherAtmospherePatch,
  type WeatherDomainData,
  type WeatherExtensionDefinitions,
  type WeatherExtensions,
  type WeatherInfluence,
  type WeatherState,
  type WeatherSurfacePatch,
} from './model.ts'
import { weatherSimAdapterId, weatherSimDomain } from './sim/constants.ts'

const lonLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
])

const weatherKeyframeSpecSchema = z.object({
  atSeconds: z.number().finite().nonnegative(),
  center: lonLatSchema,
  semiMajorAxisM: z.number().finite().positive(),
  semiMinorAxisM: z.number().finite().positive(),
  rotationDeg: z.number().finite(),
  falloffCurve: weatherFalloffCurveSchema.optional(),
  atmosphere: weatherAtmospherePatchSchema.default({}),
  surface: weatherSurfacePatchSchema.default({}),
  extensions: weatherExtensionsSchema,
})

const weatherConditionSpecSchema = z.object({
  pack: z.literal('weather'),
  type: z.literal('weather_condition'),
  id: objectIdSchema,
  label: z.string().min(1),
  cellSizeM: z.number().finite().positive().default(750),
  showField: z.boolean().default(true),
  priority: z.number().int().default(0),
  summary: z.string().min(1),
  atmosphere: weatherAtmospherePatchSchema.default({}),
  surface: weatherSurfacePatchSchema.default({}),
  extensions: weatherExtensionsSchema,
  falloffCurve: weatherFalloffCurveSchema.default([{ x: 0, y: 1 }, { x: 1, y: 0 }]),
  keyframes: z.array(weatherKeyframeSpecSchema).min(1),
})

const weatherProviderConfigSchema = z.object({
  fields: z.object({
    extensions: weatherExtensionDefinitionsSchema,
  }).default({ extensions: {} }),
}).default({ fields: { extensions: {} } })

const weatherProviderConfigFor = (providerConfigs: Record<string, unknown>): z.infer<typeof weatherProviderConfigSchema> =>
  weatherProviderConfigSchema.parse(providerConfigs.weather ?? {})

const extensionDefaultsFor = (definitions: WeatherExtensionDefinitions): WeatherExtensions =>
  Object.fromEntries(Object.entries(definitions).map(([key, definition]) => [key, definition.default]))

const validatedExtensions = (
  extensions: WeatherExtensions,
  definitions: WeatherExtensionDefinitions,
): WeatherExtensions => {
  for (const [key, value] of Object.entries(extensions)) {
    const definition = definitions[key]
    if (!definition) throw new Error(`weather extension "${key}" is not declared in providerConfigs.weather.fields.extensions`)
    if (typeof value !== definition.type) throw new Error(`weather extension "${key}" must be ${definition.type}`)
    if (definition.type === 'number') {
      const numericValue = value
      if (typeof numericValue !== 'number') throw new Error(`weather extension "${key}" must be number`)
      if (definition.min !== undefined && numericValue < definition.min) throw new Error(`weather extension "${key}" is below min ${definition.min}`)
      if (definition.max !== undefined && numericValue > definition.max) throw new Error(`weather extension "${key}" is above max ${definition.max}`)
    }
  }
  return extensions
}

export const createWeatherDomainData = (config: {
  readonly at: IsoTimestamp
  readonly summary: string
  readonly state: WeatherState
  readonly influence: WeatherInfluence
  readonly render?: { readonly cellSizeM: number; readonly showField: boolean }
}): WeatherDomainData => {
  return weatherDomainDataSchema.parse({
    type: 'weather_condition',
    schemaVersion: 1,
    conditionKind: 'weather_influence',
    state: config.state,
    quality: {
      provenance: 'scenario',
      confidence: 1,
      validAt: config.at,
    },
    influence: config.influence,
    ...(config.render ? { render: config.render } : {}),
    summary: config.summary,
  })
}

const weatherStateForSpec = (config: {
  readonly at: IsoTimestamp
  readonly baseAtmosphere: WeatherAtmospherePatch
  readonly baseSurface: WeatherSurfacePatch
  readonly baseExtensions: WeatherExtensions
  readonly atmosphere: WeatherAtmospherePatch
  readonly surface: WeatherSurfacePatch
  readonly extensions: WeatherExtensions
  readonly extensionDefinitions: WeatherExtensionDefinitions
}): WeatherState => ({
  atmosphere: weatherAtmosphereSchema.parse({
    ...defaultAtmosphere(config.at),
    ...config.baseAtmosphere,
    ...config.atmosphere,
    precipitation: {
      ...defaultAtmosphere(config.at).precipitation,
      ...config.baseAtmosphere.precipitation,
      ...config.atmosphere.precipitation,
    },
  }),
  surface: weatherSurfaceSchema.parse({
    ...defaultSurface(),
    ...config.baseSurface,
    ...config.surface,
  }),
  extensions: validatedExtensions({
    ...extensionDefaultsFor(config.extensionDefinitions),
    ...config.baseExtensions,
    ...config.extensions,
  }, config.extensionDefinitions),
})

const influenceForSpec = (
  spec: z.infer<typeof weatherConditionSpecSchema>,
  at: IsoTimestamp,
  extensionDefinitions: WeatherExtensionDefinitions,
): WeatherInfluence => weatherInfluenceSchema.parse({
  priority: spec.priority,
  keyframes: spec.keyframes.map(keyframe => ({
    atSeconds: keyframe.atSeconds,
    center: geoPointFromLonLat(keyframe.center[0], keyframe.center[1]),
    semiMajorAxisM: keyframe.semiMajorAxisM,
    semiMinorAxisM: keyframe.semiMinorAxisM,
    rotationDeg: keyframe.rotationDeg,
    state: weatherStateForSpec({
      at,
      baseAtmosphere: spec.atmosphere,
      baseSurface: spec.surface,
      baseExtensions: spec.extensions,
      atmosphere: keyframe.atmosphere,
      surface: keyframe.surface,
      extensions: keyframe.extensions,
      extensionDefinitions,
    }),
    falloffCurve: keyframe.falloffCurve ?? spec.falloffCurve,
  })),
})

const weatherConditionObject = (config: {
  readonly spec: z.infer<typeof weatherConditionSpecSchema>
  readonly at: IsoTimestamp
  readonly extensionDefinitions: WeatherExtensionDefinitions
}): OperationalObject => {
  const influence = influenceForSpec(config.spec, config.at, config.extensionDefinitions)
  const firstFrame = influence.keyframes[0]
  if (!firstFrame) throw new Error(`weather condition ${config.spec.id} has no keyframes`)
  const data = createWeatherDomainData({
    at: config.at,
    summary: config.spec.summary,
    state: firstFrame.state,
    influence,
    render: { cellSizeM: config.spec.cellSizeM, showField: config.spec.showField },
  })
  return {
    id: config.spec.id,
    kind: 'zone',
    domain: weatherSimDomain,
    label: config.spec.label,
    lifecycle: 'active',
    revision: 0,
    spatial: {
      position: {
        point: firstFrame.center,
        observedAt: config.at,
        staleAfterMs: 600000,
      },
      frame: { kind: 'wgs84' },
    },
    operational: {
      status: 'active',
      priority: 'low',
      mode: 'simulated',
    },
    alerts: [],
    provenance: {
      source: 'simulator',
      adapterId: weatherSimAdapterId,
      externalId: config.spec.id,
    },
    timestamps: {
      createdAt: config.at,
      updatedAt: config.at,
    },
    domainData: data,
  }
}

export const weatherScenarioSupport: PackScenarioSupport = {
  expandObject: (rawSpec, context): OperationalObject => {
    const spec = weatherConditionSpecSchema.parse(rawSpec)
    const providerConfig = weatherProviderConfigFor(context.providerConfigs)
    return weatherConditionObject({
      spec,
      at: context.at,
      extensionDefinitions: providerConfig.fields.extensions,
    })
  },
  applyOperation: (rawOperation: PackScenarioOperationSpec): OperationalObject => {
    throw new Error(`weather scenario operation is not supported yet: ${rawOperation.type}`)
  },
}
