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
  readonly script?: ScenarioScript
}

export const scenarioWorldDefinitionSchema = z.object({
  startsAt: isoTimestampSchema.optional(),
  mapCenter: geoJsonPointSchema.optional(),
  environment: z.record(z.unknown()).default({}),
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
  script: scenarioScriptSchema.optional(),
})
