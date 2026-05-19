import { z } from 'zod'
import {
  geoPointFromLonLat,
  objectIdSchema,
  type GeoJsonPolygon,
  type IsoTimestamp,
  type OperationalObject,
} from '../../core/model/index.ts'
import type { PackScenarioObjectSpec, PackScenarioOperationSpec, PackScenarioSupport } from '../../core/packs/protocol.ts'
import {
  defaultAtmosphere,
  defaultSurface,
  evolveWeatherData,
} from './conditions.ts'
import {
  weatherAtmosphereSchema,
  weatherDomainDataSchema,
  weatherEvolutionSchema,
  weatherSeveritySchema,
  weatherAtmospherePatchSchema,
  weatherSurfacePatchSchema,
  weatherSurfaceSchema,
  type WeatherAtmospherePatch,
  type WeatherDomainData,
  type WeatherSurfacePatch,
} from './model.ts'
import { weatherSimAdapterId, weatherSimDomain } from './sim/constants.ts'

const lonLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
])

const weatherConditionSpecSchema = z.object({
  pack: z.literal('weather'),
  type: z.literal('weather_condition'),
  id: objectIdSchema,
  label: z.string().min(1),
  polygon: z.array(lonLatSchema).min(4),
  summary: z.string().min(1),
  severity: weatherSeveritySchema.default('normal'),
  atmosphere: weatherAtmospherePatchSchema.default({}),
  surface: weatherSurfacePatchSchema.default({}),
  evolution: weatherEvolutionSchema.optional(),
})

const polygonFromPath = (path: ReadonlyArray<readonly [number, number]>): GeoJsonPolygon => ({
  type: 'Polygon',
  coordinates: [path.map(([lon, lat]) => geoPointFromLonLat(lon, lat).coordinates)],
})

export const createWeatherDomainData = (config: {
  readonly at: IsoTimestamp
  readonly summary: string
  readonly severity: z.infer<typeof weatherSeveritySchema>
  readonly atmosphere?: WeatherAtmospherePatch
  readonly surface?: WeatherSurfacePatch
  readonly evolution?: z.infer<typeof weatherEvolutionSchema>
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
    conditionKind: 'weather_zone',
    severity: config.severity,
    atmosphere,
    surface,
    quality: {
      provenance: 'scenario',
      confidence: 1,
      validAt: config.at,
    },
    ...(config.evolution ? { evolution: config.evolution } : {}),
    summary: config.summary,
  }, config.at, 0))
}

const weatherConditionObject = (config: {
  readonly spec: z.infer<typeof weatherConditionSpecSchema>
  readonly geometry: GeoJsonPolygon
  readonly at: IsoTimestamp
}): OperationalObject => {
  const data = createWeatherDomainData({
    at: config.at,
    summary: config.spec.summary,
    severity: config.spec.severity,
    ...(Object.keys(config.spec.atmosphere).length > 0 ? { atmosphere: config.spec.atmosphere } : {}),
    ...(Object.keys(config.spec.surface).length > 0 ? { surface: config.spec.surface } : {}),
    ...(config.spec.evolution ? { evolution: config.spec.evolution } : {}),
  })
  return {
    id: config.spec.id,
    kind: 'zone',
    domain: weatherSimDomain,
    label: config.spec.label,
    lifecycle: 'active',
    revision: 0,
    spatial: {
      geometry: config.geometry,
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
    return weatherConditionObject({ spec, geometry: polygonFromPath(spec.polygon), at: context.at })
  },
  applyOperation: (rawOperation: PackScenarioOperationSpec): OperationalObject => {
    throw new Error(`weather scenario operation is not supported yet: ${rawOperation.type}`)
  },
}
