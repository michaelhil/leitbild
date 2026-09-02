import {
  inspectionViewSchema,
  moduleCapabilityCollectionSchema,
  moduleCapabilityInvocationSchema,
  moduleDefinitionCollectionSchema,
  moduleIdSchema,
  moduleResourceCollectionSchema,
  resourceRenameInputSchema,
  sourceDocumentPathSchema,
  sourceRevisionSchema,
  workspaceIdSchema,
  workspaceModuleManifestSchema,
  type ModuleCapabilityDescriptor,
  type ModuleResourceDescriptor
} from '@leitbild/contracts'
import { createModuleCapabilityRegistry } from '@leitbild/module-runtime'
import { z } from 'zod'
import { capabilityJsonSchema } from '../../simulation/capabilities.ts'
import {
  isoTimestampSchema,
  operationalObjectSchema,
  procedureCatalogSchema,
  procedureControlStateSchema,
  procedureDocumentSchema,
  procedureIdSchema,
  procedureSourceIdSchema,
  recordingSampleSchema,
  recordingSeriesDescriptorSchema,
  scenarioGuidanceSchema,
  simulationClockStateSchema,
  simulationRunEventSchema,
  simulationRunIdSchema,
  type OperationalObject
} from '../model/index.ts'
import { scenarioAuthoringCatalogSchema } from '../scenarios/authoring.ts'
import { scenarioDefinitionSchema } from '../scenarios/definition.ts'
import { scenarioRevisionIdSchema } from '../scenarios/library.ts'
import { CommandIdempotencyConflictError } from '../simulation-runs/command-idempotency.ts'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../workspaces/runtime-registry.ts'
import { apiError,json,readJson } from './responses.ts'
import {
  actorIdForAccessContext,
  buildSimulationRunActor,
} from './simulation-run-routes.ts'

const WORLD_MODULE_ID = moduleIdSchema.parse('world')
const CONTEXT_OBJECT_LIMIT = 50

export const worldModuleManifest = workspaceModuleManifestSchema.parse({
  module: {
    id: WORLD_MODULE_ID,
    title: 'World',
    description: 'Shared scenarios, Simulation Runs, operational state, and simulation mechanics.',
  },
  endpoints: {
    workspace: '/internal/workspaces/{workspaceId}',
    definitions: '/internal/workspaces/{workspaceId}/definitions',
    resources: '/internal/workspaces/{workspaceId}/resources',
    capabilities: '/internal/workspaces/{workspaceId}/capabilities',
    invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke',
  },
  ui: {
    workspace: '/workspaces/{workspaceId}/world',
  },
})

const lifecycleInputSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
const emptyInputSchema = z.object({}).strict()
const readObjectInputSchema = z.object({
  objectId: z.string().trim().min(1).max(128),
}).strict()
const searchObjectsInputSchema = z.object({
  packId: z.string().trim().min(1).max(128).optional(),
  kind: z.string().trim().min(1).max(128).optional(),
  text: z.string().trim().max(256).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(50),
}).strict()
const readChangesInputSchema = z.object({
  afterSequence: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
}).strict()
const procedureCatalogInputSchema = z.object({
  sourceId: procedureSourceIdSchema.optional(),
  refresh: z.boolean().default(false),
}).strict()
const procedureDocumentInputSchema = z.object({
  sourceId: procedureSourceIdSchema.optional(),
  procedureId: procedureIdSchema,
  sourceRevision: sourceRevisionSchema.optional(),
  sourcePath: sourceDocumentPathSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.sourcePath !== undefined && input.sourceRevision === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'sourcePath requires sourceRevision',
    })
  }
})
const historyTimestampSchema = z.string().datetime({ offset: true })
const readHistoryInputSchema = z.object({
  runtimeId: z.string().trim().min(1).max(128).optional(),
  seriesId: z.string().trim().min(1).max(128).optional(),
  subjectId: z.string().trim().min(1).max(128).optional(),
  signalId: z.string().trim().min(1).max(512).optional(),
  from: historyTimestampSchema.optional(),
  to: historyTimestampSchema.optional(),
  limit: z.number().int().positive().max(10_000).optional(),
}).strict()
const createScenarioInputSchema = z.object({ source: scenarioDefinitionSchema }).strict()
const scenarioWriteInputJsonSchema = z.toJSONSchema(createScenarioInputSchema, { unrepresentable: 'any' })

import { scenarioPreviewSchema,scenarioWriteResultSchema } from '../scenarios/authoring-preview.ts'

const scenarioStartResultSchema = z.object({
  id: simulationRunIdSchema,
  uiPath: z.string().min(1),
}).strict()

const definitionDeleteResultSchema = z.object({
  deleted: z.literal(true),
  definitionId: z.string().min(1),
}).strict()

const simulationRunDeleteResultSchema = z.object({
  deleted: z.literal(true),
  simulationRunId: simulationRunIdSchema,
}).strict()

