import { z } from 'zod'
import { idSchema, objectIdSchema, type ObjectId } from './ids.ts'
import { geoJsonPointSchema, type GeoJsonPoint } from './geo.ts'
import { objectContextSchema, type ObjectContext } from './context.ts'
import { operationalObjectSchema, type OperationalObject } from './object.ts'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'

export interface ScenarioWorldDefinition {
  readonly startsAt?: IsoTimestamp
  readonly mapCenter?: GeoJsonPoint
  readonly environment: Record<string, unknown>
}

export type SurfaceMapLayer = 'objects' | 'routes' | 'traffic' | 'highlights'

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

export interface ScenarioInitialObjectContext {
  readonly objectId: string
  readonly context: ObjectContext
}

export interface ScenarioGuidance {
  readonly id: string
  readonly title: string
  readonly message: string
  readonly objectIds: ReadonlyArray<ObjectId>
  readonly dismissible: boolean
  readonly tone?: 'default' | 'update'
}

export interface ScenarioScriptProgressState {
  readonly startedAt: IsoTimestamp
  readonly firedStepIds: ReadonlyArray<string>
}

export interface ScenarioInstanceState {
  readonly scenarioId: string
  readonly guidance?: ScenarioGuidance
  readonly highlightedObjectIds: ReadonlyArray<ObjectId>
  readonly script?: ScenarioScriptProgressState
}

export interface ScenarioTimeRef {
  readonly kind: 'after_scenario_start'
  readonly seconds: number
}

export type ScenarioScriptAction =
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

export interface ScenarioScriptStep {
  readonly id: string
  readonly at: ScenarioTimeRef
  readonly title?: string
  readonly actions: ReadonlyArray<ScenarioScriptAction>
}

export interface ScenarioScript {
  readonly steps: ReadonlyArray<ScenarioScriptStep>
}

export interface ScenarioDefinition {
  readonly id: string
  readonly schemaVersion: 1
  readonly title: string
  readonly description?: string
  readonly packs: ReadonlyArray<string>
  readonly providerOverrides: Record<string, string>
  readonly world: ScenarioWorldDefinition
  readonly initialObjects: ReadonlyArray<OperationalObject>
  readonly initialContexts: ReadonlyArray<ScenarioInitialObjectContext>
  readonly providerConfigs: Record<string, unknown>
  readonly missionId?: string
  readonly surface: SurfaceDefinition
  readonly script?: ScenarioScript
}

export const scenarioWorldDefinitionSchema = z.object({
  startsAt: isoTimestampSchema.optional(),
  mapCenter: geoJsonPointSchema.optional(),
  environment: z.record(z.unknown()).default({}),
})

export const surfaceMapLayerSchema = z.enum(['objects', 'routes', 'traffic', 'highlights'])

export const surfaceMapRegionConfigSchema = z.object({
  center: geoJsonPointSchema,
  zoom: z.number().finite().min(0).max(24),
  layers: z.array(surfaceMapLayerSchema).default(['objects', 'routes', 'traffic', 'highlights']),
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
    config: z.record(z.never()).default({}),
  }),
  z.object({
    id: idSchema,
    primitive: z.literal('guidanceOverlay'),
    visible: z.boolean().default(true),
    config: z.record(z.never()).default({}),
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

export const scenarioInitialObjectContextSchema = z.object({
  objectId: idSchema,
  context: objectContextSchema,
})

export const scenarioGuidanceSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  message: z.string().min(1),
  objectIds: z.array(objectIdSchema).default([]),
  dismissible: z.boolean().default(true),
  tone: z.enum(['default', 'update']).default('default'),
})

export const scenarioScriptProgressStateSchema = z.object({
  startedAt: isoTimestampSchema,
  firedStepIds: z.array(idSchema).default([]),
})

export const scenarioInstanceStateSchema = z.object({
  scenarioId: idSchema,
  guidance: scenarioGuidanceSchema.optional(),
  highlightedObjectIds: z.array(objectIdSchema).default([]),
  script: scenarioScriptProgressStateSchema.optional(),
})

export const scenarioTimeRefSchema = z.object({
  kind: z.literal('after_scenario_start'),
  seconds: z.number().finite().nonnegative(),
})

export const scenarioScriptActionSchema = z.discriminatedUnion('type', [
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
])

export const scenarioScriptStepSchema = z.object({
  id: idSchema,
  at: scenarioTimeRefSchema,
  title: z.string().min(1).optional(),
  actions: z.array(scenarioScriptActionSchema).min(1),
})

export const scenarioScriptSchema = z.object({
  steps: z.array(scenarioScriptStepSchema).default([]),
}).superRefine((script, ctx) => {
  const seen = new Set<string>()
  for (const [index, step] of script.steps.entries()) {
    if (seen.has(step.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate scenario script step id: ${step.id}`,
        path: ['steps', index, 'id'],
      })
    }
    seen.add(step.id)
  }
})

export const scenarioDefinitionSchema = z.object({
  id: idSchema,
  schemaVersion: z.literal(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  packs: z.array(idSchema).default([]),
  providerOverrides: z.record(idSchema).default({}),
  world: scenarioWorldDefinitionSchema,
  initialObjects: z.array(operationalObjectSchema),
  initialContexts: z.array(scenarioInitialObjectContextSchema).default([]),
  providerConfigs: z.record(z.unknown()).default({}),
  missionId: idSchema.optional(),
  surface: surfaceDefinitionSchema,
  script: scenarioScriptSchema.optional(),
})
