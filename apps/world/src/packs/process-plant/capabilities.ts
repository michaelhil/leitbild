import { z } from 'zod'
import { commandResultSchema, objectIdSchema } from '../../core/model/index.ts'
import {
  defineSimulationCommandCapability,
  defineSimulationQueryCapability,
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
import { processPlantActions } from './actions.ts'
import { processPlantActionsSearchInputSchema, processPlantCatalogInputSchema } from './queries/catalog-query.ts'
import {
  assessmentsEvaluateQuerySchema,
  conditionsEvaluateQuerySchema,
} from './queries/control-query.ts'
import {
  credibilityListPayloadSchema,
  credibilityReadPayloadSchema,
} from './queries/credibility-query.ts'
import { displayQuerySchema, graphLensQuerySchema } from './queries/display-query.ts'
import { artifactReadQuerySchema, componentsSearchQuerySchema, displayProfileReadQuerySchema } from './queries/graph-query.ts'
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
const pagedPlantRecordsSchema = (collectionField: string, itemField: string) => z.object({
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  [collectionField]: z.array(z.object({ plantId: plantIdSchema, [itemField]: recordSchema }).strict()),
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
  'world.process-plant.actions.search': z.object({
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    actions: recordArraySchema,
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
      label: z.string().min(1),
      model: z.object({ id: z.string().min(1), title: z.string().min(1) }).strict(),
      componentCount: z.number().int().nonnegative(),
      linkCount: z.number().int().nonnegative(),
      variableCount: z.number().int().nonnegative(),
      elapsedMs: z.number().nonnegative(),
      displayProfiles: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) }).strict()),
    }).strict()),
  }).strict(),
  'world.process-plant.graph.read': z.object({ graph: recordSchema }).strict(),
  'world.process-plant.components.search': z.object({
    plantId: plantIdSchema,
    specification: recordSchema,
    totalComponents: z.number().int().nonnegative(),
    matchedComponents: z.number().int().nonnegative(),
    byKind: z.record(z.string(), z.number().int().nonnegative()),
    components: recordArraySchema,
  }).strict(),
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
  'world.process-plant.variables.search': pagedPlantRecordsSchema('variables', 'variable'),
  'world.process-plant.signals.resolve': z.object({ plantId: plantIdSchema, signals: recordArraySchema }).strict(),
  'world.process-plant.signals.read': z.object({ plantId: plantIdSchema, signals: recordArraySchema }).strict(),
  'world.process-plant.signals.search': pagedPlantRecordsSchema('signals', 'signal'),
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
  'world.process-plant.actions.search': processPlantActionsSearchInputSchema,
  'world.process-plant.credibility.list': credibilityListPayloadSchema,
  'world.process-plant.credibility.read': credibilityReadPayloadSchema,
  'world.process-plant.plants.list': processPlantCatalogInputSchema,
  'world.process-plant.graph.read': plantQuerySchema,
  'world.process-plant.components.search': componentsSearchQuerySchema,
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

