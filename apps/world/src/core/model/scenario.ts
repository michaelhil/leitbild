import { z } from 'zod'
import { idSchema, objectIdSchema, signalIdSchema, type ObjectId, type SignalId } from './ids.ts'
import { geoJsonPointSchema, type GeoJsonPoint } from './geo.ts'
import { interactionEndpointSchema, type InteractionEndpoint } from './interactions.ts'
import { operationalObjectSchema, type OperationalObject } from './object.ts'
import { scenarioRecordingSelectionSchema, type ScenarioRecordingSelection } from './recording.ts'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'
import { electricalConnectionDefinitionSchema, type ElectricalConnectionDefinition } from './electrical.ts'

export interface ScenarioWorldDefinition {
  readonly startsAt?: IsoTimestamp
  readonly environment: Record<string, unknown>
}

export type SurfaceMapLayer = 'objects' | 'routes' | 'traffic' | 'weather' | 'grid' | 'highlights'

export interface SurfaceMapRegionConfig {
  readonly center: GeoJsonPoint
  readonly zoom: number
  readonly layers: ReadonlyArray<SurfaceMapLayer>
}

export interface SurfaceObjectRailSectionConfig {
  readonly categoryId: string
  readonly visible: boolean
  readonly collapsed: boolean
  readonly visibleFields: ReadonlyArray<string>
}

export interface SurfaceObjectRailRegionConfig {
  readonly width?: number
  readonly sections: ReadonlyArray<SurfaceObjectRailSectionConfig>
}

export type SurfaceRegionDefinition =
  | {
      readonly id: string
      readonly primitive: 'map'
      readonly visible: boolean
      readonly config: SurfaceMapRegionConfig
    }
  | {
      readonly id: string
      readonly primitive: 'objectRail'
      readonly visible: boolean
      readonly config: SurfaceObjectRailRegionConfig
    }
  | {
      readonly id: string
      readonly primitive: 'systemFooter'
      readonly visible: boolean
      readonly config: Record<string, never>
    }
  | {
      readonly id: string
      readonly primitive: 'guidanceOverlay'
      readonly visible: boolean
      readonly config: Record<string, never>
    }

export interface SurfaceDefinition {
  readonly schemaVersion: 1
  readonly regions: ReadonlyArray<SurfaceRegionDefinition>
}

export interface ScenarioGuidance {
  readonly id: string
  readonly title: string
  readonly message: string
  readonly objectIds: ReadonlyArray<ObjectId>
  readonly dismissible: boolean
  readonly tone?: 'default' | 'update'
}

export interface ScenarioTimelineProgressState {
  readonly startedAt: IsoTimestamp
  readonly firedCueIds: ReadonlyArray<string>
}

export interface ScenarioExecutionState {
  readonly scenarioId: string
  readonly guidance?: ScenarioGuidance
  readonly highlightedObjectIds: ReadonlyArray<ObjectId>
  readonly timeline?: ScenarioTimelineProgressState
}

export interface ScenarioTimeRef {
  readonly kind: 'after_scenario_start'
  readonly seconds: number
}

export type ScenarioTimelineAction =
  | {
      readonly type: 'show_guidance'
      readonly guidance: ScenarioGuidance
    }
  | {
      readonly type: 'hide_guidance'
      readonly guidanceId?: string
    }
  | {
      readonly type: 'highlight_objects'
      readonly objectIds: ReadonlyArray<ObjectId>
    }
  | {
      readonly type: 'clear_highlights'
      readonly objectIds?: ReadonlyArray<ObjectId>
    }
  | {
      readonly type: 'upsert_object'
      readonly object: OperationalObject
    }
  | {
      readonly type: 'delete_object'
      readonly objectId: ObjectId
    }
  | {
      readonly type: 'emit_signal'
      readonly signal: {
        readonly id: SignalId
        readonly source: InteractionEndpoint
        readonly targets: ReadonlyArray<InteractionEndpoint>
        readonly signalType: string
        readonly payload: unknown
        readonly severity?: 'info' | 'notice' | 'warning' | 'critical'
        readonly correlationId?: string
        readonly causationId?: string
        readonly ttlMs?: number
      }
    }
  | {
      readonly type: 'invoke_capability'
      readonly capabilityId: string
      readonly input: unknown
    }

