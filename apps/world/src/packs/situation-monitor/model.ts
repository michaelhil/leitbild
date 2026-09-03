import { z } from 'zod'

export const situationPackId = 'situation-monitor'
export const situationRuntimeId = 'situation-monitor-local'
export const sourceIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
export const coordinateSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
export const boundsSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
export const watchedAreaSchema = z.object({ id: sourceIdSchema, name: z.string().min(1).max(120), bounds: boundsSchema }).strict()
export const sourceUrlSchema = z.url().max(2048).superRefine((value, ctx) => {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) ctx.addIssue({ code: 'custom', message: 'Use a public HTTPS URL without embedded credentials or a custom port' })
  if ([...url.searchParams.keys()].some(key => /(?:token|secret|password|api[-_]?key|signature|credential)/i.test(key))) ctx.addIssue({ code: 'custom', message: 'Credentials must use a server-side credential reference, not a URL' })
})
const mappingSchema = z.object({
  id: z.string().startsWith('/').max(256).default('/id'), title: z.string().startsWith('/').max(256).default('/properties/title'),
  time: z.string().startsWith('/').max(256).default('/properties/time'), url: z.string().startsWith('/').max(256).default('/properties/url'),
}).strict()
export const sourceMapStyleSchema = z.object({
  visible: z.boolean().default(true), icon: z.string().regex(/^[a-z][a-z0-9-]*$/).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), opacity: z.number().min(0).max(1).default(.18),
  lineWidth: z.number().min(0).max(12).default(2),
}).strict()
const common = {
  id: sourceIdSchema, name: z.string().trim().min(1).max(120), enabled: z.boolean().default(true),
  intervalSeconds: z.number().int().min(60).max(86400).default(300),
  retentionHours: z.number().int().min(1).max(168).default(24),
  credentialRef: sourceIdSchema.optional(),
  attribution: z.string().max(300).default(''),
  map: sourceMapStyleSchema.default({ visible: true, opacity: .18, lineWidth: 2 }),
}
export const situationSourceSchema = z.discriminatedUnion('adapter', [
  z.object({ ...common, adapter: z.literal('rss'), url: sourceUrlSchema }).strict(),
  z.object({ ...common, adapter: z.literal('geojson'), url: sourceUrlSchema, mapping: mappingSchema.default({ id: '/id', title: '/properties/title', time: '/properties/time', url: '/properties/url' }) }).strict(),
  z.object({ ...common, adapter: z.literal('usgs'), url: sourceUrlSchema }).strict(),
  z.object({ ...common, adapter: z.literal('met-forecast'), point: coordinateSchema }).strict(),
  z.object({ ...common, adapter: z.literal('met-alerts'), url: sourceUrlSchema.default('https://api.met.no/weatherapi/metalerts/2.0/current.json?lang=no') }).strict(),
  z.object({ ...common, adapter: z.literal('vegvesen'), url: sourceUrlSchema.default('https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/ows'), dataset: z.enum(['cameras', 'road-weather', 'traffic']), bounds: boundsSchema.optional() }).strict(),
  z.object({ ...common, adapter: z.literal('media'), url: sourceUrlSchema, format: z.enum(['image', 'youtube', 'video', 'audio', 'hls']), point: coordinateSchema.optional() }).strict(),
])
export type SituationSource = z.infer<typeof situationSourceSchema>
export const situationConfigSchema = z.object({
  areas: z.array(watchedAreaSchema).max(20).default([]),
  sources: z.array(situationSourceSchema).max(40).default([]),
}).strict().superRefine((config, ctx) => {
  for (const key of ['sources', 'areas'] as const) if (new Set(config[key].map(item => item.id)).size !== config[key].length) ctx.addIssue({ code: 'custom', path: [key], message: 'IDs must be unique' })
  config.areas.forEach((area, index) => { if (area.bounds[1] >= area.bounds[3]) ctx.addIssue({ code: 'custom', path: ['areas', index, 'bounds'], message: 'South must be below north; west > east is permitted for dateline-crossing areas' }) })
})
export type SituationConfig = z.infer<typeof situationConfigSchema>

