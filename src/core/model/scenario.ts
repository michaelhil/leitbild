import { z } from 'zod'
import { idSchema } from './ids.ts'
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

export interface ScenarioDefinition {
  readonly id: string
  readonly schemaVersion: 1
  readonly title: string
  readonly description?: string
  readonly contributedByPackId: string
  readonly requiredPackIds: ReadonlyArray<string>
  readonly requiredProviderIds: ReadonlyArray<string>
  readonly world: ScenarioWorldDefinition
  readonly initialObjects: ReadonlyArray<OperationalObject>
  readonly initialContexts: ReadonlyArray<ScenarioInitialObjectContext>
  readonly providerConfigs: Record<string, unknown>
  readonly missionId?: string
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

export const scenarioDefinitionSchema = z.object({
  id: idSchema,
  schemaVersion: z.literal(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  contributedByPackId: idSchema,
  requiredPackIds: z.array(idSchema).default([]),
  requiredProviderIds: z.array(idSchema).default([]),
  world: scenarioWorldDefinitionSchema,
  initialObjects: z.array(operationalObjectSchema),
  initialContexts: z.array(scenarioInitialObjectContextSchema).default([]),
  providerConfigs: z.record(z.unknown()).default({}),
  missionId: idSchema.optional(),
})
