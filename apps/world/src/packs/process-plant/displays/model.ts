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

export const processDisplayWidgetTypeSchema = z.enum([
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
export type ProcessDisplayWidgetType = z.infer<typeof processDisplayWidgetTypeSchema>

export type ProcessDisplayAlarmSeverity = 'info' | 'notice' | 'warning' | 'critical'

export interface ProcessDisplayAlarmAnnunciator {
  readonly system?: string
  readonly equipmentId?: string
  readonly group?: string
  readonly firstOutGroup?: string
  readonly priority?: 'low' | 'medium' | 'high' | 'urgent'
  readonly role?: 'symptom' | 'cause' | 'automaticAction' | 'status'
}

export interface ProcessDisplayAlarmLifecycle {
  readonly id: string
  readonly kind: 'alarm' | 'trip'
  readonly title: string
  readonly message: string
  readonly severity: ProcessDisplayAlarmSeverity
  readonly phase: string
  readonly active: boolean
  readonly acknowledged: boolean
  readonly firstOut: boolean
  readonly resettable: boolean
  readonly annunciator?: ProcessDisplayAlarmAnnunciator
  readonly firstOutRank?: number
  readonly firstActiveElapsedMs?: number
  readonly lastActiveElapsedMs?: number
  readonly lastClearedElapsedMs?: number
}

export interface ProcessDisplayAlarmSnapshot {
  readonly configured: boolean
  readonly activeAlarmCount: number
  readonly activeTripCount: number
  readonly unacknowledgedCount: number
  readonly firstOutCount: number
  readonly activeHighestSeverity: ProcessDisplayAlarmSeverity | null
  readonly activeFirstOut: ReadonlyArray<ProcessDisplayAlarmLifecycle>
  readonly active: ReadonlyArray<ProcessDisplayAlarmLifecycle>
}

export const processDisplayRegionRoleSchema = z.enum([
  'alarms',
  'heat-transfer',
  'primary-system',
  'secondary-system',
  'support-system',
  'unit-status',
])
export type ProcessDisplayRegionRole = z.infer<typeof processDisplayRegionRoleSchema>

export const processDisplayBindingSchema = z.object({
  label: z.string().min(1).optional(),
  path: variablePathSchema,
  digits: z.number().int().nonnegative().max(6).optional(),
  display: z.enum(['number', 'percent', 'state']).default('number'),
}).strict()
export type ProcessDisplayBinding = z.infer<typeof processDisplayBindingSchema>

export const processDisplayRegionSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  role: processDisplayRegionRoleSchema,
  order: z.number().int().nonnegative().default(0),
}).strict()
export type ProcessDisplayRegion = z.infer<typeof processDisplayRegionSchema>

export const processDisplayWidgetSourceSchema = z.object({
  componentIds: z.array(componentIdSchema).min(1),
}).strict()
export type ProcessDisplayWidgetSource = z.infer<typeof processDisplayWidgetSourceSchema>

export const processDisplayPathSourceSchema = z.object({
  connectionId: connectionIdSchema,
}).strict()
export type ProcessDisplayPathSource = z.infer<typeof processDisplayPathSourceSchema>

const processDisplayPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict()

export const processDisplayPortSchema = z.union([
  z.enum(['left', 'right', 'top', 'bottom']),
  processDisplayPointSchema,
])
export type ProcessDisplayPort = z.infer<typeof processDisplayPortSchema>

export const processDisplayGeometrySchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive(),
}).strict()
export type ProcessDisplayGeometry = z.infer<typeof processDisplayGeometrySchema>

export const processDisplayWidgetSchema = z.object({
  id: idSchema,
  type: processDisplayWidgetTypeSchema,
  label: z.string().min(1),
  region: idSchema,
  source: processDisplayWidgetSourceSchema.optional(),
  role: z.string().min(1).optional(),
  rank: z.number().int().nonnegative().default(0),
  stack: z.number().int().nonnegative().default(0),
  geometry: processDisplayGeometrySchema.optional(),
  binds: z.record(z.string(), processDisplayBindingSchema).default({}),
  ports: z.record(z.string(), processDisplayPortSchema).default({}),
  style: z.object({
    tone: z.enum(['primary', 'secondary', 'support', 'warning', 'critical']).optional(),
  }).strict().default({}),
}).strict()
export type ProcessDisplayWidget = z.infer<typeof processDisplayWidgetSchema>

