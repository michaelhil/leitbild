import { z } from 'zod'
import {
  inspectionViewSchema,
  moduleCapabilityCollectionSchema,
  moduleCapabilityInvocationSchema,
  moduleDefinitionCollectionSchema,
  moduleIdSchema,
  moduleResourceCollectionSchema,
  toolGrantSetSchema,
  workspaceIdSchema,
  workspaceModuleManifestSchema,
  workspaceDefinitionRevisionReferenceSchema,
  type ModuleResourceDescriptor,
  type WorkspaceId,
} from '@leitbild/contracts'
import { createModuleCapabilityRegistry } from '@leitbild/module-runtime'
import { asAIAgent } from '../agents/shared.ts'
import { runPromptDeckEntry, startRoomDefinition, validateRoomDefinition } from '../core/definitions/room-definition-service.ts'
import type { RoomDefinitionLibrary } from '../core/definitions/room-definition-library.ts'
import { roomDefinitionSchema, type RoomDefinition } from '../core/definitions/room-definition-catalog.ts'
import type { AgentsModuleState } from '../core/workspaces/module-state.ts'
import type { WorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'

export const agentsModuleManifest = workspaceModuleManifestSchema.parse({
  module: {
    id: 'agents',
    title: 'Agents',
    description: 'Rooms, messages, coordination, AI Agent profiles, model execution, tools, context, and evaluations.',
  },
  endpoints: {
    workspace: '/internal/workspaces/{workspaceId}',
    definitions: '/internal/workspaces/{workspaceId}/definitions',
    resources: '/internal/workspaces/{workspaceId}/resources',
    capabilities: '/internal/workspaces/{workspaceId}/capabilities',
    invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke',
  },
  ui: { workspace: '/workspaces/{workspaceId}/agents' },
})

const AGENTS_MODULE_ID = moduleIdSchema.parse('agents')

const lifecycleSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
const createRoomSchema = z.object({ name: z.string().trim().min(1).max(128), roomPrompt: z.string().max(16_384).optional() }).strict()
const postMessageSchema = z.object({ content: z.string().min(1).max(1_000_000) }).strict()
const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
  persona: z.string().max(64_000),
  tools: z.array(z.string().trim().min(1).max(128)).default([]),
  toolGrants: toolGrantSetSchema.optional(),
  temperature: z.number().finite().optional(),
}).strict()
const readRoomSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
}).strict()
const runPromptDeckEntrySchema = z.object({
  entryId: z.string().trim().min(1).max(128),
}).strict()
const writeRoomDefinitionSchema = z.object({ definition: roomDefinitionSchema }).strict()
const emptyInputSchema = z.object({}).strict()
const ROOM_DEFINITION_TYPE = 'agents.room-definition'

const json = (body: unknown, status = 200): Response => Response.json(body, { status })
const apiError = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status)

const readJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json()
  } catch (error) {
    throw new SyntaxError('Request body must be valid JSON', { cause: error })
  }
}

const requireModule = async (state: AgentsModuleState, workspaceId: WorkspaceId): Promise<void> => {
  if (!await state.has(workspaceId)) throw new Error(`Agents Workspace not found: ${workspaceId}`)
}