const ring = z.array(coordinateSchema).min(4).max(10000).refine(points => points[0]![0] === points.at(-1)![0] && points[0]![1] === points.at(-1)![1], 'Polygon rings must be closed')
export const externalGeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: coordinateSchema }).strict(),
  z.object({ type: z.literal('LineString'), coordinates: z.array(coordinateSchema).min(2).max(10000) }).strict(),
  z.object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1).max(100) }).strict(),
  z.object({ type: z.literal('MultiPoint'), coordinates: z.array(coordinateSchema).min(1).max(10000) }).strict(),
  z.object({ type: z.literal('MultiLineString'), coordinates: z.array(z.array(coordinateSchema).min(2).max(10000)).max(100) }).strict(),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring).min(1).max(100)).max(100) }).strict(),
]).superRefine((geometry, ctx) => {
  let count = 0
  const visit = (value: unknown): void => { if (!Array.isArray(value)) return; if (typeof value[0] === 'number') count++; else value.forEach(visit) }
  visit(geometry.coordinates)
  if (count > 10000) ctx.addIssue({ code: 'custom', message: 'Geometry exceeds 10,000 vertices' })
})
export type ExternalGeometry = z.infer<typeof externalGeometrySchema>
const time = z.iso.datetime({ offset: true })
export const evidenceUrlSchema = z.url().max(2048).refine(value => ['https:', 'http:'].includes(new URL(value).protocol), 'Evidence links must use HTTP or HTTPS')
export const externalRecordSchema = z.object({
  id: z.string().min(1).max(256), sourceId: sourceIdSchema, kind: z.enum(['report', 'event', 'forecast', 'observation', 'feature', 'media']),
  title: z.string().max(500), summary: z.string().max(3000).default(''), url: evidenceUrlSchema,
  attribution: z.string().max(300), retrievedAt: time, publishedAt: time.optional(), updatedAt: time.optional(), validAt: time.optional(),
  observedAt: time.optional(), validFrom: time.optional(), validUntil: time.optional(),
  subject: z.object({ id: z.string().min(1).max(256), label: z.string().max(500) }).strict().optional(),
  category: z.string().max(100).optional(), severity: z.enum(['info', 'minor', 'moderate', 'severe', 'extreme']).optional(),
  details: z.record(z.string().max(100), z.string().max(6000)).refine(value => Object.keys(value).length <= 16, 'At most 16 detail fields').default({}),
  geometry: externalGeometrySchema.optional(),
  measurements: z.array(z.object({ id: z.string().max(100), value: z.number().finite(), unit: z.string().max(60) }).strict()).max(24).default([]),
  media: z.array(z.object({ format: z.enum(['image', 'youtube', 'video', 'audio', 'hls']), url: sourceUrlSchema, available: z.boolean().optional(), label: z.string().max(200).optional() }).strict()).max(8).default([]),
}).strict()
export type ExternalRecord = z.infer<typeof externalRecordSchema>
export const sourceStatusSchema = z.object({
  sourceId: sourceIdSchema, state: z.enum(['idle', 'loading', 'ready', 'paused', 'stale', 'error']),
  lastAttemptAt: time.nullable(), lastSuccessAt: time.nullable(), nextAttemptAt: time.nullable(),
  recordCount: z.number().int().nonnegative(), error: z.string().nullable(),
}).strict()
export type SourceStatus = z.infer<typeof sourceStatusSchema>
export const situationStateSchema = z.object({ revision: z.number().int().nonnegative(), config: situationConfigSchema, lastCommandId: z.string().optional() }).strict()
export const recordSearchSchema = z.object({
  sourceId: sourceIdSchema.optional(), subjectId: z.string().max(256).optional(), text: z.string().max(200).default(''), bounds: boundsSchema.optional(),
  from: time.optional(), to: time.optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).max(100000).default(0),
}).strict()

/** Split a crossing interval before comparing; a missing location is not [0,0]. */
export const longitudeIntervals = (west: number, east: number): [number, number][] => west <= east ? [[west, east]] : [[west, 180], [-180, east]]
export const geometryBounds = (geometry: ExternalGeometry): z.infer<typeof boundsSchema> => {
  let west = 180, east = -180, south = 90, north = -90
  const visit = (value: unknown): void => { if (!Array.isArray(value)) return; if (typeof value[0] === 'number') { west = Math.min(west, value[0]); east = Math.max(east, value[0]); south = Math.min(south, value[1]); north = Math.max(north, value[1]) } else value.forEach(visit) }
  visit(geometry.coordinates)
  return [west, south, east, north]
}
export const intersectsBounds = (a: z.infer<typeof boundsSchema>, b: z.infer<typeof boundsSchema>): boolean => a[1] <= b[3] && a[3] >= b[1] && longitudeIntervals(a[0], a[2]).some(x => longitudeIntervals(b[0], b[2]).some(y => x[0] <= y[1] && x[1] >= y[0]))
