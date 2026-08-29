import { z } from 'zod'
import {
  moduleCapabilityCollectionSchema,
  moduleCapabilityInvocationSchema,
  moduleResourceCollectionSchema,
  workspaceIdSchema,
  workspaceModuleManifestSchema,
  type ModuleCapabilityDescriptor,
  type ModuleResourceDescriptor,
  type WorkspaceId,
} from '@samsinn-leitbild/platform-contracts'
import { simulationRunIdSchema } from '../model/index.ts'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import type { MicroworldWorkspaceRuntimeRegistry } from '../workspaces/runtime-registry.ts'
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

const MICROWORLD_MODULE_ID = 'microworld' as const

export const microworldModuleManifest = workspaceModuleManifestSchema.parse({
  module: {
    id: MICROWORLD_MODULE_ID,
    title: 'Microworld',
    description: 'Shared scenarios, Simulation Runs, operational state, and simulation mechanics.',
  },
  endpoints: {
    workspace: '/internal/workspaces/{workspaceId}',
    resources: '/internal/workspaces/{workspaceId}/resources',
    capabilities: '/internal/workspaces/{workspaceId}/capabilities',
    invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke',
  },
  ui: {
    workspace: '/workspaces/{workspaceId}',
  },
})

const capabilities: ReadonlyArray<ModuleCapabilityDescriptor> = moduleCapabilityCollectionSchema.parse({
  capabilities: [
    {
      id: 'microworld.simulation-run.create',
      moduleId: MICROWORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'workspace' },
      title: 'Create Simulation Run',
      description: 'Creates a Simulation Run from a selected Workspace Scenario.',
      risk: 'write',
      idempotent: false,
      inputSchema: {
        type: 'object',
        properties: { scenarioId: { type: 'string' } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
    },
    {
      id: 'microworld.simulation-run.read',
      moduleId: MICROWORLD_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'microworld.simulation-run' },
      title: 'Read Simulation Run',
      description: 'Reads the current summary of a selected Simulation Run.',
      risk: 'read',
      idempotent: true,
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object' },
    },
    {
      id: 'microworld.simulation-run.issue-command',
      moduleId: MICROWORLD_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'microworld.simulation-run' },
      title: 'Issue Simulation Command',
      description: 'Issues a validated domain command to a selected Simulation Run.',
      risk: 'write',
      idempotent: true,
      inputSchema: {
        type: 'object',
        required: ['command'],
        properties: { command: { type: 'object' } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
    },
  ],
}).capabilities

const lifecycleInputSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
const createRunInputSchema = z.object({ scenarioId: z.string().min(1).max(128).optional() }).strict()
const issueCommandInputSchema = z.object({ command: z.unknown() }).strict()

const resourcesFor = async (registry: SimulationRunRegistry): Promise<ReadonlyArray<ModuleResourceDescriptor>> => {
  const observedAt = new Date().toISOString()
  const [scenarios, simulationRuns] = await Promise.all([registry.listScenarios(), registry.listKnown()])
  return moduleResourceCollectionSchema.parse({
    resources: [
      ...scenarios.map(scenario => ({
        ref: {
          workspaceId: registry.workspaceId,
          moduleId: MICROWORLD_MODULE_ID,
          type: 'microworld.scenario',
          id: scenario.id,
        },
        title: scenario.title,
        ...(scenario.description === undefined ? {} : { description: scenario.description }),
        capabilityIds: [],
        observedAt,
      })),
      ...simulationRuns.map(simulationRun => ({
        ref: {
          workspaceId: registry.workspaceId,
          moduleId: MICROWORLD_MODULE_ID,
          type: 'microworld.simulation-run',
          id: simulationRun.id,
        },
        title: simulationRun.scenarioId === null
          ? simulationRun.id
          : `${simulationRun.scenarioId} — ${simulationRun.id}`,
        ...(simulationRun.loadError === undefined ? {} : { description: simulationRun.loadError }),
        capabilityIds: [
          'microworld.simulation-run.read',
          'microworld.simulation-run.issue-command',
        ],
        observedAt,
      })),
    ],
  }).resources
}

const requireSimulationRunResource = (
  invocation: z.infer<typeof moduleCapabilityInvocationSchema>,
): ReturnType<typeof simulationRunIdSchema.parse> => {
  if (invocation.resource === undefined) throw new Error('Simulation Run Capability requires a Resource')
  if (invocation.resource.type !== 'microworld.simulation-run') throw new Error('Capability requires a Microworld Simulation Run Resource')
  return simulationRunIdSchema.parse(invocation.resource.id)
}

const invokeCapability = async (
  registry: SimulationRunRegistry,
  capabilityId: string,
  rawInvocation: unknown,
): Promise<Response> => {
  const invocation = moduleCapabilityInvocationSchema.parse(rawInvocation)
  if (invocation.workspaceId !== registry.workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Invocation belongs to another Workspace')
  if (invocation.capabilityId !== capabilityId) return apiError(409, 'capability_scope_mismatch', 'Invocation Capability does not match the route')

  if (capabilityId === 'microworld.simulation-run.create') {
    const input = createRunInputSchema.parse(invocation.input)
    const runtime = await registry.create(input.scenarioId === undefined ? {} : { scenarioId: input.scenarioId })
    return json({ result: { id: runtime.id, capabilities: runtime.capabilities(), snapshot: runtime.snapshot() } }, { status: 201 })
  }

  if (capabilityId === 'microworld.simulation-run.read') {
    const simulationRunId = requireSimulationRunResource(invocation)
    const summary = (await registry.listKnown()).find(candidate => candidate.id === simulationRunId)
    return summary
      ? json({ result: summary })
      : apiError(404, 'simulation_run_not_found', 'Simulation Run not found')
  }

  if (capabilityId === 'microworld.simulation-run.issue-command') {
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
  }

  return apiError(404, 'capability_not_found', 'Capability not found')
}

export const handleMicroworldModuleApi = async (
  request: Request,
  url: URL,
  workspaces: MicroworldWorkspaceRuntimeRegistry,
): Promise<Response | null> => {
  try {
    if (url.pathname === '/.well-known/workspace-module' && request.method === 'GET') {
      return json(microworldModuleManifest)
    }

    const workspaceMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)$/)
    if (workspaceMatch) {
      const workspaceId = workspaceIdSchema.parse(decodeURIComponent(workspaceMatch[1] ?? ''))
      if (request.method === 'PUT') {
        const input = lifecycleInputSchema.parse(await readJson(request))
        if (input.workspaceId !== workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Lifecycle body and route disagree')
        const provisioned = await workspaces.provision(workspaceId)
        return json({ workspaceId, moduleId: MICROWORLD_MODULE_ID }, { status: provisioned.created ? 201 : 200 })
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

    const capabilitiesMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)\/capabilities$/)
    if (capabilitiesMatch && request.method === 'GET') {
      const workspaceId = workspaceIdSchema.parse(decodeURIComponent(capabilitiesMatch[1] ?? ''))
      await workspaces.getOrLoad(workspaceId)
      return json(moduleCapabilityCollectionSchema.parse({ capabilities }))
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
    if (error instanceof Error && error.message.startsWith('Microworld Module not provisioned:')) {
      return apiError(404, 'workspace_not_found', 'Microworld is not enabled in this Workspace')
    }
    if (error instanceof Error && error.message.startsWith('Simulation Run not found:')) {
      return apiError(404, 'simulation_run_not_found', 'Simulation Run not found')
    }
    throw error
  }
}