const simulationRunSummarySchema = z.object({
  id: simulationRunIdSchema,
  name: z.string().trim().min(1).max(256).nullable(),
  title: z.string().trim().min(1).max(256),
  scenarioId: z.string().min(1).nullable(),
  scenarioTitle: z.string().min(1).nullable(),
  scenarioRevisionId: z.string().min(1).nullable(),
  createdAt: isoTimestampSchema.nullable(),
  loaded: z.boolean(),
  snapshotSeq: z.number().int().nonnegative().nullable(),
  objectCount: z.number().int().nonnegative().nullable(),
  clock: simulationClockStateSchema.nullable(),
  activeCapabilityIds: z.array(z.string().min(1)),
  loadError: z.string().min(1).optional(),
}).strict()

const runtimeHealthSchema = z.object({
  runtimeId: z.string().min(1),
  state: z.enum(['ready', 'degraded', 'failed']),
  failureCount: z.number().int().nonnegative(),
  lastSuccessfulInteractionAt: isoTimestampSchema,
  lastFailure: z.object({
    at: isoTimestampSchema,
    operation: z.string().min(1),
    message: z.string().min(1),
  }).strict().optional(),
}).strict()

const availableSimulationCapabilitySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['command', 'query']),
  title: z.string().min(1),
  description: z.string().min(1),
  risk: z.enum(['read', 'write', 'destructive']),
  idempotent: z.boolean(),
  schedulable: z.boolean().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  packId: z.string().min(1),
  runtimeId: z.string().min(1),
}).strict()

const operationalObjectSummarySchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  packId: z.string().min(1),
  label: z.string().min(1),
  lifecycle: z.string().min(1),
  revision: z.number().int().nonnegative(),
  status: z.string().min(1),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  intent: z.string().min(1).optional(),
  updatedAt: isoTimestampSchema,
}).strict()

const objectSearchResultSchema = z.object({
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  objects: z.array(operationalObjectSummarySchema),
}).strict()

const simulationRunContextSchema = z.object({
  subject: z.object({
    workspaceId: workspaceIdSchema,
    simulationRunId: simulationRunIdSchema,
    scenarioId: z.string().min(1),
    scenarioRevisionId: z.string().min(1),
  }).strict(),
  briefing: z.object({
    title: z.string().min(1),
    summary: z.string().min(1).optional(),
    objectives: z.array(z.string().min(1)),
  }).strict(),
  situation: z.object({
    observedAt: isoTimestampSchema,
    sequence: z.number().int().nonnegative(),
    runtimeHealth: z.array(runtimeHealthSchema),
    clock: simulationClockStateSchema.optional(),
    guidance: scenarioGuidanceSchema.optional(),
    procedures: procedureControlStateSchema,
  }).strict(),
  objects: z.object({
    total: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    truncated: z.boolean(),
    byPack: z.record(z.string(), z.number().int().nonnegative()),
    byKind: z.record(z.string(), z.number().int().nonnegative()),
    items: z.array(operationalObjectSummarySchema),
  }).strict(),
  affordances: z.object({
    workspaceId: workspaceIdSchema.nullable(),
    simulationRunId: simulationRunIdSchema,
    scenarioId: z.string().min(1).nullable(),
    scenarioRevisionId: z.string().min(1).nullable(),
    activePackIds: z.array(z.string().min(1)),
    runtimes: z.array(z.object({
      id: z.string().min(1),
      packId: z.string().min(1),
      clock: z.enum(['simulation', 'live', 'none']),
    }).strict()),
    capabilities: z.array(availableSimulationCapabilitySchema),
    wikiRefs: z.array(z.object({
      label: z.string().min(1),
      path: z.string().min(1),
    }).passthrough()),
    recording: z.object({
      selections: z.array(z.record(z.string(), z.unknown())),
      profiles: z.array(z.record(z.string(), z.unknown())),
    }).strict(),
  }).strict(),
}).strict()

const simulationChangesSchema = z.object({
  afterSequence: z.number().int().nonnegative(),
  currentSequence: z.number().int().nonnegative(),
  events: z.array(simulationRunEventSchema),
  hasMore: z.boolean(),
  nextSequence: z.number().int().nonnegative(),
}).strict()

const simulationHistorySchema = z.object({
  status: z.object({
    seriesCount: z.number().int().nonnegative(),
    sampleCount: z.number().int().nonnegative(),
    firstObservedAt: isoTimestampSchema.nullable(),
    lastObservedAt: isoTimestampSchema.nullable(),
  }).strict().nullable(),
  series: z.array(recordingSeriesDescriptorSchema.extend({ runtimeId: z.string().min(1) }).strict()),
  samples: z.array(recordingSampleSchema.extend({ runtimeId: z.string().min(1) }).strict()),
}).strict()

const SCENARIO_DEFINITION_TYPE = 'world.scenario'

