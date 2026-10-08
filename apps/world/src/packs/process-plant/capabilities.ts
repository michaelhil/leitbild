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
  procedureConditionEvaluateQuerySchema,
} from './queries/control-query.ts'
import {
  credibilityListPayloadSchema,
  credibilityReadPayloadSchema,
} from './queries/credibility-query.ts'
import { displayQuerySchema, graphLensQuerySchema } from './queries/display-query.ts'
import { embeddedViewPublicationSchema } from '@leitbild/contracts'
import {
  displayComposeQuerySchema,
  displaySampleQuerySchema,
  displayViewQuerySchema,
} from './queries/composed-display-query.ts'
import { artifactReadQuerySchema, componentsSearchQuerySchema, displayProfileReadQuerySchema } from './queries/graph-query.ts'
import { plantQuerySchema } from './queries/common.ts'
import {
  procedureTagsValidateQuerySchema,
  signalsReadQuerySchema,
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

const selectiveArtifactShape = {
  plantId: plantIdSchema,
  artifact: z.enum(['authored-spec', 'compiled-graph-mermaid']),
  metadata: recordSchema,
  coverage: z.string(),
}

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
      modelRef: z.string().min(1),
      modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
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
  'world.process-plant.artifact.read': z.union([z.object({
    plantId: plantIdSchema,
    artifact: z.enum(['authored-spec', 'compiled-graph-mermaid']),
    title: z.string(),
    language: z.enum(['json', 'mermaid']),
    content: z.string(),
    components: recordArraySchema,
    sourceFiles: recordArraySchema,
    metadata: recordSchema,
  }).strict(),
  z.object({
    ...selectiveArtifactShape, mode: z.literal('index'),
    total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(), hasMore: z.boolean(),
    components: recordArraySchema, sourceFiles: recordArraySchema,
  }).strict(),
  z.object({ ...selectiveArtifactShape, mode: z.literal('component'), component: recordSchema, authoredComponent: recordSchema }).strict(),
  z.object({
    ...selectiveArtifactShape, mode: z.literal('source'), sourcePath: z.string(), sha256: z.string(),
    totalLines: z.number().int().nonnegative(), byteCount: z.number().int().nonnegative(),
    startLine: z.number().int().positive(), endLine: z.number().int().nonnegative(),
    returnedLines: z.number().int().nonnegative(), content: z.string(), hasMore: z.boolean(),
    nextRead: recordSchema.nullable(),
  }).strict()]),
  'world.process-plant.display-profile.read': z.object({ plantId: plantIdSchema, profile: recordSchema, groups: recordArraySchema }).strict(),
  'world.process-plant.variables.read': z.object({ variables: recordArraySchema }).strict(),
  'world.process-plant.variables.search': pagedPlantRecordsSchema('variables', 'variable'),
  'world.process-plant.signals.resolve': z.object({ plantId: plantIdSchema, signals: recordArraySchema }).strict(),
  'world.process-plant.signals.read': z.object({ plantId: plantIdSchema, signals: recordArraySchema }).strict(),
  'world.process-plant.signals.search': pagedPlantRecordsSchema('signals', 'signal'),
  'world.process-plant.procedure-tags.validate': z.object({ plantId: plantIdSchema, tags: recordArraySchema }).strict(),
  'world.process-plant.conditions.evaluate': z.object({ plantId: plantIdSchema, matches: z.boolean(), signalsRead: recordArraySchema }).strict(),
  'world.process-plant.procedure-condition.evaluate': z.object({
    targetObjectId: objectIdSchema,
    status: z.enum(['satisfied', 'challenged', 'unknown']),
    reason: z.string().optional(),
    modelRef: z.string().min(1),
    modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
    simTimeMs: z.number().nonnegative(),
    basis: recordSchema,
    automaticCsfQualified: z.literal(false),
    evidence: recordArraySchema,
  }).strict(),
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
  'world.process-plant.display.compose': z.object({
    plantId: plantIdSchema,
    issuedAt: z.string(),
    view: embeddedViewPublicationSchema,
    signals: z.array(z.object({ ref: z.string(), tagId: z.string().optional(), path: z.string(), label: z.string(), unit: z.string() }).strict()),
    shows: z.array(z.string()),
    warnings: z.array(z.string()),
  }).strict(),
  'world.process-plant.display.view': z.object({
    plantId: plantIdSchema,
    plantLabel: z.string().nullable(),
    issuedAt: z.string(),
    simulationTime: z.string(),
    modelChanged: z.boolean(),
    display: recordSchema,
  }).strict(),
  'world.process-plant.display.sample': z.object({
    plantId: plantIdSchema,
    simulationTime: z.string(),
    plantElapsedMs: z.number(),
    alarms: z.array(z.object({
      id: z.string(),
      ruleId: z.string(),
      kind: z.enum(['alarm', 'trip']),
      title: z.string(),
      severity: z.enum(['info', 'notice', 'warning', 'critical']),
      acknowledged: z.boolean(),
      firstOut: z.boolean(),
      firstActiveElapsedMs: z.number().optional(),
    }).strict()).optional(),
    values: z.array(z.object({
      path: z.string(),
      value: z.union([z.number(), z.boolean()]),
      quality: z.enum(['good', 'outside-hard-range']),
    }).strict()),
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
  'world.process-plant.signals.read': signalsReadQuerySchema,
  'world.process-plant.signals.search': signalsSearchQuerySchema,
  'world.process-plant.procedure-tags.validate': procedureTagsValidateQuerySchema,
  'world.process-plant.conditions.evaluate': conditionsEvaluateQuerySchema,
  'world.process-plant.procedure-condition.evaluate': procedureConditionEvaluateQuerySchema,
  'world.process-plant.assessments.evaluate': assessmentsEvaluateQuerySchema,
  'world.process-plant.control.validate': processPlantControlWritePayloadSchema,
  'world.process-plant.runtime.status': processPlantCatalogInputSchema,
  'world.process-plant.transient.diagnostics': plantQuerySchema,
  ...Object.fromEntries(processPlantIcQueryKinds.map(id => [id, plantQuerySchema])),
  'world.process-plant.displays.list': plantQuerySchema,
  'world.process-plant.display.read': displayQuerySchema,
  'world.process-plant.display.snapshot': displayQuerySchema,
  'world.process-plant.display.project': graphLensQuerySchema,
  'world.process-plant.display.compose': displayComposeQuerySchema,
  'world.process-plant.display.view': displayViewQuerySchema,
  'world.process-plant.display.sample': displaySampleQuerySchema,
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
  'world.process-plant.artifact.read': 'Inspect Plant configuration and implementation evidence. Default mode index returns paged component identities and source-file paths, sizes and hashes, without source content. mode component selects one exact componentId and its authored configuration/source links. mode source reads bounded lines from an indexed sourcePath; copy nextRead to continue with the same content hash. mode full explicitly exports the complete authored Plant configuration or compiled graph and existing source bundle (large). The implementation bundle covers behavior files and direct named imports, not the complete Pack or application; absence is not proof of no implementation. Not a live-state read.',
  'world.process-plant.display-profile.read': 'Read a configured operator display profile with its current grouped field values. Use an exact profileId returned by plants.list.',
  'world.process-plant.variables.read': 'Read current values and metadata for exact Plant variable paths returned by variables.search or another discovery view; do not guess paths.',
  'world.process-plant.variables.search': 'Search current Plant variables by text, discipline, quantity, publication state, and Plant; results are paginated.',
  'world.process-plant.signals.resolve': 'Resolve exact signal references to canonical Plant signal bindings.',
  'world.process-plant.signals.read': 'Read live values, metadata, and quality for exact Plant signal references. Optional requestedUnit adds a valueView; native values are unchanged, and unavailable conversions retain actual units with a reason. valueView status describes conversion, not sensor quality. Quality good means only not outside a declared hard range; it does not establish calibrated instrumentation or model validity.',
  'world.process-plant.signals.search': 'Search Plant signal bindings by tag, equipment, discipline, quantity, writability, procedure relevance, and text; results are paginated.',
  'world.process-plant.procedure-tags.validate': 'Validate a set of procedure tags against one Plant and report missing or mismatched bindings.',
  'world.process-plant.conditions.evaluate': 'Evaluate declared operating conditions against current Plant signals. Comparison values must use the resolved signal\'s native unit and value type. Requested-unit views do not change condition thresholds; no procedure-unit conversion is performed.',
  'world.process-plant.assessments.evaluate': 'Read selected reference-model CSF observation groups with source, model identity and simulation time. Automatic CSF status remains unknown because qualified restoration criteria are not installed; these engineering diagnostics do not establish instrument validity or safety-function adequacy.',
  'world.process-plant.procedure-condition.evaluate': 'Read-only evaluation of an authored, model-digest-pinned condition with explicit native units. Returns satisfied, challenged or unknown and every comparison observation at one simulation time. Values are runtime model evidence, not qualified instrumentation or automatic CSF restoration; authored source citations are retained, not independently verified. No equipment command, protection change or procedure transition is performed.',
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
  'world.process-plant.display.compose': 'Compose a small live operator display for one Plant, shown below your answer. State the operator question and need, then choose 1-3 panels: trend (1-3 numeric signals of one unit; a second trend stacks another unit on the same time axis), comparison (2-6 parallel signals of one unit, e.g. the loops), readouts (1-6 current values or on/off states with margin to thresholds, for signals not already trended) and alarms (active alarms related to the displayed signals, or the whole Plant). Give every signal a role (primary, context, counter-evidence) and use exact tagIds or paths from your evidence. Most answers need one trend, e.g. {"plantId":"plant:x","title":"SG B level","question":"Is SG B level recovering?","need":"Decide on manual feed","panels":[{"kind":"trend","horizon":"10m","signals":[{"ref":"SG-B-LVL-NR","role":"primary"},{"ref":"SG-A-LVL-NR","role":"context"}]}]}. The Pack resolves signals, draws I&C thresholds from configured rules, lays out the display and keeps it live. Read-only: it stores nothing and changes no Plant, Run or scenario state. Returns the view to present, what it shows and warnings, or rejects with every issue and did-you-mean suggestions.',
  'world.process-plant.display.view': 'Compile a previously composed display state for a live display view. Display views use this; to create a display, use display.compose.',
  'world.process-plant.display.sample': 'Read current values and hard-range quality for up to 12 exact signal paths, and optionally the active alarms and trips, at the current Simulation Run time. Live display views use this for polling.',
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
            const plantId = id === 'world.process-plant.procedure-condition.evaluate'
              ? (rawInput as { targetObjectId?: unknown }).targetObjectId
              : (rawInput as { plantId?: unknown }).plantId
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
