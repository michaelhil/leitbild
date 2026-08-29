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
import type { WorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import {
  samsinnModuleIdSchema,
  type SamsinnModuleId,
  type SamsinnModuleState,
} from '../core/workspaces/module-state.ts'
import { asAIAgent } from '../agents/shared.ts'

const manifestFor = (moduleId: SamsinnModuleId) => workspaceModuleManifestSchema.parse({
  module: moduleId === 'collaboration'
    ? {
        id: moduleId,
        title: 'Collaboration',
        description: 'Rooms, messages, membership, shared documents, and coordination behavior.',
      }
    : {
        id: moduleId,
        title: 'Agents',
        description: 'AI Agent profiles, model execution, tools, context, and evaluations.',
      },
  endpoints: {
    workspace: `/internal/${moduleId}/workspaces/{workspaceId}`,
    resources: `/internal/${moduleId}/workspaces/{workspaceId}/resources`,
    capabilities: `/internal/${moduleId}/workspaces/{workspaceId}/capabilities`,
    invoke: `/internal/${moduleId}/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke`,
  },
})

export const collaborationModuleManifest = manifestFor('collaboration')
export const agentsModuleManifest = manifestFor('agents')

const collaborationCapabilities: ReadonlyArray<ModuleCapabilityDescriptor> = moduleCapabilityCollectionSchema.parse({
  capabilities: [
    {
      id: 'collaboration.room.create',
      moduleId: 'collaboration',
      kind: 'command',
      scope: { kind: 'workspace' },
      title: 'Create Room',
      description: 'Creates a durable collaboration Room in the Workspace.',
      risk: 'write',
      idempotent: false,
      inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, roomPrompt: { type: 'string' } }, additionalProperties: false },
      outputSchema: { type: 'object' },
    },
    {
      id: 'collaboration.room.read',
      moduleId: 'collaboration',
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'collaboration.room' },
      title: 'Read Room',
      description: 'Reads the selected Room profile, state, and recent messages.',
      risk: 'read',
      idempotent: true,
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object' },
    },
    {
      id: 'collaboration.room.post-message',
      moduleId: 'collaboration',
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'collaboration.room' },
      title: 'Post Room Message',
      description: 'Posts an attributed message to the selected collaboration Room.',
      risk: 'write',
      idempotent: false,
      inputSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } }, additionalProperties: false },
      outputSchema: { type: 'object' },
    },
  ],
}).capabilities

const agentsCapabilities: ReadonlyArray<ModuleCapabilityDescriptor> = moduleCapabilityCollectionSchema.parse({
  capabilities: [
    {
      id: 'agents.agent.create',
      moduleId: 'agents',
      kind: 'command',
      scope: { kind: 'workspace' },
      title: 'Create Agent',
      description: 'Creates an AI Agent Profile in the Workspace.',
      risk: 'write',
      idempotent: false,
      inputSchema: { type: 'object', required: ['name', 'model', 'persona'], properties: { name: { type: 'string' }, model: { type: 'string' }, persona: { type: 'string' } }, additionalProperties: false },
      outputSchema: { type: 'object' },
    },
    {
      id: 'agents.agent.read',
      moduleId: 'agents',
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'agents.agent' },
      title: 'Read Agent',
      description: 'Reads the selected AI Agent Profile.',
      risk: 'read',
      idempotent: true,
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object' },
    },
  ],
}).capabilities

const lifecycleSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
const createRoomSchema = z.object({ name: z.string().trim().min(1).max(128), roomPrompt: z.string().max(16_384).optional() }).strict()
const postMessageSchema = z.object({ content: z.string().min(1).max(1_000_000) }).strict()
const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
  persona: z.string().max(64_000),
}).strict()

const json = (body: unknown, status = 200): Response => Response.json(body, { status })
const apiError = (status: number, code: string, message: string): Response =>
  json({ error: { code, message } }, status)

const readJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json()
  } catch (error) {
    throw new SyntaxError('Request body must be valid JSON', { cause: error })
  }
}

const requireModule = async (
  state: SamsinnModuleState,
  workspaceId: WorkspaceId,
  moduleId: SamsinnModuleId,
): Promise<void> => {
  if (!await state.has(workspaceId, moduleId)) throw new Error(`${moduleId} Workspace not found: ${workspaceId}`)
}

const resourcesFor = async (
  moduleId: SamsinnModuleId,
  workspaceId: WorkspaceId,
  registry: WorkspaceRuntimeRegistry,
): Promise<ReadonlyArray<ModuleResourceDescriptor>> => {
  const runtime = await registry.getOrLoad(workspaceId)
  const observedAt = new Date().toISOString()
  if (moduleId === 'collaboration') {
    return moduleResourceCollectionSchema.parse({ resources: runtime.rooms.listAllRooms().map(room => ({
      ref: { workspaceId, moduleId, type: 'collaboration.room', id: room.id },
      title: room.name,
      ...(room.roomPrompt === undefined ? {} : { description: room.roomPrompt }),
      capabilityIds: ['collaboration.room.read', 'collaboration.room.post-message'],
      observedAt,
    })) }).resources
  }
  return moduleResourceCollectionSchema.parse({ resources: runtime.team.listByKind('ai').map(agent => ({
    ref: { workspaceId, moduleId, type: 'agents.agent', id: agent.id },
    title: agent.name,
    ...(agent.getDescription?.() ? { description: agent.getDescription!() } : {}),
    capabilityIds: ['agents.agent.read'],
    observedAt,
  })) }).resources
}

const requireResourceId = (
  invocation: z.infer<typeof moduleCapabilityInvocationSchema>,
  moduleId: SamsinnModuleId,
  resourceType: string,
): string => {
  if (!invocation.resource) throw new Error('Capability requires a Resource')
  if (invocation.resource.moduleId !== moduleId || invocation.resource.type !== resourceType) {
    throw new Error(`Capability requires a ${resourceType} Resource`)
  }
  return invocation.resource.id
}