export interface ScenarioTimelineCue {
  readonly id: string
  readonly at: ScenarioTimeRef
  readonly title?: string
  readonly actions: ReadonlyArray<ScenarioTimelineAction>
}

export interface ScenarioTimeline {
  readonly cues: ReadonlyArray<ScenarioTimelineCue>
}

export interface ScenarioDefinition {
  readonly id: string
  readonly schemaVersion: 1
  readonly title: string
  readonly description?: string
  readonly objectives?: ReadonlyArray<string>
  readonly packs: ReadonlyArray<string>
  readonly packRuntimes: Record<string, string>
  readonly packConfigs: Record<string, unknown>
  readonly connections: ReadonlyArray<ElectricalConnectionDefinition>
  readonly world: ScenarioWorldDefinition
  readonly initialObjects: ReadonlyArray<OperationalObject>
  readonly surface: SurfaceDefinition
  readonly recording: ReadonlyArray<ScenarioRecordingSelection>
  readonly timeline?: ScenarioTimeline
}

export const scenarioWorldDefinitionSchema = z.object({
  startsAt: isoTimestampSchema.optional(),
  environment: z.record(z.string(), z.unknown()).default({}),
})

export const surfaceMapLayerSchema = z.enum(['objects', 'routes', 'traffic', 'weather', 'grid', 'highlights'])

export const surfaceMapRegionConfigSchema = z.object({
  center: geoJsonPointSchema,
  zoom: z.number().finite().min(0).max(24),
  layers: z.array(surfaceMapLayerSchema).default(['objects', 'routes', 'traffic', 'weather', 'grid', 'highlights']),
})

export const surfaceObjectRailSectionConfigSchema = z.object({
  categoryId: idSchema,
  visible: z.boolean().default(true),
  collapsed: z.boolean().default(false),
  visibleFields: z.array(idSchema).default([]),
})

export const surfaceObjectRailRegionConfigSchema = z.object({
  width: z.number().finite().min(0).max(900).optional(),
  sections: z.array(surfaceObjectRailSectionConfigSchema).default([]),
})

export const surfaceRegionDefinitionSchema = z.discriminatedUnion('primitive', [
  z.object({
    id: idSchema,
    primitive: z.literal('map'),
    visible: z.boolean().default(true),
    config: surfaceMapRegionConfigSchema,
  }),
  z.object({
    id: idSchema,
    primitive: z.literal('objectRail'),
    visible: z.boolean().default(true),
    config: surfaceObjectRailRegionConfigSchema,
  }),
  z.object({
    id: idSchema,
    primitive: z.literal('systemFooter'),
    visible: z.boolean().default(true),
    config: z.record(z.string(), z.never()).default({}),
  }),
  z.object({
    id: idSchema,
    primitive: z.literal('guidanceOverlay'),
    visible: z.boolean().default(true),
    config: z.record(z.string(), z.never()).default({}),
  }),
])

export const surfaceDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  regions: z.array(surfaceRegionDefinitionSchema).default([]),
}).superRefine((surface, ctx) => {
  const regionIds = new Set<string>()
  const primitives = new Set<string>()
  for (const [index, region] of surface.regions.entries()) {
    if (regionIds.has(region.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate surface region id: ${region.id}`,
        path: ['regions', index, 'id'],
      })
    }
    regionIds.add(region.id)
    if (primitives.has(region.primitive)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate surface primitive: ${region.primitive}`,
        path: ['regions', index, 'primitive'],
      })
    }
    primitives.add(region.primitive)
  }
})

export const scenarioGuidanceSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  message: z.string().min(1),
  objectIds: z.array(objectIdSchema).default([]),
  dismissible: z.boolean().default(true),
  tone: z.enum(['default', 'update']).default('default'),
})

export const scenarioTimelineProgressStateSchema = z.object({
  startedAt: isoTimestampSchema,
  firedCueIds: z.array(idSchema).default([]),
})

export const scenarioExecutionStateSchema = z.object({
  scenarioId: idSchema,
  guidance: scenarioGuidanceSchema.optional(),
  highlightedObjectIds: z.array(objectIdSchema).default([]),
  timeline: scenarioTimelineProgressStateSchema.optional(),
})