const resourcesFor = async (
  workspaceId: WorkspaceId,
  registry: WorkspaceRuntimeRegistry,
): Promise<ReadonlyArray<ModuleResourceDescriptor>> => {
  const runtime = await registry.getOrLoad(workspaceId)
  const observedAt = new Date().toISOString()
  return moduleResourceCollectionSchema.parse({ resources: [
    ...runtime.rooms.listAllRooms().map(profile => {
      const room = runtime.rooms.getRoom(profile.id)
      if (!room) throw new Error(`Room disappeared during Resource discovery: ${profile.id}`)
      const memberIds = room.getParticipantIds()
      const aiMemberCount = memberIds.filter(id => runtime.team.getAgent(id)?.kind === 'ai').length
      const latestMessage = room.getRecent(1)[0]
      return {
        ref: { workspaceId, moduleId: AGENTS_MODULE_ID, type: 'agents.room', id: profile.id },
        title: profile.name,
        ...(profile.sourceDefinition === undefined ? {} : {
          sourceDefinition: {
            workspaceId,
            moduleId: AGENTS_MODULE_ID,
            type: ROOM_DEFINITION_TYPE,
            id: profile.sourceDefinition.id,
            revisionId: profile.sourceDefinition.revisionId,
          },
        }),
        links: memberIds.flatMap(id => runtime.team.getAgent(id)?.kind === 'ai' ? [{
          rel: 'member',
          ref: { workspaceId, moduleId: AGENTS_MODULE_ID, type: 'agents.agent', id },
          title: runtime.team.getAgent(id)?.name,
        }] : []),
        uiPath: `/workspaces/${encodeURIComponent(workspaceId)}/agents?room=${encodeURIComponent(profile.id)}`,
        capabilityIds: agentsCapabilities.idsForResourceType('agents.room'),
        inspectionCapabilityId: 'agents.room.inspect',
        deleteCapabilityId: 'agents.room.delete',
        summary: [
          {
            key: 'created-at',
            label: 'Created',
            kind: 'timestamp' as const,
            value: new Date(profile.createdAt).toISOString(),
          },
          {
            key: 'status',
            label: 'Status',
            kind: 'status' as const,
            value: room.paused ? 'Paused' : room.deliveryMode === 'broadcast' ? 'Broadcast' : 'Manual',
          },
          { key: 'member-count', label: 'Members', kind: 'count' as const, value: memberIds.length },
          { key: 'ai-member-count', label: 'AI agents', kind: 'count' as const, value: aiMemberCount },
          { key: 'message-count', label: 'Messages', kind: 'count' as const, value: room.getMessageCount() },
          ...(latestMessage === undefined ? [] : [{
            key: 'last-activity-at',
            label: 'Last activity',
            kind: 'timestamp' as const,
            value: new Date(latestMessage.timestamp).toISOString(),
          }]),
        ],
        observedAt,
      }
    }),
    ...runtime.team.listByKind('ai').map(agent => ({
      ref: { workspaceId, moduleId: AGENTS_MODULE_ID, type: 'agents.agent', id: agent.id },
      title: agent.name,
      ...(agent.getDescription?.() ? { description: agent.getDescription!() } : {}),
      links: runtime.rooms.getRoomsForAgent(agent.id).map(room => ({
        rel: 'member-of',
        ref: { workspaceId, moduleId: AGENTS_MODULE_ID, type: 'agents.room', id: room.profile.id },
        title: room.profile.name,
      })),
      capabilityIds: agentsCapabilities.idsForResourceType('agents.agent'),
      summary: [
        { key: 'status', label: 'Status', kind: 'status' as const, value: agent.state.get() },
        { key: 'room-count', label: 'Rooms', kind: 'count' as const, value: runtime.rooms.getRoomsForAgent(agent.id).length },
      ],
      observedAt,
    })),
  ] }).resources
}

const definitionsFor = async (workspaceId: WorkspaceId, library: RoomDefinitionLibrary) => {
  const definitions = await library.list()
  return moduleDefinitionCollectionSchema.parse({ definitions: definitions.map(definition => ({
    ref: {
      workspaceId,
      moduleId: AGENTS_MODULE_ID,
      type: ROOM_DEFINITION_TYPE,
      id: definition.id,
    },
    title: definition.title,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(definition.category === undefined ? {} : { category: definition.category }),
    currentRevisionId: definition.currentRevisionId,
    capabilityIds: agentsCapabilities.idsForDefinitionType(ROOM_DEFINITION_TYPE),
    inspectionCapabilityId: 'agents.room-definition.inspect',
    primaryCapabilityId: 'agents.room-definition.start',
    deleteCapabilityId: 'agents.room-definition.delete',
  })) }).definitions
}

const requireRoomDefinitionId = (
  invocation: z.infer<typeof moduleCapabilityInvocationSchema>,
): string => {
  if (!invocation.definition) throw new Error('Room Definition Capability requires a Definition')
  if (invocation.definition.type !== ROOM_DEFINITION_TYPE) throw new Error('Capability requires an Agents Room Definition')
  return invocation.definition.id
}

const requireResourceId = (
  invocation: z.infer<typeof moduleCapabilityInvocationSchema>,
  resourceType: 'agents.room' | 'agents.agent',
): string => {
  if (!invocation.resource) throw new Error('Capability requires a Resource')
  if (invocation.resource.moduleId !== 'agents' || invocation.resource.type !== resourceType) {
    throw new Error(`Capability requires an ${resourceType} Resource`)
  }
  return invocation.resource.id
}