const definitionsFor = async (registry: SimulationRunRegistry) => {
  const scenarios = await registry.listScenarios()
  return moduleDefinitionCollectionSchema.parse({
    definitions: scenarios.map(scenario => ({
      ref: {
        workspaceId: registry.workspaceId,
        moduleId: WORLD_MODULE_ID,
        type: SCENARIO_DEFINITION_TYPE,
        id: scenario.id,
      },
      title: scenario.title,
      ...(scenario.description === undefined ? {} : { description: scenario.description }),
      uiPath: `/workspaces/${encodeURIComponent(registry.workspaceId)}/world/scenarios/new?definition=${encodeURIComponent(scenario.id)}&revision=${encodeURIComponent(scenario.currentRevisionId)}`,
      currentRevisionId: scenario.currentRevisionId,
      capabilityIds: worldCapabilities.idsForDefinitionType(SCENARIO_DEFINITION_TYPE),
      inspectionCapabilityId: 'world.scenario.inspect',
      primaryCapabilityId: 'world.scenario.start',
      deleteCapabilityId: 'world.scenario.delete',
    })),
  }).definitions
}

const resourcesFor = async (registry: SimulationRunRegistry): Promise<ReadonlyArray<ModuleResourceDescriptor>> => {
  const observedAt = new Date().toISOString()
  const simulationRuns = await registry.listKnown()
  return moduleResourceCollectionSchema.parse({
    resources: simulationRuns.map(simulationRun => {
      const viewers = registry.leaseSummary(simulationRun.id).leasesByKind.realtime
      const status = simulationRun.loadError !== undefined
        ? 'Unavailable'
        : simulationRun.clock?.paused
          ? 'Paused'
          : !simulationRun.loaded
            ? 'Ready'
            : simulationRun.clock?.speed !== undefined && simulationRun.clock.speed !== 1
              ? `Running · ${simulationRun.clock.speed}×`
              : 'Running'
      return {
        ref: {
          workspaceId: registry.workspaceId,
          moduleId: WORLD_MODULE_ID,
          type: 'world.simulation-run',
          id: simulationRun.id,
        },
        title: simulationRun.title,
        ...(simulationRun.loadError === undefined ? {} : { description: simulationRun.loadError }),
        ...(simulationRun.scenarioId === null || simulationRun.scenarioRevisionId === null ? {} : {
          sourceDefinition: {
            workspaceId: registry.workspaceId,
            moduleId: WORLD_MODULE_ID,
            type: SCENARIO_DEFINITION_TYPE,
            id: simulationRun.scenarioId,
            revisionId: simulationRun.scenarioRevisionId,
          },
        }),
        links: [],
        uiPath: `/workspaces/${encodeURIComponent(registry.workspaceId)}/world/runs/${encodeURIComponent(simulationRun.id)}`,
        capabilityIds: [
          ...worldCapabilities.idsForResourceType('world.simulation-run'),
          ...simulationRun.activeCapabilityIds,
        ],
        inspectionCapabilityId: 'world.simulation-run.inspect',
        deleteCapabilityId: 'world.simulation-run.delete',
        renameCapabilityId: 'world.simulation-run.rename',
        summary: [
          ...(simulationRun.createdAt === null ? [] : [{
            key: 'started-at',
            label: 'Started',
            kind: 'timestamp' as const,
            value: simulationRun.createdAt,
          }]),
          { key: 'status', label: 'Status', kind: 'status' as const, value: status },
          { key: 'viewer-count', label: 'Viewers', kind: 'count' as const, value: viewers },
          ...(simulationRun.objectCount === null ? [] : [{
            key: 'object-count',
            label: 'Objects',
            kind: 'count' as const,
            value: simulationRun.objectCount,
          }]),
        ],
        observedAt,
      }
    }),
  }).resources
}

const requireScenarioDefinitionId = (
  invocation: z.infer<typeof moduleCapabilityInvocationSchema>,
): string => {
  if (invocation.definition === undefined) throw new Error('Scenario Capability requires a Definition')
  if (invocation.definition.type !== SCENARIO_DEFINITION_TYPE) throw new Error('Capability requires a World Scenario Definition')
  return invocation.definition.id
}

const requireSimulationRunResource = (
  invocation: z.infer<typeof moduleCapabilityInvocationSchema>,
): ReturnType<typeof simulationRunIdSchema.parse> => {
  if (invocation.resource === undefined) throw new Error('Simulation Run Capability requires a Resource')
  if (invocation.resource.type !== 'world.simulation-run') throw new Error('Capability requires a World Simulation Run Resource')
  return simulationRunIdSchema.parse(invocation.resource.id)
}

const countBy = (values: ReadonlyArray<string>): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

const summarizeOperationalObject = (object: OperationalObject) => ({
  id: object.id,
  kind: object.kind,
  packId: object.packId,
  label: object.label,
  lifecycle: object.lifecycle,
  revision: object.revision,
  status: object.operational.status,
  ...(object.operational.priority === undefined ? {} : { priority: object.operational.priority }),
  ...(object.operational.intent === undefined ? {} : { intent: object.operational.intent }),
  updatedAt: object.timestamps.updatedAt,
})

const serializableInspection = (value: unknown) =>
  inspectionViewSchema.parse(JSON.parse(JSON.stringify(value)) as unknown)

