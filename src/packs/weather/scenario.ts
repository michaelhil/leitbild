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
  polygon: z.array(lonLatSchema).min(4).optional(),
  center: lonLatSchema.optional(),
  radiusM: z.number().finite().positive().optional(),
  cellSizeM: z.number().finite().positive().default(1200),
  summary: z.string().min(1),
  severity: weatherSeveritySchema.default('normal'),
  atmosphere: weatherAtmospherePatchSchema.default({}),
  surface: weatherSurfacePatchSchema.default({}),
  evolution: weatherEvolutionSchema.optional(),
}).superRefine((spec, ctx) => {
  const hasPolygon = spec.polygon !== undefined
  const hasRadial = spec.center !== undefined || spec.radiusM !== undefined
  if (hasPolygon === hasRadial) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'weather condition requires either polygon or center/radiusM',
      path: ['polygon'],
    })
  }
  if (hasRadial && (spec.center === undefined || spec.radiusM === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'radial weather condition requires both center and radiusM',
      path: ['center'],
    })
  }
})

const polygonFromPath = (path: ReadonlyArray<readonly [number, number]>): GeoJsonPolygon => ({
  type: 'Polygon',
  coordinates: [path.map(([lon, lat]) => geoPointFromLonLat(lon, lat).coordinates)],
})

const radialPolygon = (
  center: readonly [number, number],
  radiusM: number,
): GeoJsonPolygon => {
  const pointCount = 48
  const [centerLon, centerLat] = center
  const metersPerDegreeLatitude = 111_320
  const metersPerDegreeLongitude = Math.max(1, metersPerDegreeLatitude * Math.cos(centerLat * Math.PI / 180))
  const coordinates = Array.from({ length: pointCount }, (_, index) => {
    const angle = (2 * Math.PI * index) / pointCount
    return geoPointFromLonLat(
      centerLon + (radiusM * Math.cos(angle)) / metersPerDegreeLongitude,
      centerLat + (radiusM * Math.sin(angle)) / metersPerDegreeLatitude,
    ).coordinates
  })
  const first = coordinates[0]
  if (!first) throw new Error('weather radial polygon generation produced no coordinates')
  return {
    type: 'Polygon',
    coordinates: [[...coordinates, first]],
  }
}

const geometryForSpec = (spec: z.infer<typeof weatherConditionSpecSchema>): GeoJsonPolygon => {
  if (spec.polygon) return polygonFromPath(spec.polygon)
  if (!spec.center || spec.radiusM === undefined) throw new Error(`weather condition ${spec.id} is missing radial geometry`)
  return radialPolygon(spec.center, spec.radiusM)
}

export const createWeatherDomainData = (config: {
  readonly at: IsoTimestamp
  readonly summary: string
  readonly severity: z.infer<typeof weatherSeveritySchema>
  readonly atmosphere?: WeatherAtmospherePatch
  readonly surface?: WeatherSurfacePatch
  readonly evolution?: z.infer<typeof weatherEvolutionSchema>
  readonly render?: { readonly cellSizeM: number }
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
    ...(config.render ? { render: config.render } : {}),
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
    render: { cellSizeM: config.spec.cellSizeM },
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
    return weatherConditionObject({ spec, geometry: geometryForSpec(spec), at: context.at })
  },
  applyOperation: (rawOperation: PackScenarioOperationSpec): OperationalObject => {
    throw new Error(`weather scenario operation is not supported yet: ${rawOperation.type}`)
  },
}