type AgentsWorkspaceRuntime = Awaited<ReturnType<WorkspaceRuntimeRegistry['getOrLoad']>>

const serializableInspection = (value: unknown) =>
  inspectionViewSchema.parse(JSON.parse(JSON.stringify(value)) as unknown)

const roomDefinitionSections = (definition: RoomDefinition) => [{
  id: 'room-configuration',
  title: 'Room configuration',
  data: {
    prompt: definition.room.prompt ?? null,
    deliveryMode: definition.room.deliveryMode,
    packs: definition.room.packs,
  },
}, {
  id: 'configured-agents',
  title: 'Configured agents',
  description: 'Agent personas, tools, semantic Capability grants, and generation settings declared by this definition.',
  data: {
    total: definition.room.agents.length,
    agents: definition.room.agents,
  },
}, {
  id: 'prompt-deck',
  title: 'Prompt deck',
  data: {
    total: definition.deck.entries.length,
    entries: definition.deck.entries,
  },
}]

const definitionWriteResultSchema = z.object({
  definition: workspaceDefinitionRevisionReferenceSchema,
  title: z.string(),
}).strict()

const parseRoomDefinitionWrite = (runtime: AgentsWorkspaceRuntime, raw: unknown) => {
  const input = writeRoomDefinitionSchema.parse(raw)
  try {
    validateRoomDefinition(runtime, input.definition)
  } catch (error) {
    throw new z.ZodError([{ code: 'custom', path: ['definition'], message: error instanceof Error ? error.message : String(error) }])
  }
  return input
}

