import { z } from 'zod'
import { objectIdSchema, geoJsonPolygonSchema } from '../../core/model/index.ts'
import { weatherItemSchema, weatherSurfacePatchSchema } from './model.ts'

export const weatherCommandSchemas = {
  'world.weather.create': weatherItemSchema,
  'world.weather.update': z
    .object({ item: weatherItemSchema, expectedRevision: z.number().int().nonnegative() })
    .strict(),
  'world.weather.set-enabled': z
    .object({ objectId: objectIdSchema, enabled: z.boolean(), expectedRevision: z.number().int().nonnegative() })
    .strict(),
  'world.weather.intervene-ground': z
    .object({
      area: geoJsonPolygonSchema,
      surface: weatherSurfacePatchSchema.refine(
        (value) => Object.keys(value).length > 0,
        'Supply at least one ground quantity',
      ),
    })
    .strict(),
} as const
