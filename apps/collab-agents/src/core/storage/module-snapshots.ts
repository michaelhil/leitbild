import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { toolGrantSetSchema } from '@leitbild/contracts'
import type { Agent, AIAgentConfig } from '../types/agent.ts'
import type { DeliveryMode, Message, RoomProfile } from '../types/messaging.ts'
import type { Room } from '../types/room.ts'
import type { Bookmark } from '../workspaces/bookmark-store.ts'
import type { SummaryConfig } from '../types/summary.ts'
import type { Trigger } from '../triggers/types.ts'
import type { WorkspaceModulePaths } from '../paths.ts'
import type { CollabAgentsModuleId } from '../workspaces/module-state.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { DEFAULT_RESPONSE_FORMAT, DEFAULT_WORKSPACE_PROMPT } from '../workspaces/settings.ts'
import { createSerialiseChain } from '../serialise-chain.ts'
import { redactBiometricMessages } from './snapshot-redact.ts'

export const COLLABORATION_SNAPSHOT_SCHEMA = 1
export const AGENTS_SNAPSHOT_SCHEMA = 1

export interface RoomSnapshot {
  readonly profile: RoomProfile
  readonly messages: ReadonlyArray<Message>
  readonly members: ReadonlyArray<string>
  readonly deliveryMode: DeliveryMode
  readonly paused: boolean
  readonly muted: ReadonlyArray<string>
  readonly compressedIds?: ReadonlyArray<string>
  readonly summaryConfig?: SummaryConfig
  readonly latestSummary?: string
  readonly activePacks: ReadonlyArray<string>
}

export interface HumanActorSnapshot {
  readonly id: string
  readonly name: string
  readonly triggers?: ReadonlyArray<Trigger>
}

export interface PendingScrub {
  readonly packId: string
  readonly scheduledAt: string
}

export interface CollabSnapshot {
  readonly schemaVersion: 1
  readonly savedAt: string
  readonly rooms: ReadonlyArray<RoomSnapshot>
  readonly humanActors: ReadonlyArray<HumanActorSnapshot>
  readonly bookmarks: ReadonlyArray<Bookmark>
  readonly pendingScrubs?: ReadonlyArray<PendingScrub>
}

export interface AgentProfileSnapshot {
  readonly id: string
  readonly config: AIAgentConfig
}

export interface AgentsSnapshot {
  readonly schemaVersion: 1
  readonly savedAt: string
  readonly agents: ReadonlyArray<AgentProfileSnapshot>
  readonly workspacePrompt?: string
  readonly responseFormat?: string
  readonly ollamaUrls?: ReadonlyArray<string>
  readonly ollamaUrl?: string
}

export interface WorkspaceModuleSnapshots {
  readonly collab: CollabSnapshot | null
  readonly agents: AgentsSnapshot | null
}

interface SerializableRuntime {
  readonly rooms: {
    readonly listAllRooms: () => ReadonlyArray<RoomProfile>
    readonly getRoom: (idOrName: string) => Room | undefined
  }
  readonly settings: {
    readonly getPrompt: () => string
    readonly getResponseFormat: () => string
  }
  readonly bookmarks: { readonly list: () => ReadonlyArray<Bookmark> }
  readonly team: { readonly listAgents: () => ReadonlyArray<Agent> }
  readonly ollamaUrls?: {
    readonly list: () => string[]
    readonly getCurrent: () => string
  }
}

const triggerSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  mode: z.enum(['execute', 'post', 'start-script']),
  intervalSec: z.number().finite(),
  enabled: z.boolean(),
  roomId: z.string(),
  lastFiredAt: z.number().finite().optional(),
  targetName: z.string().optional(),
}).strict()

const roomProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  roomPrompt: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.number().finite(),
}).strict()

const messageCauseSchema = z.object({
  kind: z.enum(['script', 'trigger', 'biometric', 'resource-event']),
  name: z.string(),
  step: z.number().int().optional(),
}).strict()

const messageAttachmentSchema = z.object({
  kind: z.literal('image'),
  dataUrl: z.string(),
  mimeType: z.literal('image/png'),
  width: z.number().finite(),
  height: z.number().finite(),
  source: z.enum(['resource', 'user-upload']).optional(),
  capturedAt: z.number().finite(),
}).strict()

