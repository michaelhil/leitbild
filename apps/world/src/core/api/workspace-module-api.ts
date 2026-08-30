import { z } from 'zod'
import {
  moduleCapabilityCollectionSchema,
  moduleCapabilityInvocationSchema,
  moduleDefinitionCollectionSchema,
  moduleIdSchema,
  moduleResourceCollectionSchema,
  workspaceIdSchema,
  workspaceModuleManifestSchema,
  type ModuleResourceDescriptor,
  type WorkspaceId,
} from '@leitbild/contracts'
import { createModuleCapabilityRegistry } from '@leitbild/module-runtime'
import { simulationRunIdSchema } from '../model/index.ts'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import { scenarioRevisionIdSchema } from '../scenarios/library.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../workspaces/runtime-registry.ts'
import {
  commandIdempotencyConfigFromEnv,
  commandIdempotencyStoreForRuntime,
  issueCommandWithIdempotency,
} from './command-idempotency.ts'
import {
  actorIdForAccessContext,
  buildSimulationRunActor,
  buildSimulationRunCommand,
} from './simulation-run-routes.ts'
import { apiError, json, readJson } from './responses.ts'

const WORLD_MODULE_ID = moduleIdSchema.parse('world')

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
const issueCommandInputSchema = z.object({
  command: z.object({
    kind: z.string().trim().min(1).max(256),
    targetObjectIds: z.array(z.string().min(1)).default([]),
    payload: z.unknown(),
  }).strict(),
}).strict()
const queryPackInputSchema = z.object({
  packId: z.string().trim().min(1).max(128),
  kind: z.string().trim().min(1).max(256),
  payload: z.unknown(),
}).strict()
const readObjectInputSchema = z.object({
  objectId: z.string().trim().min(1).max(128),
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
      currentRevisionId: scenario.currentRevisionId,
      capabilityIds: worldCapabilities.idsForDefinitionType(SCENARIO_DEFINITION_TYPE),
    })),
  }).definitions
}

const resourcesFor = async (registry: SimulationRunRegistry): Promise<ReadonlyArray<ModuleResourceDescriptor>> => {
  const observedAt = new Date().toISOString()
  const simulationRuns = await registry.listKnown()
  return moduleResourceCollectionSchema.parse({
    resources: simulationRuns.map(simulationRun => ({
        ref: {
          workspaceId: registry.workspaceId,
          moduleId: WORLD_MODULE_ID,
          type: 'world.simulation-run',
          id: simulationRun.id,
        },
        title: simulationRun.scenarioId === null
          ? simulationRun.id
          : `${simulationRun.scenarioId} — ${simulationRun.id}`,
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
        capabilityIds: worldCapabilities.idsForResourceType('world.simulation-run'),
        observedAt,
      })),
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

const worldCapabilities = createModuleCapabilityRegistry<SimulationRunRegistry, Response>(WORLD_MODULE_ID, [
  {
    descriptor: {
      id: 'world.scenario.start',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'definition', definitionType: SCENARIO_DEFINITION_TYPE },
      title: 'Start Scenario',
      description: 'Creates a Simulation Run from the current immutable revision of this Scenario.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: { type: 'object' },
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
      outputSchema: { type: 'object' },
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
      id: 'world.simulation-run.capabilities',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Describe Simulation Run Capabilities',
      description: 'Lists the active Packs and the exact command and query kinds accepted by this Simulation Run.',
      risk: 'read',
      idempotent: true,
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object' },
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      return json({ result: runtime.capabilities() })
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
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object' },
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
      description: 'Returns an agent-safe briefing, current situation, operational-object summaries, and available lower-level operations without exposing private Scenario Timeline content.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async (registry, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const simulationRunId = requireSimulationRunResource(invocation)
      const runtime = await registry.load(simulationRunId)
      const [revision] = await Promise.all([registry.scenarioRevisionForRun(simulationRunId)])
      if (!revision) return apiError(409, 'scenario_revision_unavailable', 'Simulation Run has no readable Scenario Revision')
      const snapshot = runtime.snapshot()
      return json({ result: {
        subject: {
          workspaceId: registry.workspaceId,
          simulationRunId,
          scenarioId: revision.scenarioId,
          scenarioRevisionId: revision.id,
        },
        briefing: {
          title: revision.definition.title,
          ...(revision.definition.description === undefined ? {} : { summary: revision.definition.description }),
          objectives: revision.definition.objectives ?? [],
        },
        situation: {
          observedAt: new Date().toISOString(),
          sequence: snapshot.seq,
          ...(snapshot.clock === undefined ? {} : { clock: snapshot.clock }),
          ...(snapshot.scenario?.guidance === undefined ? {} : { guidance: snapshot.scenario.guidance }),
        },
        operationalObjects: snapshot.objects.map(object => ({
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
        })),
        affordances: runtime.capabilities(),
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
      description: 'Reads current canonical projected state for one operational object discovered through Simulation Context.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(readObjectInputSchema),
      outputSchema: { type: 'object' },
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
      id: 'world.simulation-run.issue-command',
      moduleId: WORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Issue Simulation Command',
      description: 'Issues a validated domain command to a selected Simulation Run.',
      risk: 'write',
      idempotent: true,
      inputSchema: z.toJSONSchema(issueCommandInputSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async (registry, invocation) => {
      const simulationRunId = requireSimulationRunResource(invocation)
      const runtime = await registry.load(simulationRunId)
      const input = issueCommandInputSchema.parse(invocation.input)
      const command = buildSimulationRunCommand(
        simulationRunId,
        input.command,
        actorIdForAccessContext(invocation.access),
      )
      const actor = buildSimulationRunActor(command.actorId)
      const issued = await issueCommandWithIdempotency({
        store: commandIdempotencyStoreForRuntime(registry.workspaceId, simulationRunId),
        idempotency: commandIdempotencyConfigFromEnv(),
        actor,
        command,
        issue: runtime.issueCommand,
      })
      return issued.ok
        ? json({ result: issued.result })
        : apiError(issued.status, issued.code, issued.message)
    },
  },
  {
    descriptor: {
      id: 'world.simulation-run.query-pack',
      moduleId: WORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Query Simulation Pack',
      description: 'Runs a supported read-only Pack query against the selected Simulation Run.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(queryPackInputSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async (registry, invocation) => {
      const runtime = await registry.load(requireSimulationRunResource(invocation))
      const input = queryPackInputSchema.parse(invocation.input)
      const result = await runtime.queryPack(input)
      return result.ok
        ? json({ result })
        : apiError(400, 'pack_query_failed', result.reason)
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
  return response ?? apiError(404, 'capability_not_found', 'Capability not found')
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
      await workspaces.getOrLoad(workspaceId)
      return json(moduleCapabilityCollectionSchema.parse({ capabilities: worldCapabilities.descriptors }))
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
    if (error instanceof SyntaxError) return apiError(400, 'invalid_json', error.message)
    if (error instanceof z.ZodError) return apiError(400, 'invalid_request', error.message)
    if (error instanceof Error && error.message.startsWith('World Module not provisioned:')) {
      return apiError(404, 'workspace_not_found', 'World is not enabled in this Workspace')
    }
    if (error instanceof Error && error.message.startsWith('Simulation Run not found:')) {
      return apiError(404, 'simulation_run_not_found', 'Simulation Run not found')
    }
    throw error
  }
}
