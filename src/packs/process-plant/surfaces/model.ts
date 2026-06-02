import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import {
  componentIdSchema,
  connectionIdSchema,
  connectionServiceSchema,
  variablePathSchema,
  type ComponentId,
  type ConnectionId,
  type ConnectionService,
  type VariablePath,
} from '../graph/index.ts'

export const processSurfaceWidgetTypeSchema = z.enum([
  'alarmPanel',
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

export type ProcessSurfaceAlarmSeverity = 'info' | 'notice' | 'warning' | 'critical'

export interface ProcessSurfaceAlarmAnnunciator {
  readonly system?: string
  readonly equipmentId?: string
  readonly group?: string
  readonly firstOutGroup?: string
  readonly priority?: 'low' | 'medium' | 'high' | 'urgent'
  readonly role?: 'symptom' | 'cause' | 'automaticAction' | 'status'
}

export interface ProcessSurfaceAlarmLifecycle {
  readonly id: string
  readonly kind: 'alarm' | 'trip'
  readonly title: string
  readonly message: string
  readonly severity: ProcessSurfaceAlarmSeverity
  readonly phase: string
  readonly active: boolean
  readonly acknowledged: boolean
  readonly firstOut: boolean
  readonly resettable: boolean
  readonly annunciator?: ProcessSurfaceAlarmAnnunciator
  readonly firstOutRank?: number
  readonly firstActiveElapsedMs?: number
  readonly lastActiveElapsedMs?: number
  readonly lastClearedElapsedMs?: number
}

export interface ProcessSurfaceAlarmSnapshot {
  readonly configured: boolean
  readonly activeAlarmCount: number
  readonly activeTripCount: number
  readonly unacknowledgedCount: number
  readonly firstOutCount: number
  readonly activeHighestSeverity: ProcessSurfaceAlarmSeverity | null
  readonly activeFirstOut: ReadonlyArray<ProcessSurfaceAlarmLifecycle>
  readonly active: ReadonlyArray<ProcessSurfaceAlarmLifecycle>
}

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

export const processSurfaceWidgetSourceSchema = z.object({
  componentIds: z.array(componentIdSchema).min(1),
}).strict()
export type ProcessSurfaceWidgetSource = z.infer<typeof processSurfaceWidgetSourceSchema>

export const processSurfacePathSourceSchema = z.object({
  connectionId: connectionIdSchema,
}).strict()
export type ProcessSurfacePathSource = z.infer<typeof processSurfacePathSourceSchema>

const processSurfacePointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict()

export const processSurfacePortSchema = z.union([
  z.enum(['left', 'right', 'top', 'bottom']),
  processSurfacePointSchema,
])
export type ProcessSurfacePort = z.infer<typeof processSurfacePortSchema>

export const processSurfaceGeometrySchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive(),
}).strict()
export type ProcessSurfaceGeometry = z.infer<typeof processSurfaceGeometrySchema>

export const processSurfaceWidgetSchema = z.object({
  id: idSchema,
  type: processSurfaceWidgetTypeSchema,
  label: z.string().min(1),
  region: idSchema,
  source: processSurfaceWidgetSourceSchema.optional(),
  role: z.string().min(1).optional(),
  rank: z.number().int().nonnegative().default(0),
  stack: z.number().int().nonnegative().default(0),
  geometry: processSurfaceGeometrySchema.optional(),
  binds: z.record(z.string(), processSurfaceBindingSchema).default({}),
  ports: z.record(z.string(), processSurfacePortSchema).default({}),
  style: z.object({
    tone: z.enum(['primary', 'secondary', 'support', 'warning', 'critical']).optional(),
  }).strict().default({}),
}).strict()
export type ProcessSurfaceWidget = z.infer<typeof processSurfaceWidgetSchema>

export const processSurfacePathSchema = z.object({
  id: idSchema,
  label: z.string().min(1).optional(),
  source: processSurfacePathSourceSchema.optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  waypoints: z.array(processSurfacePointSchema).default([]),
  binds: z.record(z.string(), processSurfaceBindingSchema).default({}),
  style: z.object({
    service: z.enum(['primary', 'steam', 'feedwater', 'condensate', 'electrical', 'cooling', 'support']).optional(),
  }).strict().default({}),
}).strict()
export type ProcessSurfacePath = z.infer<typeof processSurfacePathSchema>

export const processSurfaceGraphLensSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('selected-only'),
    selectedComponentIds: z.array(componentIdSchema).default([]),
    selectedConnectionIds: z.array(connectionIdSchema).default([]),
  }).strict(),
  z.object({
    mode: z.literal('direct-neighborhood'),
    selectedComponentIds: z.array(componentIdSchema).min(1),
    selectedConnectionIds: z.array(connectionIdSchema).default([]),
  }).strict(),
  z.object({
    mode: z.literal('path-to-visible'),
    selectedComponentIds: z.array(componentIdSchema).min(1),
    selectedConnectionIds: z.array(connectionIdSchema).default([]),
    visibleComponentIds: z.array(componentIdSchema).min(1),
  }).strict(),
  z.object({
    mode: z.literal('service-layer'),
    service: connectionServiceSchema,
    selectedConnectionIds: z.array(connectionIdSchema).default([]),
  }).strict(),
])
export type ProcessSurfaceGraphLens = z.infer<typeof processSurfaceGraphLensSchema>

export const processSurfaceLensSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  lens: processSurfaceGraphLensSchema.optional(),
}).strict()
export type ProcessSurfaceLens = z.infer<typeof processSurfaceLensSchema>

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
  lenses: z.array(processSurfaceLensSchema).default([]),
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
  const lensIds = new Set<string>()
  for (const [index, lens] of surface.lenses.entries()) {
    if (lensIds.has(lens.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lenses', index, 'id'], message: `duplicate process surface lens id: ${lens.id}` })
    }
    lensIds.add(lens.id)
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
  readonly source?: { readonly componentIds: ReadonlyArray<ComponentId> }
  readonly role?: string
  readonly geometry: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly binds: Readonly<Record<string, ProcessSurfaceBinding>>
  readonly ports: Readonly<Record<string, { readonly x: number; readonly y: number }>>
  readonly style: ProcessSurfaceWidget['style']
}

export interface CompiledProcessSurfacePath {
  readonly id: string
  readonly label?: string
  readonly source?: { readonly connectionId: ConnectionId }
  readonly from: { readonly widgetId: string; readonly portName: string }
  readonly to: { readonly widgetId: string; readonly portName: string }
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>
  readonly binds: Readonly<Record<string, ProcessSurfaceBinding>>
  readonly style: ProcessSurfacePath['style']
}

export interface CompiledProcessSurface {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly designSize: ProcessSurfaceDefinition['designSize']
  readonly lenses: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly description?: string
    readonly lens?: ProcessSurfaceGraphLens
  }>
  readonly widgets: ReadonlyArray<CompiledProcessSurfaceWidget>
  readonly paths: ReadonlyArray<CompiledProcessSurfacePath>
  readonly bindingPaths: ReadonlyArray<VariablePath>
}

export type { ConnectionService }