const messageSchema = z.object({
  id: z.string(),
  senderId: z.string(),
  senderName: z.string().optional(),
  content: z.string(),
  timestamp: z.number().finite(),
  type: z.enum(['chat', 'join', 'leave', 'system', 'room_summary', 'pass', 'mute', 'error']),
  roomId: z.string(),
  correlationId: z.string().optional(),
  inReplyTo: z.array(z.string()).optional(),
  cause: messageCauseSchema.optional(),
  generationMs: z.number().finite().optional(),
  promptTokens: z.number().finite().optional(),
  completionTokens: z.number().finite().optional(),
  cacheCreation: z.number().finite().optional(),
  cacheRead: z.number().finite().optional(),
  contextMax: z.number().finite().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  errorCode: z.enum([
    'no_api_key', 'model_unavailable', 'rate_limited', 'network',
    'provider_down', 'tool_loop_exceeded', 'empty_response',
    'tools_unavailable', 'unknown',
  ]).optional(),
  errorProvider: z.string().optional(),
  agentName: z.string().optional(),
  agentKind: z.enum(['ai', 'human']).optional(),
  agentTags: z.array(z.string()).optional(),
  toolTrace: z.array(z.object({
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    success: z.boolean(),
    resultPreview: z.string(),
  }).strict()).optional(),
  attachments: z.array(messageAttachmentSchema).optional(),
}).strict()

const summaryScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('time'), everySeconds: z.number().finite() }).strict(),
  z.object({ kind: z.literal('messages'), everyMessages: z.number().finite() }).strict(),
])

const summaryConfigSchema = z.object({
  model: z.string().optional(),
  summary: z.object({ enabled: z.boolean(), schedule: summaryScheduleSchema }).strict(),
  compression: z.object({
    enabled: z.boolean(),
    schedule: summaryScheduleSchema,
    keepFresh: z.number().finite(),
    batchSize: z.number().finite(),
    aggressiveness: z.enum(['low', 'med', 'high']),
  }).strict(),
}).strict()

const roomSnapshotSchema = z.object({
  profile: roomProfileSchema,
  messages: z.array(messageSchema),
  members: z.array(z.string()),
  deliveryMode: z.enum(['broadcast', 'manual']),
  paused: z.boolean(),
  muted: z.array(z.string()),
  compressedIds: z.array(z.string()).optional(),
  summaryConfig: summaryConfigSchema.optional(),
  latestSummary: z.string().optional(),
  activePacks: z.array(z.string()),
}).strict()

const agentConfigSchema = z.object({
  name: z.string(),
  model: z.string(),
  persona: z.string(),
  temperature: z.number().finite().optional(),
  seed: z.number().finite().optional(),
  historyLimit: z.number().finite().optional(),
  tools: z.array(z.string()).optional(),
  toolGrants: toolGrantSetSchema.optional(),
  maxToolIterations: z.number().finite().optional(),
  tags: z.array(z.string()).optional(),
  thinking: z.boolean().optional(),
  includePrompts: z.object({
    persona: z.boolean().optional(),
    room: z.boolean().optional(),
    workspace: z.boolean().optional(),
    responseFormat: z.boolean().optional(),
    skills: z.boolean().optional(),
    wikis: z.boolean().optional(),
  }).strict().optional(),
  includeContext: z.object({
    participants: z.boolean().optional(),
    activity: z.boolean().optional(),
    knownAgents: z.boolean().optional(),
  }).strict().optional(),
  includeTools: z.boolean().optional(),
  promptsEnabled: z.boolean().optional(),
  contextEnabled: z.boolean().optional(),
  triggers: z.array(triggerSchema).optional(),
}).strict()

const bookmarkSchema = z.object({ id: z.string(), content: z.string() }).strict()

const collabSnapshotSchema = z.object({
  schemaVersion: z.literal(COLLABORATION_SNAPSHOT_SCHEMA),
  savedAt: z.iso.datetime({ offset: true }),
  rooms: z.array(roomSnapshotSchema),
  humanActors: z.array(z.object({
    id: z.string(),
    name: z.string(),
    triggers: z.array(triggerSchema).optional(),
  }).strict()),
  bookmarks: z.array(bookmarkSchema),
  pendingScrubs: z.array(z.object({
    packId: z.string(),
    scheduledAt: z.iso.datetime({ offset: true }),
  }).strict()).optional(),
}).strict()