const invoke = async (
  moduleId: SamsinnModuleId,
  capabilityId: string,
  workspaceId: WorkspaceId,
  raw: unknown,
  registry: WorkspaceRuntimeRegistry,
): Promise<Response> => {
  const invocation = moduleCapabilityInvocationSchema.parse(raw)
  if (invocation.workspaceId !== workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Invocation belongs to another Workspace')
  if (invocation.capabilityId !== capabilityId) return apiError(409, 'capability_scope_mismatch', 'Invocation Capability does not match the route')
  if (!capabilityId.startsWith(`${moduleId}.`)) return apiError(404, 'capability_not_found', 'Capability not found')
  const runtime = await registry.getOrLoad(workspaceId)

  if (capabilityId === 'collaboration.room.create') {
    const input = createRoomSchema.parse(invocation.input)
    const room = runtime.rooms.createRoomSafe({ name: input.name, createdBy: invocation.access.actor.id ?? 'system', ...(input.roomPrompt ? { roomPrompt: input.roomPrompt } : {}) })
    return json({ result: room.value.profile }, 201)
  }
  if (capabilityId === 'collaboration.room.read') {
    const roomId = requireResourceId(invocation, 'collaboration', 'collaboration.room')
    const room = runtime.rooms.getRoom(roomId)
    return room
      ? json({ result: { profile: room.profile, state: room.getRoomState(), messages: room.getRecent(room.getMessageCount()) } })
      : apiError(404, 'room_not_found', 'Room not found')
  }
  if (capabilityId === 'collaboration.room.post-message') {
    const roomId = requireResourceId(invocation, 'collaboration', 'collaboration.room')
    const room = runtime.rooms.getRoom(roomId)
    if (!room) return apiError(404, 'room_not_found', 'Room not found')
    const input = postMessageSchema.parse(invocation.input)
    const actor = invocation.access.actor
    const message = room.post({
      senderId: actor.id ?? 'anonymous',
      ...(actor.displayName === undefined ? {} : { senderName: actor.displayName }),
      content: input.content,
      type: 'chat',
    })
    return json({ result: message }, 201)
  }
  if (capabilityId === 'agents.agent.create') {
    const input = createAgentSchema.parse(invocation.input)
    const agent = await runtime.spawnAIAgent(input)
    return json({ result: { id: agent.id, name: agent.name, kind: agent.kind } }, 201)
  }
  if (capabilityId === 'agents.agent.read') {
    const agentId = requireResourceId(invocation, 'agents', 'agents.agent')
    const agent = runtime.team.getAgent(agentId)
    const ai = agent ? asAIAgent(agent) : undefined
    return ai
      ? json({ result: { id: ai.id, kind: ai.kind, config: ai.getConfig() } })
      : apiError(404, 'agent_not_found', 'Agent not found')
  }
  return apiError(404, 'capability_not_found', 'Capability not found')
}

export const handleSamsinnModuleApi = async (
  request: Request,
  url: URL,
  config: {
    readonly state: SamsinnModuleState
    readonly registry: WorkspaceRuntimeRegistry
  },
): Promise<Response | null> => {
  try {
    const manifestMatch = url.pathname.match(/^\/\.well-known\/workspace-module\/(collaboration|agents)$/)
    if (manifestMatch && request.method === 'GET') {
      const moduleId = samsinnModuleIdSchema.parse(manifestMatch[1])
      return json(moduleId === 'collaboration' ? collaborationModuleManifest : agentsModuleManifest)
    }

    const match = url.pathname.match(/^\/internal\/(collaboration|agents)\/workspaces\/([^/]+)(?:\/(resources|capabilities)|\/capabilities\/([^/]+)\/invoke)?$/)
    if (!match) return null
    const moduleId = samsinnModuleIdSchema.parse(match[1])
    const workspaceId = workspaceIdSchema.parse(decodeURIComponent(match[2] ?? ''))
    const collection = match[3]
    const capabilityId = match[4] === undefined ? undefined : decodeURIComponent(match[4])

    if (collection === undefined && capabilityId === undefined) {
      if (request.method === 'PUT') {
        const input = lifecycleSchema.parse(await readJson(request))
        if (input.workspaceId !== workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Lifecycle body and route disagree')
        await config.registry.evictOne(workspaceId)
        const provisioned = await config.state.provision(workspaceId, moduleId)
        return json({ workspaceId, moduleId }, provisioned.created ? 201 : 200)
      }
      if (request.method === 'DELETE') {
        await config.registry.evictOne(workspaceId)
        await config.state.remove(workspaceId, moduleId)
        return new Response(null, { status: 204 })
      }
    }

    await requireModule(config.state, workspaceId, moduleId)
    if (collection === 'resources' && request.method === 'GET') {
      return json(moduleResourceCollectionSchema.parse({
        resources: await resourcesFor(moduleId, workspaceId, config.registry),
      }))
    }
    if (collection === 'capabilities' && request.method === 'GET') {
      return json(moduleCapabilityCollectionSchema.parse({
        capabilities: moduleId === 'collaboration' ? collaborationCapabilities : agentsCapabilities,
      }))
    }
    if (capabilityId !== undefined && request.method === 'POST') {
      return await invoke(moduleId, capabilityId, workspaceId, await readJson(request), config.registry)
    }
    return null
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(400, 'invalid_json', error.message)
    if (error instanceof z.ZodError) return apiError(400, 'invalid_request', error.message)
    if (error instanceof Error && error.message.includes('Workspace not found:')) {
      return apiError(404, 'workspace_not_found', 'Module Workspace not found')
    }
    if (error instanceof Error && (error.message.startsWith('Capability requires') || error.message.includes('not provisioned'))) {
      return apiError(409, 'capability_scope_invalid', error.message)
    }
    throw error
  }
}