const agentsCapabilities = createModuleCapabilityRegistry<{ runtime: AgentsWorkspaceRuntime; library: RoomDefinitionLibrary }, Response>(AGENTS_MODULE_ID, [
  {
    descriptor: {
      id: 'agents.room-definition.create',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'workspace' },
      title: 'Create Room Definition',
      description: 'Validates and saves a reusable Room Definition as an immutable revision.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(writeRoomDefinitionSchema),
      outputSchema: z.toJSONSchema(definitionWriteResultSchema),
    },
    invoke: async ({ runtime, library }, invocation) => {
      const input = parseRoomDefinitionWrite(runtime, invocation.input)
      try {
        const revision = await library.create(input.definition)
        return json({ result: {
          definition: {
            workspaceId: invocation.workspaceId,
            moduleId: AGENTS_MODULE_ID,
            type: ROOM_DEFINITION_TYPE,
            id: revision.definitionId,
            revisionId: revision.id,
          },
          title: revision.document.title,
        } }, 201)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Definition already exists:')) {
          return apiError(409, 'room_definition_already_exists', error.message)
        }
        throw error
      }
    },
  },
  {
    descriptor: {
      id: 'agents.room.create',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'workspace' },
      title: 'Create Room',
      description: 'Creates a durable Room in the Workspace.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(createRoomSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime }, invocation) => {
      const input = createRoomSchema.parse(invocation.input)
      const room = runtime.rooms.createRoomSafe({
        name: input.name,
        createdBy: invocation.access.actor.id ?? 'system',
        ...(input.roomPrompt ? { roomPrompt: input.roomPrompt } : {}),
      })
      return json({
        result: room.value.profile,
        createdResources: [{
          workspaceId: invocation.workspaceId,
          moduleId: AGENTS_MODULE_ID,
          type: 'agents.room',
          id: room.value.profile.id,
        }],
      }, 201)
    },
  },
  {
    descriptor: {
      id: 'agents.room.inspect',
      moduleId: AGENTS_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'agents.room' },
      title: 'Inspect Room',
      description: 'Shows Room configuration and state, member profiles, source definition, and recent activity summaries.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: z.toJSONSchema(inspectionViewSchema),
    },
    invoke: async ({ runtime, library }, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const room = runtime.rooms.getRoom(requireResourceId(invocation, 'agents.room'))
      if (!room) return apiError(404, 'room_not_found', 'Room not found')
      const state = room.getRoomState()
      const members = room.getParticipantIds().map(id => {
        const agent = runtime.team.getAgent(id)
        if (!agent) return { id, unavailable: true }
        const ai = asAIAgent(agent)
        return {
          id: agent.id,
          name: agent.name,
          kind: agent.kind,
          ...(ai === undefined ? {} : { configuration: ai.getConfig() }),
        }
      })
      const recentMessages = room.getRecent(20)
      const sourceRevision = room.profile.sourceDefinition === undefined
        ? undefined
        : await library.getRevision(room.profile.sourceDefinition.revisionId)
      return json({ result: serializableInspection({
        target: { kind: 'resource', resource: invocation.resource },
        title: room.profile.name,
        observedAt: new Date().toISOString(),
        sections: [{
          id: 'identity',
          title: 'Room identity and provenance',
          data: room.profile,
        }, {
          id: 'live-state',
          title: 'Current Room state',
          data: state,
        }, {
          id: 'members',
          title: 'Members and Agent configuration',
          data: {
            total: members.length,
            aiAgents: members.filter(member => 'kind' in member && member.kind === 'ai').length,
            members,
          },
        }, {
          id: 'recent-activity',
          title: 'Recent activity',
          description: 'The latest 20 messages are summarized here; the Room remains the canonical conversation view.',
          data: {
            messageCount: room.getMessageCount(),
            messages: recentMessages.map(message => ({
              id: message.id,
              senderId: message.senderId,
              ...(message.senderName === undefined ? {} : { senderName: message.senderName }),
              type: message.type,
              timestamp: new Date(message.timestamp).toISOString(),
              contentPreview: message.content.length > 500 ? `${message.content.slice(0, 500)}…` : message.content,
            })),
          },
        }, ...(sourceRevision === undefined ? [] : [{
          id: 'source-definition',
          title: 'Pinned Room Definition',
          data: {
            revisionId: sourceRevision.id,
            definitionId: sourceRevision.definitionId,
            definition: sourceRevision.document,
          },
        }])],
      }) })
    },
  },
  {
    descriptor: {
      id: 'agents.room.delete',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'agents.room' },
      title: 'Delete Room',
      description: 'Permanently deletes a Room, its messages, memberships, and Room-scoped triggers.',
      risk: 'destructive',
      idempotent: false,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime }, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const roomId = requireResourceId(invocation, 'agents.room')
      return runtime.removeRoom(roomId)
        ? json({ result: { deleted: true, roomId } })
        : apiError(404, 'room_not_found', 'Room not found')
    },
  },
  {
    descriptor: {
      id: 'agents.room.read',
      moduleId: AGENTS_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'agents.room' },
      title: 'Read Room',
      description: 'Reads the selected Room profile, state, and a bounded recent-message window.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(readRoomSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime }, invocation) => {
      const room = runtime.rooms.getRoom(requireResourceId(invocation, 'agents.room'))
      const input = readRoomSchema.parse(invocation.input)
      return room
        ? json({ result: {
            profile: room.profile,
            state: room.getRoomState(),
            messageCount: room.getMessageCount(),
            messages: room.getRecent(input.limit),
          } })
        : apiError(404, 'room_not_found', 'Room not found')
    },
  },
  {
    descriptor: {
      id: 'agents.room.post-message',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'agents.room' },
      title: 'Post Room Message',
      description: 'Posts an attributed message to the selected Room.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(postMessageSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime }, invocation) => {
      const room = runtime.rooms.getRoom(requireResourceId(invocation, 'agents.room'))
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
    },
  },
  {
    descriptor: {
      id: 'agents.room-definition.inspect',
      moduleId: AGENTS_MODULE_ID,
      kind: 'query',
      scope: { kind: 'definition', definitionType: ROOM_DEFINITION_TYPE },
      title: 'Inspect Room Definition',
      description: 'Shows the exact Room Definition configuration, agent personas, Packs, tools, and Prompt Deck.',
      risk: 'read',
      idempotent: true,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: z.toJSONSchema(inspectionViewSchema),
    },
    invoke: async ({ library }, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const definitionId = requireRoomDefinitionId(invocation)
      const revision = await library.getRevision(invocation.definition!.revisionId)
      if (!revision || revision.definitionId !== definitionId) {
        return apiError(404, 'room_definition_revision_not_found', 'Room Definition Revision not found')
      }
      return json({ result: serializableInspection({
        target: { kind: 'definition', definition: invocation.definition },
        title: revision.document.title,
        description: revision.document.description,
        observedAt: new Date().toISOString(),
        sections: [{
          id: 'identity',
          title: 'Identity and provenance',
          data: {
            definitionId: revision.definitionId,
            revisionId: revision.id,
            category: revision.document.category ?? null,
          },
        }, ...roomDefinitionSections(revision.document)],
      }) })
    },
  },
  {
    descriptor: {
      id: 'agents.room-definition.update',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'definition', definitionType: ROOM_DEFINITION_TYPE },
      title: 'Update Room Definition',
      description: 'Creates a new immutable revision from edited Room Definition content.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(writeRoomDefinitionSchema),
      outputSchema: z.toJSONSchema(definitionWriteResultSchema),
    },
    invoke: async ({ runtime, library }, invocation) => {
      const input = parseRoomDefinitionWrite(runtime, invocation.input)
      const definitionId = requireRoomDefinitionId(invocation)
      if (input.definition.id !== definitionId) {
        return apiError(409, 'room_definition_identity_mismatch', 'Edited Room Definition id does not match the target Definition')
      }
      try {
        const revision = await library.update(
          input.definition,
          invocation.definition!.revisionId,
        )
        return json({ result: {
          definition: { ...invocation.definition, revisionId: revision.id },
          title: revision.document.title,
        } })
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Definition Revision changed:')) {
          return apiError(409, 'room_definition_revision_changed', error.message)
        }
        throw error
      }
    },
  },
  {
    descriptor: {
      id: 'agents.room-definition.start',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'definition', definitionType: ROOM_DEFINITION_TYPE },
      title: 'Start Room',
      description: 'Creates a Room from the requested immutable Room Definition Revision.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime, library }, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const started = await startRoomDefinition(
        runtime,
        library,
        requireRoomDefinitionId(invocation),
        invocation.definition!.revisionId,
      )
      const resource = {
        workspaceId: invocation.workspaceId,
        moduleId: AGENTS_MODULE_ID,
        type: 'agents.room',
        id: started.room.id,
      }
      return json({
        result: {
          room: started.room,
          revisionId: started.revisionId,
          uiPath: `/workspaces/${encodeURIComponent(invocation.workspaceId)}/agents?room=${encodeURIComponent(started.room.id)}`,
        },
        createdResources: [resource],
      }, 201)
    },
  },
  {
    descriptor: {
      id: 'agents.room-definition.delete',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'definition', definitionType: ROOM_DEFINITION_TYPE },
      title: 'Delete Room Definition',
      description: 'Removes this Room Definition from the Workspace catalog. Existing Rooms retain their pinned revision.',
      risk: 'destructive',
      idempotent: false,
      inputSchema: z.toJSONSchema(emptyInputSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ library }, invocation) => {
      emptyInputSchema.parse(invocation.input)
      const definitionId = requireRoomDefinitionId(invocation)
      return await library.delete(definitionId, invocation.definition!.revisionId)
        ? json({ result: { deleted: true, definitionId } })
        : apiError(404, 'room_definition_not_found', 'Room Definition not found')
    },
  },
  {
    descriptor: {
      id: 'agents.prompt-deck.run-entry',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'agents.room' },
      title: 'Run Prompt Deck Entry',
      description: 'Runs one declared Prompt Deck entry in a selected Room.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(runPromptDeckEntrySchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime, library }, invocation) => {
      const roomId = requireResourceId(invocation, 'agents.room')
      const input = runPromptDeckEntrySchema.parse(invocation.input)
      return json({ result: await runPromptDeckEntry(
        runtime,
        library,
        roomId,
        input.entryId,
      ) })
    },
  },
  {
    descriptor: {
      id: 'agents.agent.create',
      moduleId: AGENTS_MODULE_ID,
      kind: 'command',
      scope: { kind: 'workspace' },
      title: 'Create Agent',
      description: 'Creates an AI Agent Profile in the Workspace.',
      risk: 'write',
      idempotent: false,
      inputSchema: z.toJSONSchema(createAgentSchema),
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime }, invocation) => {
      const input = createAgentSchema.parse(invocation.input)
      const agent = await runtime.spawnAIAgent(input)
      return json({ result: { id: agent.id, name: agent.name, kind: agent.kind } }, 201)
    },
  },
  {
    descriptor: {
      id: 'agents.agent.read',
      moduleId: AGENTS_MODULE_ID,
      kind: 'query',
      scope: { kind: 'resource', resourceType: 'agents.agent' },
      title: 'Read Agent',
      description: 'Reads the selected AI Agent Profile.',
      risk: 'read',
      idempotent: true,
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object' },
    },
    invoke: async ({ runtime }, invocation) => {
      const agent = runtime.team.getAgent(requireResourceId(invocation, 'agents.agent'))
      const ai = agent ? asAIAgent(agent) : undefined
      return ai
        ? json({ result: { id: ai.id, kind: ai.kind, config: ai.getConfig() } })
        : apiError(404, 'agent_not_found', 'Agent not found')
    },
  },
])