const agentsSnapshotSchema = z.object({
  schemaVersion: z.literal(AGENTS_SNAPSHOT_SCHEMA),
  savedAt: z.iso.datetime({ offset: true }),
  agents: z.array(z.object({ id: z.string(), config: agentConfigSchema }).strict()),
  workspacePrompt: z.string().optional(),
  responseFormat: z.string().optional(),
  ollamaUrls: z.array(z.string()).optional(),
  ollamaUrl: z.string().optional(),
}).strict()

export const serializeModuleSnapshots = (runtime: SerializableRuntime): {
  readonly collab: CollabSnapshot
  readonly agents: AgentsSnapshot
} => {
  const rooms: RoomSnapshot[] = []
  for (const profile of runtime.rooms.listAllRooms()) {
    const room = runtime.rooms.getRoom(profile.id)
    if (!room) throw new Error(`Room disappeared during snapshot: ${profile.id}`)
    const state = room.getRoomState()
    rooms.push({
      profile: room.profile,
      messages: redactBiometricMessages(room.getRecent(room.getMessageCount())),
      members: [...room.getParticipantIds()],
      deliveryMode: state.mode,
      paused: state.paused,
      muted: [...state.muted],
      ...(room.getCompressedIds().size > 0 ? { compressedIds: [...room.getCompressedIds()] } : {}),
      ...(room.summaryConfig ? { summaryConfig: room.summaryConfig } : {}),
      ...(state.latestSummary ? { latestSummary: state.latestSummary } : {}),
      activePacks: [...room.getActivePacks()],
    })
  }

  const agents: AgentProfileSnapshot[] = []
  const humanActors: HumanActorSnapshot[] = []
  for (const actor of runtime.team.listAgents()) {
    if (actor.kind === 'ai') {
      const agent = asAIAgent(actor)
      if (!agent) throw new Error(`AI Agent does not implement the AI runtime contract: ${actor.id}`)
      agents.push({ id: actor.id, config: agent.getConfig() })
    } else if (actor.kind === 'human') {
      const triggers = actor.getTriggers?.() ?? []
      humanActors.push({
        id: actor.id,
        name: actor.name,
        ...(triggers.length > 0 ? { triggers: [...triggers] } : {}),
      })
    }
  }

  const savedAt = new Date().toISOString()
  const workspacePrompt = runtime.settings.getPrompt()
  const responseFormat = runtime.settings.getResponseFormat()
  return {
    collab: collabSnapshotSchema.parse({
      schemaVersion: COLLABORATION_SNAPSHOT_SCHEMA,
      savedAt,
      rooms,
      humanActors,
      bookmarks: [...runtime.bookmarks.list()],
    }),
    agents: agentsSnapshotSchema.parse({
      schemaVersion: AGENTS_SNAPSHOT_SCHEMA,
      savedAt,
      agents,
      ...(workspacePrompt !== DEFAULT_WORKSPACE_PROMPT ? { workspacePrompt } : {}),
      ...(responseFormat !== DEFAULT_RESPONSE_FORMAT ? { responseFormat } : {}),
      ...(runtime.ollamaUrls ? {
        ollamaUrls: runtime.ollamaUrls.list(),
        ollamaUrl: runtime.ollamaUrls.getCurrent(),
      } : {}),
    }),
  }
}

const writeChain = createSerialiseChain()

const writeSnapshot = (snapshot: unknown, path: string): Promise<void> => writeChain.run(async () => {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  await rename(temporaryPath, path)
})

