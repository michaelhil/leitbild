import { z } from 'zod'
import {
  geoPointFromLonLat,
  objectIdSchema,
  type IsoTimestamp,
  type OperationalObject,
} from '../../core/model/index.ts'
import type { PackScenarioObjectSpec, PackScenarioOperationSpec, PackScenarioSupport } from '../../core/packs/protocol.ts'
import {
  evolveWeatherData,
} from './conditions.ts'
import { defaultAtmosphere, defaultSurface } from './defaults.ts'
import {
  weatherAtmosphereSchema,
  weatherDomainDataSchema,
  weatherSeveritySchema,
  weatherAtmospherePatchSchema,
  weatherSurfacePatchSchema,
  weatherSurfaceSchema,
  weatherFalloffCurveSchema,
  weatherInfluenceSchema,
  type WeatherAtmospherePatch,
  type WeatherDomainData,
  type WeatherInfluence,
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
  severity: weatherSeveritySchema.default('normal'),
  atmosphere: weatherAtmospherePatchSchema.default({}),
  surface: weatherSurfacePatchSchema.default({}),
  falloffCurve: weatherFalloffCurveSchema.default([{ x: 0, y: 1 }, { x: 1, y: 0 }]),
  keyframes: z.array(weatherKeyframeSpecSchema).min(1),
})

export const createWeatherDomainData = (config: {
  readonly at: IsoTimestamp
  readonly summary: string
  readonly severity: z.infer<typeof weatherSeveritySchema>
  readonly atmosphere?: WeatherAtmospherePatch
  readonly surface?: WeatherSurfacePatch
  readonly influence: WeatherInfluence
  readonly render?: { readonly cellSizeM: number; readonly showField: boolean }
}): WeatherDomainData => {
  const atmosphere = weatherAtmosphereSchema.parse({
    ...defaultAtmosphere(config.at),
    ...config.atmosphere,
    precipitation: {
      ...defaultAtmosphere(config.at).precipitation,
      ...config.atmosphere?.precipitation,
    },
    labels: config.atmosphere?.labels ?? defaultAtmosphere(config.at).labels,
  })
  const surface = weatherSurfaceSchema.parse({
    ...defaultSurface(),
    ...config.surface,
    labels: config.surface?.labels ?? defaultSurface().labels,
  })
  return weatherDomainDataSchema.parse(evolveWeatherData({
    type: 'weather_condition',
    schemaVersion: 1,
    conditionKind: 'weather_influence',
    severity: config.severity,
    atmosphere,
    surface,
    quality: {
      provenance: 'scenario',
      confidence: 1,
      validAt: config.at,
    },
    influence: config.influence,
    ...(config.render ? { render: config.render } : {}),
    summary: config.summary,
  }, config.at, 0))
}

const weatherStateForSpec = (config: {
  readonly at: IsoTimestamp
  readonly baseAtmosphere: WeatherAtmospherePatch
  readonly baseSurface: WeatherSurfacePatch
  readonly atmosphere: WeatherAtmospherePatch
  readonly surface: WeatherSurfacePatch
}) => ({
  atmosphere: weatherAtmosphereSchema.parse({
    ...defaultAtmosphere(config.at),
    ...config.baseAtmosphere,
    ...config.atmosphere,
    precipitation: {
      ...defaultAtmosphere(config.at).precipitation,
      ...config.baseAtmosphere.precipitation,
      ...config.atmosphere.precipitation,
    },
    labels: config.atmosphere.labels ?? config.baseAtmosphere.labels ?? defaultAtmosphere(config.at).labels,
  }),
  surface: weatherSurfaceSchema.parse({
    ...defaultSurface(),
    ...config.baseSurface,
    ...config.surface,
    labels: config.surface.labels ?? config.baseSurface.labels ?? defaultSurface().labels,
  }),
})

const influenceForSpec = (
  spec: z.infer<typeof weatherConditionSpecSchema>,
  at: IsoTimestamp,
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
      atmosphere: keyframe.atmosphere,
      surface: keyframe.surface,
    }),
    falloffCurve: keyframe.falloffCurve ?? spec.falloffCurve,
  })),
})

const weatherConditionObject = (config: {
  readonly spec: z.infer<typeof weatherConditionSpecSchema>
  readonly at: IsoTimestamp
}): OperationalObject => {
  const influence = influenceForSpec(config.spec, config.at)
  const firstFrame = influence.keyframes[0]
  if (!firstFrame) throw new Error(`weather condition ${config.spec.id} has no keyframes`)
  const data = createWeatherDomainData({
    at: config.at,
    summary: config.spec.summary,
    severity: config.spec.severity,
    ...(Object.keys(config.spec.atmosphere).length > 0 ? { atmosphere: config.spec.atmosphere } : {}),
    ...(Object.keys(config.spec.surface).length > 0 ? { surface: config.spec.surface } : {}),
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
      status: data.severity,
      priority: data.severity === 'hazard' ? 'high' : data.severity === 'adverse' ? 'normal' : 'low',
      mode: 'simulated',
    },
    alerts: data.severity === 'hazard'
      ? [{
          id: `${config.spec.id}:weather`,
          kind: 'weather_condition',
          severity: 'warning',
          message: config.spec.summary,
          raisedAt: config.at,
          acknowledged: false,
        }]
      : [],
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
    return weatherConditionObject({ spec, at: context.at })
  },
  applyOperation: (rawOperation: PackScenarioOperationSpec): OperationalObject => {
    throw new Error(`weather scenario operation is not supported yet: ${rawOperation.type}`)
  },
}
