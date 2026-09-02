import { z } from 'zod'
import { commandResultSchema, objectIdSchema } from '../../core/model/index.ts'
import {
  definePackCommandCapability,
  definePackQueryCapability,
} from '../../simulation/capabilities.ts'
import {
  processPlantActionInvokeCommandKind,
  processPlantActionInvokePayloadSchema,
  processPlantControlRampCommandKind,
  processPlantControlRampPayloadSchema,
  processPlantControlWriteCommandKind,
  processPlantControlWritePayloadSchema,
  processPlantIcLifecycleCommandKind,
  processPlantIcLifecyclePayloadSchema,
} from './commands.ts'
import { processPlantIcQueryKinds } from './ic-query.ts'
import { processPlantQueryKinds } from './query.ts'
import { processPlantCatalogInputSchema } from './queries/catalog-query.ts'
import {
  assessmentsEvaluateQuerySchema,
  conditionsEvaluateQuerySchema,
} from './queries/control-query.ts'
import {
  credibilityListPayloadSchema,
  credibilityReadPayloadSchema,
} from './queries/credibility-query.ts'
import { displayQuerySchema, graphLensQuerySchema } from './queries/display-query.ts'
import { artifactReadQuerySchema, displayProfileReadQuerySchema } from './queries/graph-query.ts'
import { plantQuerySchema } from './queries/common.ts'
import {
  procedureTagsValidateQuerySchema,
  signalsResolveQuerySchema,
  signalsSearchQuerySchema,
} from './queries/signal-query.ts'
import { variablesReadQuerySchema, variablesSearchQuerySchema } from './queries/variable-query.ts'

const recordSchema = z.record(z.string(), z.json())
const recordArraySchema = z.array(recordSchema)
const plantIdSchema = z.string().min(1)
const plantRecordsSchema = (field: string) => z.object({
  plants: z.array(z.object({ plantId: plantIdSchema, [field]: recordArraySchema }).strict()),
}).strict()

const queryOutputById: Readonly<Record<string, z.ZodType>> = {
  'world.process-plant.catalog.list': z.object({
    models: recordArraySchema,
    operatingPoints: recordArraySchema,
    automations: recordArraySchema,
    actions: recordArraySchema,
    assessments: recordArraySchema,
    recordingProfiles: recordArraySchema,
    displays: recordArraySchema,
    credibilityEvidence: recordArraySchema,
  }).strict(),
  'world.process-plant.credibility.list': z.object({ plantId: plantIdSchema, evidence: recordArraySchema }).strict(),
  'world.process-plant.credibility.read': z.object({
    plantId: plantIdSchema,
    evidence: recordSchema,
    artifact: recordSchema,
    content: z.string(),
  }).strict(),
  'world.process-plant.plants.list': z.object({
    plants: z.array(z.object({
      id: plantIdSchema,
      componentLibrary: z.string(),
      title: z.string(),
      componentCount: z.number().int().nonnegative(),
      linkCount: z.number().int().nonnegative(),
      variableCount: z.number().int().nonnegative(),
      elapsedMs: z.number().nonnegative(),
    }).strict()),
  }).strict(),
  'world.process-plant.graph.read': z.object({ graph: recordSchema }).strict(),
  'world.process-plant.artifact.read': z.object({
    plantId: plantIdSchema,
    artifact: z.enum(['authored-spec', 'compiled-graph-mermaid']),
    title: z.string(),
    language: z.enum(['json', 'mermaid']),
    content: z.string(),
    components: recordArraySchema,
    sourceFiles: recordArraySchema,
    metadata: recordSchema,
  }).strict(),
  'world.process-plant.display-profile.read': z.object({ plantId: plantIdSchema, profile: recordSchema, groups: recordArraySchema }).strict(),
  'world.process-plant.variables.read': z.object({ variables: recordArraySchema }).strict(),
  'world.process-plant.variables.search': plantRecordsSchema('variables'),
  'world.process-plant.signals.resolve': z.object({ plantId: plantIdSchema, signals: recordArraySchema }).strict(),
  'world.process-plant.signals.read': z.object({ plantId: plantIdSchema, signals: recordArraySchema }).strict(),
  'world.process-plant.signals.search': plantRecordsSchema('signals'),
  'world.process-plant.procedure-tags.validate': z.object({ plantId: plantIdSchema, tags: recordArraySchema }).strict(),
  'world.process-plant.conditions.evaluate': z.object({ plantId: plantIdSchema, matches: z.boolean(), signalsRead: recordArraySchema }).strict(),
  'world.process-plant.assessments.evaluate': z.object({ plantId: plantIdSchema, assessments: recordArraySchema }).strict(),
  'world.process-plant.control.validate': z.object({
    accepted: z.boolean(),
    reason: z.string().optional(),
    signal: recordSchema,
    targetPath: z.string(),
    currentValue: z.union([z.number(), z.boolean()]),
  }).strict(),
  'world.process-plant.runtime.status': z.object({
    active: z.boolean(),
    plantCount: z.number().int().nonnegative(),
    plants: recordArraySchema,
  }).strict(),
  'world.process-plant.transient.diagnostics': z.object({ plantId: plantIdSchema, diagnostics: recordSchema, ic: recordSchema }).strict(),
  'world.process-plant.ic.status': z.object({ plantId: plantIdSchema, ic: recordSchema }).strict(),
  'world.process-plant.ic.catalog': z.object({ plantId: plantIdSchema, ic: recordSchema }).strict(),
  'world.process-plant.alarms.status': z.object({ plantId: plantIdSchema, alarms: recordArraySchema, trips: recordArraySchema, summary: recordSchema }).strict(),
  'world.process-plant.alarms.summary': z.object({ plantId: plantIdSchema, summary: recordSchema }).strict(),
  'world.process-plant.alarms.history': z.object({ plantId: plantIdSchema, history: recordArraySchema }).strict(),
  'world.process-plant.displays.list': z.object({ plantId: plantIdSchema, displays: recordArraySchema }).strict(),
  'world.process-plant.display.read': z.object({ plantId: plantIdSchema, display: recordSchema }).strict(),
  'world.process-plant.display.snapshot': z.object({ plantId: plantIdSchema, displayId: z.string(), values: recordArraySchema, alarms: recordSchema }).strict(),
  'world.process-plant.display.project': z.object({
    plantId: plantIdSchema,
    displayId: z.string(),
    graphProjection: recordSchema,
    displayProjection: recordSchema,
  }).strict(),
}