const invoke = async (
  capabilityId: string,
  workspaceId: WorkspaceId,
  raw: unknown,
  registry: WorkspaceRuntimeRegistry,
): Promise<Response> => {
  const invocation = moduleCapabilityInvocationSchema.parse(raw)
  if (invocation.workspaceId !== workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Invocation belongs to another Workspace')
  if (invocation.capabilityId !== capabilityId) return apiError(409, 'capability_scope_mismatch', 'Invocation Capability does not match the route')
  const runtime = await registry.getOrLoad(workspaceId)
  const response = await agentsCapabilities.invoke(capabilityId, { runtime, library: registry.definitionsFor(workspaceId) }, invocation)
  return response ?? apiError(404, 'capability_not_found', 'Capability not found')
}

export const handleAgentsModuleApi = async (
  request: Request,
  url: URL,
  config: { readonly state: AgentsModuleState; readonly registry: WorkspaceRuntimeRegistry },
): Promise<Response | null> => {
  try {
    if (url.pathname === '/.well-known/workspace-module' && request.method === 'GET') return json(agentsModuleManifest)

    const match = url.pathname.match(/^\/internal\/workspaces\/([^/]+)(?:\/(definitions|resources|capabilities)|\/capabilities\/([^/]+)\/invoke)?$/)
    if (!match) return null
    const workspaceId = workspaceIdSchema.parse(decodeURIComponent(match[1] ?? ''))
    const collection = match[2]
    const capabilityId = match[3] === undefined ? undefined : decodeURIComponent(match[3])

    if (collection === undefined && capabilityId === undefined) {
      if (request.method === 'PUT') {
        const input = lifecycleSchema.parse(await readJson(request))
        if (input.workspaceId !== workspaceId) return apiError(409, 'workspace_scope_mismatch', 'Lifecycle body and route disagree')
        await config.registry.evictOne(workspaceId)
        const provisioned = await config.state.provision(workspaceId)
        return json({ workspaceId, moduleId: 'agents' }, provisioned.created ? 201 : 200)
      }
      if (request.method === 'DELETE') {
        await config.registry.evictOne(workspaceId)
        await config.state.remove(workspaceId)
        return new Response(null, { status: 204 })
      }
    }

    await requireModule(config.state, workspaceId)
    if (collection === 'definitions' && request.method === 'GET') {
      return json(moduleDefinitionCollectionSchema.parse({ definitions: await definitionsFor(workspaceId, config.registry.definitionsFor(workspaceId)) }))
    }
    if (collection === 'resources' && request.method === 'GET') {
      return json(moduleResourceCollectionSchema.parse({ resources: await resourcesFor(workspaceId, config.registry) }))
    }
    if (collection === 'capabilities' && request.method === 'GET') {
      return json(moduleCapabilityCollectionSchema.parse({ capabilities: agentsCapabilities.descriptors }))
    }
    if (capabilityId !== undefined && request.method === 'POST') {
      return await invoke(capabilityId, workspaceId, await readJson(request), config.registry)
    }
    return null
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(400, 'invalid_json', error.message)
    if (error instanceof z.ZodError) return apiError(400, 'invalid_request', error.message)
    if (error instanceof Error && error.message.includes('Workspace not found:')) return apiError(404, 'workspace_not_found', 'Module Workspace not found')
    if (error instanceof Error && (error.message.startsWith('Capability requires') || error.message.includes('not provisioned'))) {
      return apiError(409, 'capability_scope_invalid', error.message)
    }
    throw error
  }
}