export const scenarioTimeRefSchema = z.object({
  kind: z.literal('after_scenario_start'),
  seconds: z.number().finite().nonnegative(),
})

export const scenarioTimelineActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('show_guidance'),
    guidance: scenarioGuidanceSchema,
  }),
  z.object({
    type: z.literal('hide_guidance'),
    guidanceId: idSchema.optional(),
  }),
  z.object({
    type: z.literal('highlight_objects'),
    objectIds: z.array(objectIdSchema).min(1),
  }),
  z.object({
    type: z.literal('clear_highlights'),
    objectIds: z.array(objectIdSchema).optional(),
  }),
  z.object({
    type: z.literal('upsert_object'),
    object: operationalObjectSchema,
  }),
  z.object({
    type: z.literal('delete_object'),
    objectId: objectIdSchema,
  }),
  z.object({
    type: z.literal('emit_signal'),
    signal: z.object({
      id: signalIdSchema,
      source: interactionEndpointSchema,
      targets: z.array(interactionEndpointSchema),
      signalType: idSchema,
      payload: z.unknown(),
      severity: z.enum(['info', 'notice', 'warning', 'critical']).optional(),
      correlationId: idSchema.optional(),
      causationId: idSchema.optional(),
      ttlMs: z.number().finite().positive().optional(),
    }).strict(),
  }),
  z.object({
    type: z.literal('invoke_capability'),
    capabilityId: z.string().regex(/^world\.[a-z][a-z0-9-]*(?:[._-][a-z0-9-]+)+$/),
    input: z.custom<unknown>(value => value !== undefined, 'input is required'),
  }),
])

export const scenarioTimelineCueSchema = z.object({
  id: idSchema,
  at: scenarioTimeRefSchema,
  title: z.string().min(1).optional(),
  actions: z.array(scenarioTimelineActionSchema).min(1),
})

export const scenarioTimelineSchema = z.object({
  cues: z.array(scenarioTimelineCueSchema).default([]),
}).superRefine((timeline, ctx) => {
  const seen = new Set<string>()
  for (const [index, cue] of timeline.cues.entries()) {
    if (seen.has(cue.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate scenario timeline cue id: ${cue.id}`,
        path: ['cues', index, 'id'],
      })
    }
    seen.add(cue.id)
  }
})

export const scenarioDefinitionSchema = z.object({
  id: idSchema,
  schemaVersion: z.literal(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  objectives: z.array(z.string().trim().min(1).max(2048)).optional(),
  packs: z.array(idSchema).default([]),
  packRuntimes: z.record(z.string(), idSchema).default({}),
  packConfigs: z.record(z.string(), z.unknown()).default({}),
  connections: z.array(electricalConnectionDefinitionSchema).default([]),
  world: scenarioWorldDefinitionSchema,
  initialObjects: z.array(operationalObjectSchema),
  surface: surfaceDefinitionSchema,
  recording: z.array(scenarioRecordingSelectionSchema).default([]),
  timeline: scenarioTimelineSchema.optional(),
}).superRefine((scenario, ctx) => {
  const connectionIds = new Set<string>()
  const connectedPorts = new Set<string>()
  scenario.connections.forEach((connection, index) => {
    if (connectionIds.has(connection.id)) {
      ctx.addIssue({ code: 'custom', path: ['connections', index, 'id'], message: `duplicate electrical connection: ${connection.id}` })
    }
    connectionIds.add(connection.id)
    for (const [side, endpoint] of [['system', connection.system], ['network', connection.network]] as const) {
      const key = `${endpoint.objectId}:${endpoint.portId}`
      if (connectedPorts.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['connections', index, side], message: `electrical port is connected more than once: ${key}` })
      }
      connectedPorts.add(key)
    }
  })
  const packIds = new Set<string>()
  scenario.recording.forEach((selection, index) => {
    if (packIds.has(selection.packId)) {
      ctx.addIssue({ code: 'custom', path: ['recording', index, 'packId'], message: `duplicate recording selection for Pack: ${selection.packId}` })
    }
    packIds.add(selection.packId)
  })
})