const queryInputById: Readonly<Record<string, z.ZodType>> = {
  'world.process-plant.catalog.list': processPlantCatalogInputSchema,
  'world.process-plant.credibility.list': credibilityListPayloadSchema,
  'world.process-plant.credibility.read': credibilityReadPayloadSchema,
  'world.process-plant.plants.list': processPlantCatalogInputSchema,
  'world.process-plant.graph.read': plantQuerySchema,
  'world.process-plant.artifact.read': artifactReadQuerySchema,
  'world.process-plant.display-profile.read': displayProfileReadQuerySchema,
  'world.process-plant.variables.read': variablesReadQuerySchema,
  'world.process-plant.variables.search': variablesSearchQuerySchema,
  'world.process-plant.signals.resolve': signalsResolveQuerySchema,
  'world.process-plant.signals.read': signalsResolveQuerySchema,
  'world.process-plant.signals.search': signalsSearchQuerySchema,
  'world.process-plant.procedure-tags.validate': procedureTagsValidateQuerySchema,
  'world.process-plant.conditions.evaluate': conditionsEvaluateQuerySchema,
  'world.process-plant.assessments.evaluate': assessmentsEvaluateQuerySchema,
  'world.process-plant.control.validate': processPlantControlWritePayloadSchema,
  'world.process-plant.runtime.status': processPlantCatalogInputSchema,
  'world.process-plant.transient.diagnostics': plantQuerySchema,
  ...Object.fromEntries(processPlantIcQueryKinds.map(id => [id, plantQuerySchema])),
  'world.process-plant.displays.list': plantQuerySchema,
  'world.process-plant.display.read': displayQuerySchema,
  'world.process-plant.display.snapshot': displayQuerySchema,
  'world.process-plant.display.project': graphLensQuerySchema,
}

const titleFor = (id: string): string => id
  .slice('world.process-plant.'.length)
  .split('.')
  .map(part => part.replaceAll('-', ' '))
  .join(' · ')

const processPlantQueryCapabilities = processPlantQueryKinds.map(id => {
  const input = queryInputById[id]
  const output = queryOutputById[id]
  if (!input) throw new Error(`missing Process Plant capability input schema: ${id}`)
  if (!output) throw new Error(`missing Process Plant capability output schema: ${id}`)
  return definePackQueryCapability({
    id,
    title: titleFor(id),
    description: `Read ${titleFor(id)} from the active Process Plant runtime.`,
    input,
    output,
  })
})

const commandCapability = <T extends { readonly plantId: string }>(config: {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly input: z.ZodType<T>
  readonly risk?: 'write' | 'destructive'
}) => definePackCommandCapability({
  ...config,
  risk: config.risk ?? 'write',
  idempotent: false,
  schedulable: true,
  output: commandResultSchema,
  buildCommand: rawInput => {
    const input = config.input.parse(rawInput)
    return {
      targetObjectIds: [objectIdSchema.parse(input.plantId)],
      payload: input,
    }
  },
})

export const processPlantCapabilities = [
  commandCapability({
    id: processPlantControlWriteCommandKind,
    title: 'Write process control',
    description: 'Write one validated Process Plant signal or variable.',
    input: processPlantControlWritePayloadSchema,
  }),
  commandCapability({
    id: processPlantControlRampCommandKind,
    title: 'Ramp process control',
    description: 'Ramp one Process Plant signal or variable to a target over simulation time.',
    input: processPlantControlRampPayloadSchema,
  }),
  commandCapability({
    id: processPlantIcLifecycleCommandKind,
    title: 'Change alarm lifecycle',
    description: 'Acknowledge, reset, suppress, or shelve a Process Plant alarm lifecycle.',
    input: processPlantIcLifecyclePayloadSchema,
  }),
  commandCapability({
    id: processPlantActionInvokeCommandKind,
    title: 'Invoke plant action',
    description: 'Invoke a Pack-declared Process Plant action with validated parameters.',
    input: processPlantActionInvokePayloadSchema,
    risk: 'write',
  }),
  ...processPlantQueryCapabilities,
] as const