const removeSnapshot = async (path: string): Promise<void> => {
  try {
    await rm(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

const collabIsEmpty = (snapshot: CollabSnapshot): boolean =>
  snapshot.rooms.length === 0
  && snapshot.humanActors.length === 0
  && snapshot.bookmarks.length === 0

const agentsIsEmpty = (snapshot: AgentsSnapshot): boolean =>
  snapshot.agents.length === 0
  && snapshot.workspacePrompt === undefined
  && snapshot.responseFormat === undefined
  && (snapshot.ollamaUrls === undefined || snapshot.ollamaUrls.length === 0)

export const saveWorkspaceModuleSnapshots = async (
  snapshots: { readonly collab: CollabSnapshot; readonly agents: AgentsSnapshot },
  paths: WorkspaceModulePaths,
  enabledModules: ReadonlySet<CollabAgentsModuleId>,
): Promise<void> => {
  if (enabledModules.has('collab')) {
    if (collabIsEmpty(snapshots.collab)) await removeSnapshot(paths.collab.snapshot)
    else await writeSnapshot(collabSnapshotSchema.parse(snapshots.collab), paths.collab.snapshot)
  }
  if (enabledModules.has('agents')) {
    if (agentsIsEmpty(snapshots.agents)) await removeSnapshot(paths.agents.snapshot)
    else await writeSnapshot(agentsSnapshotSchema.parse(snapshots.agents), paths.agents.snapshot)
  }
}

const loadStrict = async <T>(path: string, schema: z.ZodType<T>): Promise<T | null> => {
  const file = Bun.file(path)
  if (!await file.exists()) return null
  return schema.parse(JSON.parse(await file.text()) as unknown)
}

export const loadWorkspaceModuleSnapshots = async (
  paths: WorkspaceModulePaths,
  enabledModules: ReadonlySet<CollabAgentsModuleId>,
): Promise<WorkspaceModuleSnapshots> => ({
  collab: enabledModules.has('collab')
    ? await loadStrict(paths.collab.snapshot, collabSnapshotSchema)
    : null,
  agents: enabledModules.has('agents')
    ? await loadStrict(paths.agents.snapshot, agentsSnapshotSchema)
    : null,
})

interface RestorableRuntime {
  readonly rooms: { readonly restoreRoom: (profile: RoomProfile) => Room }
  readonly settings: {
    readonly setPrompt: (prompt: string) => void
    readonly setResponseFormat: (format: string) => void
  }
  readonly bookmarks: { readonly restore: (entries: ReadonlyArray<Bookmark>) => void }
  readonly spawnAIAgent: (config: AIAgentConfig, options?: { overrideId?: string }) => Promise<unknown>
  readonly spawnHumanAgent?: (config: { name: string }, send: (message: unknown) => void, options?: { overrideId?: string }) => Promise<unknown>
  readonly team?: {
    readonly getAgent: (idOrName: string) => {
      readonly join: (room: Room) => Promise<void>
      readonly addTrigger?: (trigger: Trigger) => void
    } | undefined
  }
  readonly ollamaUrls?: {
    readonly add: (url: string) => void
    readonly setCurrent: (url: string) => void
  }
}

export const restoreWorkspaceModuleSnapshots = async (
  runtime: RestorableRuntime,
  snapshots: WorkspaceModuleSnapshots,
): Promise<void> => {
  const roomMap = new Map<string, Room>()
  const collab = snapshots.collab
  if (collab) {
    const scrubbed = new Set((collab.pendingScrubs ?? []).map(scrub => scrub.packId))
    for (const roomSnapshot of collab.rooms) {
      const room = runtime.rooms.restoreRoom(roomSnapshot.profile)
      room.injectMessages(roomSnapshot.messages)
      room.restoreState({
        members: roomSnapshot.members,
        muted: roomSnapshot.muted,
        mode: roomSnapshot.deliveryMode,
        paused: roomSnapshot.paused,
        compressedIds: roomSnapshot.compressedIds,
        ...(roomSnapshot.summaryConfig ? { summaryConfig: roomSnapshot.summaryConfig } : {}),
        ...(roomSnapshot.latestSummary ? { latestSummary: roomSnapshot.latestSummary } : {}),
        activePacks: roomSnapshot.activePacks.filter(packId => !scrubbed.has(packId)),
      })
      roomMap.set(room.profile.id, room)
    }
  }

  const joinRestoredMemberships = async (actorId: string): Promise<void> => {
    const actor = runtime.team?.getAgent(actorId)
    if (!actor || !collab) return
    for (const roomSnapshot of collab.rooms) {
      if (!roomSnapshot.members.includes(actorId)) continue
      const room = roomMap.get(roomSnapshot.profile.id)
      if (room) await actor.join(room)
    }
  }

  const agents = snapshots.agents
  if (agents) {
    for (const agentSnapshot of agents.agents) {
      await runtime.spawnAIAgent(agentSnapshot.config, { overrideId: agentSnapshot.id })
      await joinRestoredMemberships(agentSnapshot.id)
    }
    if (runtime.ollamaUrls && agents.ollamaUrls) {
      for (const url of agents.ollamaUrls) runtime.ollamaUrls.add(url)
      if (agents.ollamaUrl) runtime.ollamaUrls.setCurrent(agents.ollamaUrl)
    }
    if (agents.workspacePrompt !== undefined) runtime.settings.setPrompt(agents.workspacePrompt)
    if (agents.responseFormat !== undefined) runtime.settings.setResponseFormat(agents.responseFormat)
  }

  if (collab) {
    if (runtime.spawnHumanAgent) {
      for (const human of collab.humanActors) {
        await runtime.spawnHumanAgent({ name: human.name }, () => {}, { overrideId: human.id })
        await joinRestoredMemberships(human.id)
        const actor = runtime.team?.getAgent(human.id)
        for (const trigger of human.triggers ?? []) actor?.addTrigger?.(trigger)
      }
    }
    runtime.bookmarks.restore(collab.bookmarks)
  }
}

export const appendCollabPendingScrub = (
  path: string,
  scrub: PendingScrub,
): Promise<{ readonly applied: boolean; readonly reason?: string }> => writeChain.run(async () => {
  const snapshot = await loadStrict(path, collabSnapshotSchema)
  if (!snapshot) return { applied: false, reason: 'no Collab snapshot' }
  if ((snapshot.pendingScrubs ?? []).some(item => item.packId === scrub.packId)) {
    return { applied: false, reason: 'already queued' }
  }
  const next = collabSnapshotSchema.parse({
    ...snapshot,
    pendingScrubs: [...(snapshot.pendingScrubs ?? []), scrub],
  })
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporaryPath, `${JSON.stringify(next, null, 2)}\n`)
  await rename(temporaryPath, path)
  return { applied: true }
})

export interface ModuleAutoSaver {
  readonly scheduleSave: () => void
  readonly flush: () => Promise<void>
  readonly dispose: () => void
}

const MAX_DEFER_MS = 30_000
const SAVE_RETRY_BACKOFF_MS: ReadonlyArray<number> = [5_000, 15_000, 60_000]

export const createModuleAutoSaver = (
  runtime: SerializableRuntime,
  paths: WorkspaceModulePaths,
  enabledModules: ReadonlySet<CollabAgentsModuleId>,
  debounceMs = 5_000,
): ModuleAutoSaver => {
  let timer: Timer | undefined
  let saving = false
  let pendingSave = false
  let firstDeferredAt: number | null = null

  const runScheduledSave = (): void => {
    void doSave().catch(error => {
      console.error('[workspace-snapshot] scheduled Module save failed', error)
    })
  }

  const doSave = async (): Promise<void> => {
    saving = true
    pendingSave = false
    firstDeferredAt = null
    try {
      const snapshots = serializeModuleSnapshots(runtime)
      let lastError: unknown = null
      for (let attempt = 0; attempt <= SAVE_RETRY_BACKOFF_MS.length; attempt += 1) {
        try {
          await saveWorkspaceModuleSnapshots(snapshots, paths, enabledModules)
          return
        } catch (error) {
          lastError = error
          if (attempt < SAVE_RETRY_BACKOFF_MS.length) {
            await new Promise(resolve => setTimeout(resolve, SAVE_RETRY_BACKOFF_MS[attempt]))
          }
        }
      }
      throw lastError
    } finally {
      saving = false
      if (pendingSave) timer = setTimeout(runScheduledSave, debounceMs)
    }
  }

  const scheduleSave = (): void => {
    if (saving) {
      pendingSave = true
      return
    }
    const now = Date.now()
    if (firstDeferredAt === null) firstDeferredAt = now
    const delay = now - firstDeferredAt >= MAX_DEFER_MS ? 0 : debounceMs
    if (timer) clearTimeout(timer)
    timer = setTimeout(runScheduledSave, delay)
  }

  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = undefined
    pendingSave = false
    firstDeferredAt = null
    await doSave()
  }

  const dispose = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    pendingSave = false
    firstDeferredAt = null
  }

  return { scheduleSave, flush, dispose }
}
