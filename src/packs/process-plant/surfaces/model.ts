import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import { variablePathSchema, type VariablePath } from '../graph/index.ts'

export const processSurfaceWidgetTypeSchema = z.enum([
  'alarmStrip',
  'heatExchanger',
  'label',
  'numericReadout',
  'pump',
  'statusBanner',
  'trendMini',
  'valve',
  'vessel',
])
export type ProcessSurfaceWidgetType = z.infer<typeof processSurfaceWidgetTypeSchema>

export const processSurfaceRegionRoleSchema = z.enum([
  'alarms',
  'heat-transfer',
  'primary-system',
  'secondary-system',
  'support-system',
  'unit-status',
])
export type ProcessSurfaceRegionRole = z.infer<typeof processSurfaceRegionRoleSchema>

export const processSurfaceBindingSchema = z.object({
  label: z.string().min(1).optional(),
  path: variablePathSchema,
  digits: z.number().int().nonnegative().max(6).optional(),
  display: z.enum(['number', 'percent', 'state']).default('number'),
}).strict()
export type ProcessSurfaceBinding = z.infer<typeof processSurfaceBindingSchema>

export const processSurfaceRegionSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  role: processSurfaceRegionRoleSchema,
  order: z.number().int().nonnegative().default(0),
}).strict()
export type ProcessSurfaceRegion = z.infer<typeof processSurfaceRegionSchema>

export const processSurfaceWidgetSchema = z.object({
  id: idSchema,
  type: processSurfaceWidgetTypeSchema,
  label: z.string().min(1),
  region: idSchema,
  role: z.string().min(1).optional(),
  rank: z.number().int().nonnegative().default(0),
  stack: z.number().int().nonnegative().default(0),
  binds: z.record(processSurfaceBindingSchema).default({}),
  ports: z.record(z.enum(['left', 'right', 'top', 'bottom'])).default({}),
  style: z.object({
    tone: z.enum(['primary', 'secondary', 'support', 'warning', 'critical']).optional(),
  }).strict().default({}),
}).strict()
export type ProcessSurfaceWidget = z.infer<typeof processSurfaceWidgetSchema>

export const processSurfacePathSchema = z.object({
  id: idSchema,
  label: z.string().min(1).optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  binds: z.record(processSurfaceBindingSchema).default({}),
  style: z.object({
    service: z.enum(['primary', 'steam', 'feedwater', 'condensate', 'electrical', 'cooling', 'support']).optional(),
  }).strict().default({}),
}).strict()
export type ProcessSurfacePath = z.infer<typeof processSurfacePathSchema>

export const processSurfaceDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  designSize: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict(),
  regions: z.array(processSurfaceRegionSchema).min(1),
  widgets: z.array(processSurfaceWidgetSchema).min(1),
  paths: z.array(processSurfacePathSchema).default([]),
}).strict().superRefine((surface, ctx) => {
  const regionIds = new Set<string>()
  for (const [index, region] of surface.regions.entries()) {
    if (regionIds.has(region.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['regions', index, 'id'], message: `duplicate process surface region id: ${region.id}` })
    }
    regionIds.add(region.id)
  }
  const widgetIds = new Set<string>()
  for (const [index, widget] of surface.widgets.entries()) {
    if (widgetIds.has(widget.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['widgets', index, 'id'], message: `duplicate process surface widget id: ${widget.id}` })
    }
    widgetIds.add(widget.id)
    if (!regionIds.has(widget.region)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['widgets', index, 'region'], message: `unknown process surface region: ${widget.region}` })
    }
  }
  const portRefs = new Set<string>()
  for (const widget of surface.widgets) {
    for (const port of Object.keys(widget.ports)) portRefs.add(`${widget.id}.${port}`)
  }
  const pathIds = new Set<string>()
  for (const [index, path] of surface.paths.entries()) {
    if (pathIds.has(path.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paths', index, 'id'], message: `duplicate process surface path id: ${path.id}` })
    }
    pathIds.add(path.id)
    if (!portRefs.has(path.from)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paths', index, 'from'], message: `unknown process surface source port: ${path.from}` })
    }
    if (!portRefs.has(path.to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paths', index, 'to'], message: `unknown process surface target port: ${path.to}` })
    }
  }
})
export type ProcessSurfaceDefinition = z.infer<typeof processSurfaceDefinitionSchema>

export interface ProcessSurfaceValue {
  readonly path: VariablePath
  readonly label: string
  readonly unit: string
  readonly value: unknown
  readonly formatted: string
}

export interface CompiledProcessSurfaceWidget {
  readonly id: string
  readonly type: ProcessSurfaceWidgetType
  readonly label: string
  readonly role?: string
  readonly geometry: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly binds: Readonly<Record<string, ProcessSurfaceBinding>>
  readonly ports: Readonly<Record<string, { readonly x: number; readonly y: number }>>
  readonly style: ProcessSurfaceWidget['style']
}

export interface CompiledProcessSurfacePath {
  readonly id: string
  readonly label?: string
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>
  readonly binds: Readonly<Record<string, ProcessSurfaceBinding>>
  readonly style: ProcessSurfacePath['style']
}

export interface CompiledProcessSurface {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly designSize: ProcessSurfaceDefinition['designSize']
  readonly widgets: ReadonlyArray<CompiledProcessSurfaceWidget>
  readonly paths: ReadonlyArray<CompiledProcessSurfacePath>
  readonly bindingPaths: ReadonlyArray<VariablePath>
}