export const processDisplayPathSchema = z.object({
  id: idSchema,
  label: z.string().min(1).optional(),
  source: processDisplayPathSourceSchema.optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  waypoints: z.array(processDisplayPointSchema).default([]),
  binds: z.record(z.string(), processDisplayBindingSchema).default({}),
  style: z.object({
    service: z.enum(['primary', 'steam', 'feedwater', 'condensate', 'electrical', 'cooling', 'support']).optional(),
  }).strict().default({}),
}).strict()
export type ProcessDisplayPath = z.infer<typeof processDisplayPathSchema>

export const processDisplayGraphLensSchema = z.discriminatedUnion('mode', [
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
export type ProcessDisplayGraphLens = z.infer<typeof processDisplayGraphLensSchema>

export const processDisplayLensSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  lens: processDisplayGraphLensSchema.optional(),
}).strict()
export type ProcessDisplayLens = z.infer<typeof processDisplayLensSchema>

export const processDisplayDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  designSize: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict(),
  regions: z.array(processDisplayRegionSchema).min(1),
  lenses: z.array(processDisplayLensSchema).default([]),
  widgets: z.array(processDisplayWidgetSchema).min(1),
  paths: z.array(processDisplayPathSchema).default([]),
}).strict().superRefine((display, ctx) => {
  const regionIds = new Set<string>()
  for (const [index, region] of display.regions.entries()) {
    if (regionIds.has(region.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['regions', index, 'id'], message: `duplicate process display region id: ${region.id}` })
    }
    regionIds.add(region.id)
  }
  const lensIds = new Set<string>()
  for (const [index, lens] of display.lenses.entries()) {
    if (lensIds.has(lens.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lenses', index, 'id'], message: `duplicate process display lens id: ${lens.id}` })
    }
    lensIds.add(lens.id)
  }
  const widgetIds = new Set<string>()
  for (const [index, widget] of display.widgets.entries()) {
    if (widgetIds.has(widget.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['widgets', index, 'id'], message: `duplicate process display widget id: ${widget.id}` })
    }
    widgetIds.add(widget.id)
    if (!regionIds.has(widget.region)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['widgets', index, 'region'], message: `unknown process display region: ${widget.region}` })
    }
  }
  const portRefs = new Set<string>()
  for (const widget of display.widgets) {
    for (const port of Object.keys(widget.ports)) portRefs.add(`${widget.id}.${port}`)
  }
  const pathIds = new Set<string>()
  for (const [index, path] of display.paths.entries()) {
    if (pathIds.has(path.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paths', index, 'id'], message: `duplicate process display path id: ${path.id}` })
    }
    pathIds.add(path.id)
    if (!portRefs.has(path.from)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paths', index, 'from'], message: `unknown process display source port: ${path.from}` })
    }
    if (!portRefs.has(path.to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paths', index, 'to'], message: `unknown process display target port: ${path.to}` })
    }
  }
})
export type ProcessDisplayDefinition = z.infer<typeof processDisplayDefinitionSchema>

export interface ProcessDisplayValue {
  readonly path: VariablePath
  readonly label: string
  readonly unit: string
  readonly value: unknown
  readonly formatted: string
}

export interface CompiledProcessDisplayWidget {
  readonly id: string
  readonly type: ProcessDisplayWidgetType
  readonly label: string
  readonly source?: { readonly componentIds: ReadonlyArray<ComponentId> }
  readonly role?: string
  readonly geometry: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly binds: Readonly<Record<string, ProcessDisplayBinding>>
  readonly ports: Readonly<Record<string, { readonly x: number; readonly y: number }>>
  readonly style: ProcessDisplayWidget['style']
}

export interface CompiledProcessDisplayPath {
  readonly id: string
  readonly label?: string
  readonly source?: { readonly connectionId: ConnectionId }
  readonly from: { readonly widgetId: string; readonly portName: string }
  readonly to: { readonly widgetId: string; readonly portName: string }
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>
  readonly binds: Readonly<Record<string, ProcessDisplayBinding>>
  readonly style: ProcessDisplayPath['style']
}

export interface CompiledProcessDisplay {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly designSize: ProcessDisplayDefinition['designSize']
  readonly lenses: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly description?: string
    readonly lens?: ProcessDisplayGraphLens
  }>
  readonly widgets: ReadonlyArray<CompiledProcessDisplayWidget>
  readonly paths: ReadonlyArray<CompiledProcessDisplayPath>
  readonly bindingPaths: ReadonlyArray<VariablePath>
}

export type { ConnectionService }