const runtimeCapabilityDescriptorsFor = (
  registry: SimulationRunRegistry,
): ReadonlyArray<ModuleCapabilityDescriptor> => {
  const byId = new Map<string, ModuleCapabilityDescriptor>()
  for (const { capability } of registry.installedCapabilities) {
    const descriptor = moduleCapabilityCollectionSchema.parse({ capabilities: [{
      id: capability.id,
      moduleId: WORLD_MODULE_ID,
      kind: capability.kind,
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: capability.title,
      description: capability.description,
      risk: capability.risk,
      idempotent: capability.idempotent,
      ...(capability.schedulable === undefined ? {} : { schedulable: capability.schedulable }),
      inputSchema: capabilityJsonSchema(capability.input),
      outputSchema: capabilityJsonSchema(capability.output),
    }] }).capabilities[0]!
    const existing = byId.get(descriptor.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(descriptor)) {
      throw new Error(`alternative Pack Runtimes disagree on Capability ${descriptor.id}`)
    }
    byId.set(descriptor.id, descriptor)
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}

const scenarioSections = (definition: {
  readonly objectives?: ReadonlyArray<string>
  readonly packs: ReadonlyArray<string>
  readonly packRuntimes: Readonly<Record<string, unknown>>
  readonly packConfigs: Readonly<Record<string, unknown>>
  readonly connections: ReadonlyArray<unknown>
  readonly recording: ReadonlyArray<unknown>
  readonly world: unknown
  readonly initialObjects: ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly packId: string
    readonly label: string
    readonly lifecycle: string
    readonly operational: { readonly status: string }
  }>
  readonly view: unknown
  readonly timeline?: unknown
}) => [{
  id: 'scenario-setup',
  title: 'Scenario setup',
  data: {
    objectives: definition.objectives ?? [],
    world: definition.world,
    view: definition.view,
  },
}, {
  id: 'packs-and-runtimes',
  title: 'Packs and runtime configuration',
  data: {
    packs: definition.packs,
    packRuntimes: definition.packRuntimes,
    packConfigs: definition.packConfigs,
    recording: definition.recording,
    connections: definition.connections,
  },
}, {
  id: 'assets',
  title: 'Initial assets',
  description: 'Initial operational assets compiled from the Scenario Items above.',
  data: {
    summary: {
      operationalObjects: definition.initialObjects.length,
      byPack: countBy(definition.initialObjects.map(object => object.packId)),
      byKind: countBy(definition.initialObjects.map(object => object.kind)),
    },
    operationalObjects: definition.initialObjects,
  },
}, {
  id: 'timeline',
  title: 'Scenario timeline',
  description: 'Configured future cues are shown here for design inspection; agent-safe Simulation Context remains separate.',
  data: definition.timeline ?? { cues: [] },
}]