const queryDescriptionById: Readonly<Record<string, string>> = {
  'world.process-plant.catalog.list': 'Discover authored Process Plant model, operating-point, automation, control, assessment, recording, display, and credibility options. This is configuration, not a list of live Plant instances.',
  'world.process-plant.actions.search': 'Search Pack-declared Process Plant actions, including their exact actionId values, descriptions, parameters, and input schemas. The selected Plant validates applicability when an action is invoked.',
  'world.process-plant.credibility.list': 'List engineering credibility evidence available for one Plant.',
  'world.process-plant.credibility.read': 'Read one engineering evidence artifact and its provenance for one Plant.',
  'world.process-plant.plants.list': 'Discover live active Plant units and their exact plantId values, model library, graph size, variable count, and elapsed simulation time. Use these identities for Plant-specific reads.',
  'world.process-plant.graph.read': 'Read one complete compiled Plant component, connection, variable, and signal graph. This is a large engineering view; prefer component or signal search for focused questions.',
  'world.process-plant.components.search': 'Discover Plant components by identity, kind, or text. Returns compact summaries by default and parameters only when requested.',
  'world.process-plant.artifact.read': 'Read one complete authored Plant configuration or compiled graph artifact, including implementation source and calculation links. Use for provenance or full engineering inspection, not routine live-state questions.',
  'world.process-plant.display-profile.read': 'Read a configured operator display profile with its current grouped field values. Use an exact profileId returned by plants.list.',
  'world.process-plant.variables.read': 'Read current values and metadata for exact Plant variable paths returned by variables.search or another discovery view; do not guess paths.',
  'world.process-plant.variables.search': 'Search current Plant variables by text, discipline, quantity, publication state, and Plant; results are paginated.',
  'world.process-plant.signals.resolve': 'Resolve exact signal references to canonical Plant signal bindings.',
  'world.process-plant.signals.read': 'Read live values, metadata, and quality for exact Plant signal references.',
  'world.process-plant.signals.search': 'Search Plant signal bindings by tag, equipment, discipline, quantity, writability, procedure relevance, and text; results are paginated.',
  'world.process-plant.procedure-tags.validate': 'Validate a set of procedure tags against one Plant and report missing or mismatched bindings.',
  'world.process-plant.conditions.evaluate': 'Evaluate declared operating conditions against current Plant signals.',
  'world.process-plant.assessments.evaluate': 'Evaluate selected Pack-declared assessments against current Plant state.',
  'world.process-plant.control.validate': 'Validate a proposed Process Plant control write without applying it.',
  'world.process-plant.runtime.status': 'Summarize active Process Plant runtime health, elapsed time, and variable publication counts.',
  'world.process-plant.transient.diagnostics': 'Read detailed transient, performance, and instrumentation diagnostics for one Plant.',
  'world.process-plant.ic.status': 'Read the complete current I&C snapshot for one Plant, including inactive alarm and trip lifecycle state.',
  'world.process-plant.ic.catalog': 'Discover configured alarm and trip definitions for one Plant.',
  'world.process-plant.alarms.status': 'Read active alarms and trips plus a compact current lifecycle summary for one Plant. Use ic.status only when inactive lifecycle records are needed.',
  'world.process-plant.alarms.summary': 'Read a compact current alarm and trip summary for one Plant.',
  'world.process-plant.alarms.history': 'Read alarm and trip lifecycle transitions recorded for one Plant.',
  'world.process-plant.displays.list': 'List operator displays available for one Plant.',
  'world.process-plant.display.read': 'Read one operator display definition and its available lenses.',
  'world.process-plant.display.snapshot': 'Read the current values and alarms projected onto one operator display.',
  'world.process-plant.display.project': 'Project one Plant graph and operator display through a selected display lens.',
}

const processPlantQueryCapabilities = processPlantQueryKinds.map(id => {
  const input = queryInputById[id]
  const output = queryOutputById[id]
  if (!input) throw new Error(`missing Process Plant capability input schema: ${id}`)
  if (!output) throw new Error(`missing Process Plant capability output schema: ${id}`)
  return defineSimulationQueryCapability({
    id,
    title: titleFor(id),
    description: queryDescriptionById[id] ?? `Read ${titleFor(id)} from the active Process Plant runtime.`,
    input,
    output,
    ...(['world.process-plant.catalog.list', 'world.process-plant.plants.list', 'world.process-plant.runtime.status'].includes(id)
      ? {}
      : {
          inspectObjectIds: (rawInput: unknown) => {
            const plantId = (rawInput as { plantId?: unknown }).plantId
            return typeof plantId === 'string' ? [objectIdSchema.parse(plantId)] : []
          },
        }),
  })
})

const commandCapability = <T extends { readonly plantId: string }>(config: {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly searchTerms?: ReadonlyArray<string>
  readonly input: z.ZodType<T>
  readonly risk?: 'write' | 'destructive'
}) => defineSimulationCommandCapability({
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
    description: 'Invoke a Pack-declared Process Plant action with an exact plantId and actionId. Discover those values with plants.list and actions.search.',
    searchTerms: processPlantActions.flatMap(action => [action.id, action.title, action.description]),
    input: processPlantActionInvokePayloadSchema,
    risk: 'write',
  }),
  ...processPlantQueryCapabilities,
] as const