const worldCapabilities = createModuleCapabilityRegistry<SimulationRunRegistry, Response>(WORLD_MODULE_ID, [
  {
    descriptor: {
      id: 'world.scenario-authoring.describe',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'workspace' },
      title: 'Describe Scenario Authoring',
      description: 'Lists the discoverable World Packs and Scenario items each Pack exposes for authoring.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: z.toJSONSchema(scenarioAuthoringCatalogSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      return json({ result: registry.scenarioAuthoringCatalog })
    },
  },
  {
    descriptor: {
      id: 'world.scenario.create',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'workspace' },
      title: 'Create Scenario',
      description: 'Validates and saves a new editable Scenario Definition as an immutable revision.',
      risk: 'write',
      idempotent: false,
      inputSchema: scenarioWriteInputJsonSchema,
      outputSchema: capabilityJsonSchema(scenarioWriteResultSchema),
    },
    invoke: async (registry, invocation) => {
      const input = createScenarioInputSchema.parse(invocation.input)
      try {
        const revision = await registry.createScenario(input.source)
        return json({ result: {
          definition: {
            workspaceId: registry.workspaceId,
            moduleId: WORLD_MODULE_ID,
            type: SCENARIO_DEFINITION_TYPE,
            id: revision.definitionId,
            revisionId: revision.id,
          },
          title: revision.document.title,
        } }, { status: 201 })
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Definition already exists:')) {
          return apiError(409, 'scenario_already_exists', error.message)
        }
        throw error
      }
    },
  },
  {
    descriptor: {
      id: 'world.scenario.preview',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'workspace' },
      title: 'Preview Scenario',
      description: 'Validates an unsaved Scenario draft and returns its compiled asset and connection surface without creating a Definition.',
      risk: 'read',
      idempotent: true,
      inputSchema: scenarioWriteInputJsonSchema,
      outputSchema: capabilityJsonSchema(scenarioPreviewSchema),
    },
    invoke: async (registry, invocation) => {
      const input = createScenarioInputSchema.parse(invocation.input)
      const scenario = await registry.previewScenario(input.source)
      return json({ result: scenario })
    },
  },
  {
    descriptor: {
      id: 'world.scenario.update',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'definition', definitionType: SCENARIO_DEFINITION_TYPE },
      title: 'Update Scenario',
      description: 'Creates a new immutable revision from edited Scenario Definition content.',
      risk: 'write',
      idempotent: false,
      inputSchema: scenarioWriteInputJsonSchema,
      outputSchema: capabilityJsonSchema(scenarioWriteResultSchema),
    },
    invoke: async (registry, invocation) => {
      const input = createScenarioInputSchema.parse(invocation.input)
      const scenarioId = requireScenarioDefinitionId(invocation)
      if (input.source.id !== scenarioId) {
        return apiError(409, 'scenario_identity_mismatch', 'Edited Scenario id does not match the target Definition')
      }
      try {
        const revision = await registry.updateScenario(
          input.source,
          scenarioRevisionIdSchema.parse(invocation.definition!.revisionId),
        )
        return json({ result: {
          definition: { ...invocation.definition, revisionId: revision.id },
          title: revision.document.title,
        } })
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Definition Revision changed:')) {
          return apiError(409, 'scenario_revision_changed', error.message)
        }
        throw error
      }
    },
  },
  {
    descriptor: {
      id: 'world.scenario.inspect',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'definition', definitionType: SCENARIO_DEFINITION_TYPE },
      title: 'Inspect Scenario',
      description: 'Shows the exact Scenario Revision configuration, Packs, initial assets, Plants, and timeline.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: z.toJSONSchema(inspectionViewSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const scenarioId = requireScenarioDefinitionId(invocation)
      const revision = await registry.currentScenario(scenarioId)
      if (!revision || String(revision.id) !== String(invocation.definition!.revisionId)) {
        return apiError(404, 'scenario_revision_not_found', 'Scenario Revision not found')
      }
      const definition = await registry.compileScenarioRevision(revision)
      return json({ result: serializableInspection({
        target: { kind: 'definition', definition: invocation.definition },
        title: revision.document.title,
        ...(revision.document.description === undefined ? {} : { description: revision.document.description }),
        observedAt: new Date().toISOString(),
        sections: [{
          id: 'identity',
          title: 'Identity and provenance',
          data: {
            scenarioId: revision.definitionId,
            revisionId: revision.id,
            digest: revision.digest,
            createdAt: revision.createdAt,
          },
        }, {
          id: 'authored-definition',
          title: 'Editable Scenario Definition',
          description: 'The Pack-grouped authored source retained with this immutable revision.',
          data: revision.document,
        }, ...scenarioSections(definition)],
      }) })
    },
  },
  {
    descriptor: {
      id: 'world.scenario.start',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'definition', definitionType: SCENARIO_DEFINITION_TYPE },
      title: 'Start Scenario',
      description: 'Creates a Simulation Run from the requested immutable Scenario Revision.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: capabilityJsonSchema(scenarioStartResultSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      if (!invocation.definition) throw new Error('Scenario Capability requires a Definition')
      const runtime = await registry.create({
        scenarioId: requireScenarioDefinitionId(invocation),
        scenarioRevisionId: scenarioRevisionIdSchema.parse(invocation.definition.revisionId),
      })
      const resource = {
        workspaceId: registry.workspaceId,
        moduleId: WORLD_MODULE_ID,
        type: 'world.simulation-run',
        id: runtime.id,
      }
      return json({
        result: { id: runtime.id, uiPath: `/workspaces/${encodeURIComponent(registry.workspaceId)}/world/runs/${encodeURIComponent(runtime.id)}` },
        createdResources: [resource],
      }, { status: 201 })
    },
  },
  {
    descriptor: {
      id: 'world.scenario.delete',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'definition', definitionType: SCENARIO_DEFINITION_TYPE },
      title: 'Delete Scenario',
      description: 'Removes this Scenario from the Workspace catalog. Existing Simulation Runs retain their pinned revision.',
      risk: 'destructive',
      idempotent: false,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: capabilityJsonSchema(definitionDeleteResultSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const scenarioId = requireScenarioDefinitionId(invocation)
      return await registry.deleteScenario(scenarioId, scenarioRevisionIdSchema.parse(invocation.definition!.revisionId))
        ? json({ result: { deleted: true, definitionId: scenarioId } })
        : apiError(404, 'scenario_not_found', 'Scenario not found')
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.inspect',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Inspect Simulation Run',
      description: 'Shows pinned Scenario configuration, current runtime state, operational asset summaries, and available Capabilities.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: z.toJSONSchema(inspectionViewSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const simulationRunId = requireSimulationRunResource(invocation)
      const [runtime, revision, summary] = await Promise.all([
        registry.load(simulationRunId),
        registry.scenarioRevisionForRun(simulationRunId),
        registry.summary(simulationRunId),
      ])
      if (!revision) return apiError(409, 'scenario_revision_unavailable', 'Simulation Run has no readable Scenario Revision')
      const definition = await registry.compileScenarioRevision(revision)
      const snapshot = runtime.snapshot()
      const leaseSummary = registry.leaseSummary(simulationRunId)
      const assetSummaries = snapshot.objects.map(object => ({
        id: object.id,
        label: object.label,
        kind: object.kind,
        packId: object.packId,
        lifecycle: object.lifecycle,
        revision: object.revision,
        status: object.operational.status,
        ...(object.operational.priority === undefined ? {} : { priority: object.operational.priority }),
        ...(object.operational.intent === undefined ? {} : { intent: object.operational.intent }),
        alerts: object.alerts.length,
        updatedAt: object.timestamps.updatedAt,
      }))
      return json({ result: serializableInspection({
        target: { kind: 'resource', resource: invocation.resource },
        title: summary.title,
        ...(definition.description === undefined ? {} : { description: definition.description }),
        observedAt: new Date().toISOString(),
        sections: [{
          id: 'identity',
          title: 'Run identity and provenance',
          data: {
            ...summary,
            scenarioDigest: revision.digest,
            scenarioRevisionCreatedAt: revision.createdAt,
            connections: leaseSummary,
          },
        }, {
          id: 'live-state',
          title: 'Current simulation state',
          data: {
            sequence: snapshot.seq,
            clock: snapshot.clock ?? null,
            scenario: snapshot.scenario ?? null,
            runtimeHealth: runtime.health(),
          },
        }, {
          id: 'live-assets',
          title: 'Current asset summaries',
          description: 'Compact live summaries; detailed object state remains available through Read Operational Object.',
          data: {
            total: assetSummaries.length,
            byPack: countBy(assetSummaries.map(object => String(object.packId))),
            byKind: countBy(assetSummaries.map(object => String(object.kind))),
            objects: assetSummaries,
          },
        }, {
          id: 'available-capabilities',
          title: 'Simulation Capabilities',
          data: runtime.capabilities(),
        }, ...scenarioSections(definition)],
      }) })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.rename',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Rename Simulation Run',
      description: 'Sets an independent Run display name. Null restores the pinned Scenario title. Does not modify simulation state or its source Scenario.',
      risk: 'write',
      idempotent: false,
      inputSchema: capabilityJsonSchema(resourceRenameInputSchema),
      outputSchema: capabilityJsonSchema(simulationRunSummarySchema),
    },
    invoke: async (registry, invocation) => {
      const input = resourceRenameInputSchema.parse(invocation.input)
      const summary = await registry.rename(requireSimulationRunResource(invocation), input.name, input.expectedTitle)
      return json({ result: summary })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.delete',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Delete Simulation Run',
      description: 'Permanently deletes a Simulation Run and its persisted state when no viewers are connected.',
      risk: 'destructive',
      idempotent: false,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: capabilityJsonSchema(simulationRunDeleteResultSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const simulationRunId = requireSimulationRunResource(invocation)
      if (registry.leaseSummary(simulationRunId).leasesByKind.realtime > 0) {
        return apiError(409, 'simulation_run_has_viewers', 'Simulation Run has connected viewers')
      }
      return await registry.delete(simulationRunId)
        ? json({ result: { deleted: true, simulationRunId } })
        : apiError(404, 'simulation_run_not_found', 'Simulation Run not found')
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.read',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read Simulation Run',
      description: 'Reads the current summary of a selected Simulation Run.',
      risk: 'read',
      idempotent: true,
      inputSchema: capabilityJsonSchema(emptyInputSchema),
      outputSchema: capabilityJsonSchema(simulationRunSummarySchema),
    },
    invoke: async (registry, invocation) => {
      const simulationRunId = requireSimulationRunResource(invocation)
      const summary = (await registry.listKnown()).find(candidate => candidate.id === simulationRunId)
      return summary
        ? json({ result: summary })
        : apiError(404, 'simulation_run_not_found', 'Simulation Run not found')
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.context',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read Simulation Context',
      description: 'Returns an agent-safe briefing, current situation, operational-object summaries, and available Capabilities without exposing private Scenario Timeline content.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: capabilityJsonSchema(simulationRunContextSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const simulationRunId = requireSimulationRunResource(invocation)
      const runtime = await registry.load(simulationRunId)
      const [revision, summary] = await Promise.all([registry.scenarioRevisionForRun(simulationRunId), registry.summary(simulationRunId)])
      if (!revision) return apiError(409, 'scenario_revision_unavailable', 'Simulation Run has no readable Scenario Revision')
      const definition = await registry.compileScenarioRevision(revision)
      const snapshot = runtime.snapshot()
      const objectSummaries = snapshot.objects
        .map(summarizeOperationalObject)
        .sort((left, right) => left.id.localeCompare(right.id))
      const contextObjects = objectSummaries.slice(0, CONTEXT_OBJECT_LIMIT)
      return json({ result: {
        subject: {
          workspaceId: registry.workspaceId,
          simulationRunId,
          scenarioId: revision.definitionId,
          scenarioRevisionId: revision.id,
        },
        briefing: {
          title: summary.title,
          ...(definition.description === undefined ? {} : { summary: definition.description }),
          objectives: definition.objectives ?? [],
        },
        situation: {
          observedAt: new Date().toISOString(),
          sequence: snapshot.seq,
          runtimeHealth: runtime.health(),
          ...(snapshot.clock === undefined ? {} : { clock: snapshot.clock }),
          ...(snapshot.scenario?.guidance === undefined ? {} : { guidance: snapshot.scenario.guidance }),
          procedures: snapshot.procedures ?? { runs: [] },
        },
        objects: {
          total: objectSummaries.length,
          returned: contextObjects.length,
          truncated: contextObjects.length < objectSummaries.length,
          byPack: countBy(snapshot.objects.map(object => object.packId)),
          byKind: countBy(snapshot.objects.map(object => object.kind)),
          items: contextObjects,
        },
        affordances: runtime.capabilities(),
      } })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.objects.search',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Search Operational Objects',
      description: 'Searches current operational-object summaries by Pack, kind, or text with bounded pagination.',
      risk: 'read',
      idempotent: true,
      inputSchema: capabilityJsonSchema(searchObjectsInputSchema),
      outputSchema: capabilityJsonSchema(objectSearchResultSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = searchObjectsInputSchema.parse(invocation.input)
      const needle = input.text?.toLocaleLowerCase()
      const objects = runtime.snapshot().objects
        .filter(object => input.packId === undefined || object.packId === input.packId)
        .filter(object => input.kind === undefined || object.kind === input.kind)
        .filter(object => needle === undefined || [object.id, object.label, object.operational.status]
          .some(value => value.toLocaleLowerCase().includes(needle)))
        .map(summarizeOperationalObject)
        .sort((left, right) => left.id.localeCompare(right.id))
      return json({ result: {
        total: objects.length,
        offset: input.offset,
        limit: input.limit,
        objects: objects.slice(input.offset, input.offset + input.limit),
      } })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.read-object',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read Operational Object',
      description: 'Reads current canonical projected state for one operational object discovered through context or object search.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(readObjectInputSchema),
      outputSchema: capabilityJsonSchema(operationalObjectSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = readObjectInputSchema.parse(invocation.input)
      const object = runtime.snapshot().objects.find(candidate => candidate.id === input.objectId)
      return object
        ? json({ result: object })
        : apiError(404, 'operational_object_not_found', 'Operational Object not found')
    },
  },
  {
    descriptor: {
      id: 'world.procedure.catalog.list',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'List procedure catalog',
      description: 'Lists the procedure documents available to this Simulation Run from its configured sources.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(procedureCatalogInputSchema),
      outputSchema: capabilityJsonSchema(procedureCatalogSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = procedureCatalogInputSchema.parse(invocation.input)
      return json({ result: await runtime.procedureCatalog({
        refresh: input.refresh,
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      }) })
    },
  },
  {
    descriptor: {
      id: 'world.procedure.document.read',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read procedure document',
      description: 'Reads procedure steps, branches and signal tags. For an existing Run, pass its sourceId, sourceRevision and sourcePath from world.procedure.runs.list; the current catalog may describe a newer revision.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(procedureDocumentInputSchema),
      outputSchema: capabilityJsonSchema(procedureDocumentSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = procedureDocumentInputSchema.parse(invocation.input)
      return json({ result: await runtime.procedureDocument({
        procedureId: input.procedureId,
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
        ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision }),
        ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
      }) })
    },
  },
  {
    descriptor: {
      id: 'world.procedure.runs.list',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'List procedure runs',
      description: 'Lists current procedure execution state in this Simulation Run.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: capabilityJsonSchema(procedureControlStateSchema),
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      return json({ result: runtime.snapshot().procedures ?? { runs: [] } })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.changes',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read Simulation Changes',
      description: 'Reads a bounded page of committed changes after a known simulation sequence so an Agent can stay current without re-reading the whole World.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(readChangesInputSchema),
      outputSchema: capabilityJsonSchema(simulationChangesSchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = readChangesInputSchema.parse(invocation.input)
      const available = runtime.events({ afterSeq: input.afterSequence })
      const events = available.slice(0, input.limit)
      const currentSequence = runtime.snapshot().seq
      return json({ result: {
        afterSequence: input.afterSequence,
        currentSequence,
        events,
        hasMore: available.length > events.length,
        nextSequence: events.at(-1)?.seq ?? input.afterSequence,
      } })
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.history',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Read Simulation History',
      description: 'Discovers recorded series and reads bounded historical samples selected by Scenario Recording Profiles.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(readHistoryInputSchema),
      outputSchema: capabilityJsonSchema(simulationHistorySchema),
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = readHistoryInputSchema.parse(invocation.input)
      const query = {
        ...(input.runtimeId === undefined ? {} : { runtimeId: input.runtimeId }),
        ...(input.seriesId === undefined ? {} : { seriesId: input.seriesId }),
        ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
        ...(input.signalId === undefined ? {} : { signalId: input.signalId }),
        ...(input.from === undefined ? {} : { from: new Date(input.from).toISOString() }),
        ...(input.to === undefined ? {} : { to: new Date(input.to).toISOString() }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }
      return json({ result: {
        status: runtime.recordingStatus(),
        series: runtime.recordingSeries(),
        samples: runtime.recordedSamples(query),
      } })
    },
  },
])

const invokeCapability = async (
  registry: SimulationRunRegistry,
  capabilityId: string,
  rawInvocation: unknown,
): Promise<Response> => {
  const invocation = moduleCapabilityInvocationSchema.parse(rawInvocation)
  if (invocation.workspaceId !== registry.workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Invocation belongs to another Workspace')
  if (invocation.capabilityId !== capabilityId) return apiError(409, 'capability_scope_mismatch', 'Invocation Capability does not match the route')

  const response = await worldCapabilities.invoke(capabilityId, registry, invocation)
  if (response) return response

  const descriptor = runtimeCapabilityDescriptorsFor(registry).find(candidate => candidate.id === capabilityId)
  if (!descriptor) return apiError(404, 'capability_not_found', 'Capability not found')
  const simulationRunId = requireSimulationRunResource(invocation)
  const runtime = await registry.load(simulationRunId)
  if (!runtime.capabilities().capabilities.some(candidate => candidate.id === capabilityId)) {
    return apiError(409, 'capability_not_active', `Capability is not active in this Simulation Run: ${capabilityId}`)
  }
  const actor = buildSimulationRunActor(actorIdForAccessContext(invocation.access))
  const outcome = await runtime.invokeCapability(actor, {
    capabilityId,
    input: invocation.input,
    ...(invocation.expectedRevision === undefined ? {} : { expectedRevision: invocation.expectedRevision }),
    ...(invocation.idempotencyKey === undefined ? {} : { idempotencyKey: invocation.idempotencyKey }),
  })
  if (outcome.kind === 'command' && !outcome.result.ok) {
    return apiError(409, 'simulation_command_rejected', outcome.result.reason)
  }
  return json({
    result: outcome.result,
  })
}

export const handleWorldModuleApi = async (
  request: Request,
  url: URL,
  workspaces: WorldWorkspaceRuntimeRegistry,
): Promise<Response | null> => {
  try {
    if (url.pathname === '/.well-known/workspace-module' && request.method === 'GET') {
      return json(worldModuleManifest)
    }

    const workspaceMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)$/)
    if (workspaceMatch) {
      const workspaceId = workspaceIdSchema.parse(decodeURIComponent(workspaceMatch[1] ?? ''))
      if (request.method === 'PUT') {
        const input = lifecycleInputSchema.parse(await readJson(request))
        if (input.workspaceId !== workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Lifecycle body and route disagree')
        const provisioned = await workspaces.provision(workspaceId)
        return json({ workspaceId, moduleId: WORLD_MODULE_ID }, { status: provisioned.created ? 201 : 200 })
      }
      if (request.method === 'DELETE') {
        await workspaces.remove(workspaceId)
        return new Response(null, { status: 204 })
      }
    }

    const resourcesMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)\/resources$/)
    if (resourcesMatch && request.method === 'GET') {
      const workspaceId = workspaceIdSchema.parse(decodeURIComponent(resourcesMatch[1] ?? ''))
      const runtime = await workspaces.getOrLoad(workspaceId)
      return json(moduleResourceCollectionSchema.parse({ resources: await resourcesFor(runtime.simulationRuns) }))
    }

    const definitionsMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)\/definitions$/)
    if (definitionsMatch && request.method === 'GET') {
      const workspaceId = workspaceIdSchema.parse(decodeURIComponent(definitionsMatch[1] ?? ''))
      const runtime = await workspaces.getOrLoad(workspaceId)
      return json(moduleDefinitionCollectionSchema.parse({ definitions: await definitionsFor(runtime.simulationRuns) }))
    }

    const capabilitiesMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)\/capabilities$/)
    if (capabilitiesMatch && request.method === 'GET') {
      const workspaceId = workspaceIdSchema.parse(decodeURIComponent(capabilitiesMatch[1] ?? ''))
      const runtime = await workspaces.getOrLoad(workspaceId)
      return json(moduleCapabilityCollectionSchema.parse({
        capabilities: [...worldCapabilities.descriptors, ...runtimeCapabilityDescriptorsFor(runtime.simulationRuns)],
      }))
    }

    const invocationMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)\/capabilities\/([^/]+)\/invoke$/)
    if (invocationMatch && request.method === 'POST') {
      const workspaceId = workspaceIdSchema.parse(decodeURIComponent(invocationMatch[1] ?? ''))
      const capabilityId = decodeURIComponent(invocationMatch[2] ?? '')
      const runtime = await workspaces.getOrLoad(workspaceId)
      return await invokeCapability(runtime.simulationRuns, capabilityId, await readJson(request))
    }

    return null
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'simulation_run_name_changed') {
      return apiError(409, 'simulation_run_name_changed', error.message)
    }
    if (error instanceof SyntaxError) return apiError(400, 'invalid_json', error.message)
    if (error instanceof z.ZodError) return apiError(400, 'invalid_request', error.message)
    if (error instanceof CommandIdempotencyConflictError) return apiError(error.status, error.code, error.message)
    if (error instanceof Error && error.message.startsWith('World Module not provisioned:')) {
      return apiError(404, 'workspace_not_found', 'World is not enabled in this Workspace')
    }
    if (error instanceof Error && error.message.startsWith('Simulation Run not found:')) {
      return apiError(404, 'simulation_run_not_found', 'Simulation Run not found')
    }
    throw error
  }
}
