// ============================================================================
// Snapshot — System state persistence via JSON.
//
// Pure serialization/deserialization. Reads system state via public getters,
// writes to disk atomically (tmp → rename). Restores by calling
// restoreRoom/injectMessages/restoreState/spawnAIAgent with preserved IDs.
//
// Auto-saver: debounced timer (5s default), flushes on SIGINT/SIGTERM.
//
// v29 is the canonical Workspace runtime snapshot. Module bindings live in
// the Workspace Directory; this file contains only Samsinn-owned state.
// Previous snapshot shapes are rejected.
// ============================================================================

import type { Agent, AIAgentConfig } from '../types/agent.ts'
import type { DeliveryMode, Message, RoomProfile } from '../types/messaging.ts'
import type { LeitbildMirrorConfig, Room } from '../types/room.ts'
import type { Bookmark } from '../workspaces/bookmark-store.ts'
import type { SummaryConfig } from '../types/summary.ts'
import type { Trigger } from '../triggers/types.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { DEFAULT_RESPONSE_FORMAT, DEFAULT_WORKSPACE_PROMPT } from '../workspaces/settings.ts'
import { createSerialiseChain } from '../serialise-chain.ts'
import { redactBiometricMessages } from './snapshot-redact.ts'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

// --- Version ---

export const SNAPSHOT_VERSION = 29

// --- Snapshot schema ---

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
  // Pack namespaces activated in this Room — the complete truth.
  // Includes system packs (core, local) and bundled default-active packs
  // (demos, pwr-ops). Always present; empty list is valid and meaningful
  // ("user has deactivated every pack including system-suggested ones",
  // though the activation route guards against removing system packs).
  readonly activePacks: ReadonlyArray<string>
  // Optional Leitbild mirror binding, persisted only when a Room
  // is bound to a Leitbild Simulation Run. Restored at boot — see
  // src/integrations/leitbild/mirror-service.ts for reconnect lifecycle.
  readonly leitbildMirror?: LeitbildMirrorConfig
}

export interface AgentSnapshot {
  readonly id: string
  readonly config: AIAgentConfig
  readonly roomIds: ReadonlyArray<string>
}

export interface HumanAgentSnapshot {
  readonly id: string
  readonly name: string
  readonly roomIds: ReadonlyArray<string>
  readonly triggers?: ReadonlyArray<Trigger>
}

export interface PendingScrub {
  readonly packId: string
  readonly scheduledAt: string  // ISO-8601 — for triage when scrubs accumulate
}

// per-Workspace commitment to a single embedding model. Set on first
// ingestion (memory fold or document upload), then frozen — vector
// stores cannot mix dimensions across providers, so this triplet is the
// per-index identity. Persisted so it survives restart/eviction.
export interface EmbedderBindingSnapshot {
  readonly provider: 'openai' | 'gemini'
  readonly model: string
  readonly dim: number
  readonly boundAt: number   // ms since epoch — for telemetry only
}

// Document-corpus metadata. The binary lives at
// workspaces/<id>/samsinn/documents/<docId>/original.<ext>, the extracted
// text at .../extracted.txt, and vectors are interleaved into the
// Workspace shard's vectors.jsonl (one record per chunk, namespace='document').
export type DocumentStatus = 'pending' | 'indexed' | 'failed'

export interface DocumentSnapshot {
  readonly docId: string
  readonly filename: string
  readonly mimetype: string
  readonly sizeBytes: number
  readonly uploadTs: number
  readonly status: DocumentStatus
  readonly errorMessage?: string  // populated when status='failed'
  readonly pageCount?: number
  readonly chunkCount?: number
}

export interface SystemSnapshot {
  readonly version: '29'
  readonly timestamp: number
  readonly rooms: ReadonlyArray<RoomSnapshot>
  readonly agents: ReadonlyArray<AgentSnapshot>             // AI agents
  readonly humans: ReadonlyArray<HumanAgentSnapshot>        // human agents
  readonly bookmarks?: ReadonlyArray<Bookmark>
  readonly ollamaUrls?: ReadonlyArray<string>
  readonly ollamaUrl?: string
  // Pack scrubs scheduled while this Workspace was evicted. Each entry is
  // applied on next restoreFromSnapshot — Pack id is removed from every
  // room.activePacks. Cleared after drain on the same restore.
  readonly pendingScrubs?: ReadonlyArray<PendingScrub>
  // Workspace-level customisations. Both are omitted when equal to the
  // default; restoreFromSnapshot leaves the in-memory default in place.
  readonly workspacePrompt?: string
  readonly responseFormat?: string
  // RAG state. Both are absent on Workspaces that have never ingested.
  readonly embedderBinding?: EmbedderBindingSnapshot
  readonly documents?: ReadonlyArray<DocumentSnapshot>
}

// --- Minimal System interface for serialization ---

interface SerializableSystem {
  readonly rooms: {
    readonly listAllRooms: () => ReadonlyArray<RoomProfile>
    readonly getRoom: (idOrName: string) => Room | undefined
    readonly getRoomsForAgent: (agentId: string) => ReadonlyArray<Room>
  }
  readonly settings: {
    readonly getPrompt: () => string
    readonly getResponseFormat: () => string
  }
  readonly bookmarks: {
    readonly list: () => ReadonlyArray<Bookmark>
  }
  readonly team: {
    readonly listAgents: () => ReadonlyArray<Agent>
    readonly getAgent: (idOrName: string) => Agent | undefined
  }
  readonly ollamaUrls?: {
    readonly list: () => string[]
    readonly getCurrent: () => string
  }
}

// --- Serialize ---

export const serializeSystem = (system: SerializableSystem): SystemSnapshot => {
  const roomProfiles = system.rooms.listAllRooms()
  const rooms: RoomSnapshot[] = []

  for (const profile of roomProfiles) {
    const room = system.rooms.getRoom(profile.id)
    if (!room) continue

    const state = room.getRoomState()
    rooms.push({
      profile: room.profile,
      // redactBiometricMessages strips ephemeral biometric capture content
      // before write — see snapshot-redact.ts for the policy rationale.
      messages: redactBiometricMessages(room.getRecent(room.getMessageCount())),
      members: [...room.getParticipantIds()],
      deliveryMode: state.mode,
      paused: state.paused,
      muted: [...state.muted],
      compressedIds: room.getCompressedIds().size > 0 ? [...room.getCompressedIds()] : undefined,
      summaryConfig: room.summaryConfig,
      ...(state.latestSummary ? { latestSummary: state.latestSummary } : {}),
      activePacks: [...room.getActivePacks()],
      ...(room.getLeitbildMirror() ? { leitbildMirror: room.getLeitbildMirror() } : {}),
    })
  }

  const agents: AgentSnapshot[] = []
  const humans: HumanAgentSnapshot[] = []
  for (const agent of system.team.listAgents()) {
    const agentRooms = system.rooms.getRoomsForAgent(agent.id)
    if (agent.kind === 'ai') {
      const aiAgent = asAIAgent(agent)
      if (!aiAgent) continue
      agents.push({
        id: agent.id,
        config: aiAgent.getConfig(),
        roomIds: agentRooms.map(r => r.profile.id),
      })
    } else if (agent.kind === 'human') {
      const triggers = agent.getTriggers?.() ?? []
      humans.push({
        id: agent.id,
        name: agent.name,
        roomIds: agentRooms.map(r => r.profile.id),
        ...(triggers.length > 0 ? { triggers: [...triggers] } : {}),
      })
    }
  }

  const workspacePrompt = system.settings.getPrompt()
  const responseFormat = system.settings.getResponseFormat()
  return {
    version: '29',
    timestamp: Date.now(),
    rooms,
    agents,
    humans,
    bookmarks: [...system.bookmarks.list()],
    ...(system.ollamaUrls ? {
      ollamaUrls: system.ollamaUrls.list(),
      ollamaUrl: system.ollamaUrls.getCurrent(),
    } : {}),
    // Omit when equal to the default — keeps snapshots small and lets
    // restoreFromSnapshot leave the in-memory default in place when no
    // override was set.
    ...(workspacePrompt !== DEFAULT_WORKSPACE_PROMPT ? { workspacePrompt } : {}),
    ...(responseFormat !== DEFAULT_RESPONSE_FORMAT ? { responseFormat } : {}),
    // pendingScrubs is NOT serialised from a live system — it's only ever
    // injected externally by appendPendingScrub (uninstall_pack against an
    // evicted Workspace), and it's drained at restoreFromSnapshot. By the
    // time a live system is being serialised, every scrub has already been
    // applied to room.activePacks.
  }
}

// --- Validation ---

const stringArraySchema = z.array(z.string())

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
  kind: z.enum(['script', 'trigger', 'biometric', 'external-mirror']),
  name: z.string(),
  step: z.number().int().optional(),
}).strict()

const messageAttachmentSchema = z.object({
  kind: z.literal('image'),
  dataUrl: z.string(),
  mimeType: z.literal('image/png'),
  width: z.number().finite(),
  height: z.number().finite(),
  source: z.enum(['leitbild', 'user-upload']).optional(),
  capturedAt: z.number().finite(),
}).strict()

const toolTraceEntrySchema = z.object({
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  success: z.boolean(),
  resultPreview: z.string(),
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
  inReplyTo: stringArraySchema.optional(),
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
  agentTags: stringArraySchema.optional(),
  toolTrace: z.array(toolTraceEntrySchema).optional(),
  attachments: z.array(messageAttachmentSchema).optional(),
}).strict()

const summaryScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('time'), everySeconds: z.number().finite() }).strict(),
  z.object({ kind: z.literal('messages'), everyMessages: z.number().finite() }).strict(),
])

const summaryConfigSchema = z.object({
  model: z.string().optional(),
  summary: z.object({
    enabled: z.boolean(),
    schedule: summaryScheduleSchema,
  }).strict(),
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
  members: stringArraySchema,
  deliveryMode: z.enum(['broadcast', 'manual']),
  paused: z.boolean(),
  muted: stringArraySchema,
  compressedIds: stringArraySchema.optional(),
  summaryConfig: summaryConfigSchema.optional(),
  latestSummary: z.string().optional(),
  activePacks: stringArraySchema,
  leitbildMirror: z.object({
    simulationRunId: z.string(),
    format: z.enum(['summary', 'full']),
  }).strict().optional(),
}).strict()

const agentConfigSchema = z.object({
  name: z.string(),
  model: z.string(),
  persona: z.string(),
  temperature: z.number().finite().optional(),
  seed: z.number().finite().optional(),
  historyLimit: z.number().finite().optional(),
  tools: stringArraySchema.optional(),
  maxToolIterations: z.number().finite().optional(),
  tags: stringArraySchema.optional(),
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
  leitbildBinding: z.object({
    simulationRunId: z.string(),
    role: z.enum(['observer', 'operator']),
  }).strict().optional(),
}).strict()

const systemSnapshotSchema = z.object({
  version: z.literal('29'),
  timestamp: z.number().finite(),
  rooms: z.array(roomSnapshotSchema),
  agents: z.array(z.object({
    id: z.string(),
    config: agentConfigSchema,
    roomIds: stringArraySchema,
  }).strict()),
  humans: z.array(z.object({
    id: z.string(),
    name: z.string(),
    roomIds: stringArraySchema,
    triggers: z.array(triggerSchema).optional(),
  }).strict()),
  bookmarks: z.array(z.object({ id: z.string(), content: z.string() }).strict()).optional(),
  ollamaUrls: stringArraySchema.optional(),
  ollamaUrl: z.string().optional(),
  pendingScrubs: z.array(z.object({
    packId: z.string(),
    scheduledAt: z.string(),
  }).strict()).optional(),
  workspacePrompt: z.string().optional(),
  responseFormat: z.string().optional(),
  embedderBinding: z.object({
    provider: z.enum(['openai', 'gemini']),
    model: z.string(),
    dim: z.number().int(),
    boundAt: z.number().finite(),
  }).strict().optional(),
  documents: z.array(z.object({
    docId: z.string(),
    filename: z.string(),
    mimetype: z.string(),
    sizeBytes: z.number().finite(),
    uploadTs: z.number().finite(),
    status: z.enum(['pending', 'indexed', 'failed']),
    errorMessage: z.string().optional(),
    pageCount: z.number().finite().optional(),
    chunkCount: z.number().finite().optional(),
  }).strict()).optional(),
}).strict()

const parseSnapshot = (raw: unknown) => systemSnapshotSchema.safeParse(raw)

// --- Save / Load ---

// A snapshot is "skippable" iff persisting it adds no value the user would
// notice — i.e. truly empty (no rooms, no agents, no bookmarks). Used by
// createAutoSaver to skip persistence when seeding is disabled
// (SAMSINN_SEED_WORKSPACE=0) and nothing was created.
//
const isEmptySnapshot = (snap: SystemSnapshot): boolean => {
  if (snap.bookmarks && snap.bookmarks.length > 0) return false
  return snap.rooms.length === 0 && snap.agents.length === 0
}

// A4: serialise all snapshot file mutations through a single chained
// promise. Both saveSnapshot (auto-saver) and appendPendingScrub (cross-
// Workspace Pack uninstall) tmp+rename to the same path; without
// serialisation, B can read → A writes new content → B writes its
// (stale-base) → A's content is lost.
//
// Keyed at module level (not per-path) because each Bun process owns
// one $SAMSINN_HOME and the realistic concurrency is one path's writers
// fighting each other.
const writeChain = createSerialiseChain()

export const saveSnapshot = (snapshot: SystemSnapshot, path: string): Promise<void> =>
  writeChain.run(async () => {
    const dir = dirname(path)
    await mkdir(dir, { recursive: true })
    const tmpPath = `${path}.tmp`
    await Bun.write(tmpPath, JSON.stringify(snapshot, null, 2))
    await rename(tmpPath, path)
  })

// Append a pending pack scrub to a snapshot file in place. Used by the
// cross-Workspace scrub path for Workspaces that are currently evicted —
// since they're not live in memory, we mutate their on-disk snapshot
// directly so the scrub applies on next restoreFromSnapshot.
//
// Atomic write via tmp+rename. Skips silently if the snapshot is missing
// or rejected by the canonical schema. Best-effort: callers log on failure
// but don't surface the error to the uninstall response.
export const appendPendingScrub = (
  path: string,
  scrub: PendingScrub,
): Promise<{ readonly applied: boolean; readonly reason?: string }> =>
  // A4: serialise via the same chain as saveSnapshot so concurrent
  // saveSnapshot + appendPendingScrub against the same file can't lose
  // each other's writes.
  writeChain.run(async () => {
    const file = Bun.file(path)
    if (!await file.exists()) return { applied: false, reason: 'no snapshot file' }
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(await file.text()) as Record<string, unknown>
    } catch (err) {
      return { applied: false, reason: `parse failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    const parsed = parseSnapshot(raw)
    if (!parsed.success) {
      return { applied: false, reason: 'snapshot does not match the canonical schema' }
    }
    // Dedupe by Pack id — if a prior scrub for the same Pack is already
    // queued we don't pile on duplicates.
    const existing = (raw.pendingScrubs as PendingScrub[] | undefined) ?? []
    if (existing.some(p => p.packId === scrub.packId)) {
      return { applied: false, reason: 'already queued' }
    }
    const next: SystemSnapshot = {
      ...parsed.data,
      pendingScrubs: [...existing, scrub],
    }
    const tmpPath = `${path}.tmp`
    await Bun.write(tmpPath, JSON.stringify(next, null, 2))
    await rename(tmpPath, path)
    return { applied: true }
  })

export const loadSnapshot = async (path: string): Promise<SystemSnapshot | null> => {
  const file = Bun.file(path)
  if (!await file.exists()) return null

  try {
    const text = await file.text()
    const raw = JSON.parse(text) as Record<string, unknown>

    const parsed = parseSnapshot(raw)
    if (!parsed.success) {
      console.error(`Snapshot at "${path}" does not match the canonical schema. Ignoring it.`)
      return null
    }

    return parsed.data as SystemSnapshot
  } catch (err) {
    console.error('Failed to load snapshot:', err)
    return null
  }
}

// --- Restore ---

interface RestorableSystem {
  readonly rooms: {
    readonly restoreRoom: (profile: RoomProfile) => Room
  }
  readonly settings: {
    readonly setPrompt: (prompt: string) => void
    readonly setResponseFormat: (format: string) => void
  }
  readonly bookmarks: {
    readonly restore: (entries: ReadonlyArray<Bookmark>) => void
  }
  readonly spawnAIAgent: (config: AIAgentConfig, options?: { overrideId?: string }) => Promise<unknown>
  readonly spawnHumanAgent?: (config: { name: string }, send: (msg: unknown) => void, options?: { overrideId?: string }) => Promise<unknown>
  readonly team?: {
    readonly getAgent: (idOrName: string) => {
      readonly id: string
      readonly join: (room: Room) => Promise<void>
      readonly addTrigger?: (trigger: Trigger) => void
    } | undefined
  }
  readonly ollamaUrls?: {
    readonly add: (url: string) => void
    readonly setCurrent: (url: string) => void
  }
}

export const restoreFromSnapshot = async (
  system: RestorableSystem,
  snapshot: SystemSnapshot,
): Promise<void> => {
  // Drain pendingScrubs before applying activePacks. Each entry came from
  // an uninstall_pack that fired while this Workspace was evicted; we apply
  // by filtering the Pack id out of every room.activePacks at restore.
  // No on-disk write here — the next auto-save naturally produces a
  // snapshot without pendingScrubs (serializeSystem omits the field).
  const scrubbed = new Set<string>(
    (snapshot.pendingScrubs ?? []).map(p => p.packId),
  )
  if (scrubbed.size > 0) {
    console.log(`[snapshot] applying ${scrubbed.size} pending pack scrub(s) on restore: ${[...scrubbed].join(', ')}`)
  }

  // 1. Restore rooms (messages + membership + state)
  const roomMap = new Map<string, Room>()
  for (const roomSnap of snapshot.rooms) {
    const room = system.rooms.restoreRoom(roomSnap.profile)
    room.injectMessages(roomSnap.messages)
    const filteredActive = roomSnap.activePacks.filter(ns => !scrubbed.has(ns))
    room.restoreState({
      members: roomSnap.members,
      muted: roomSnap.muted,
      mode: roomSnap.deliveryMode,
      paused: roomSnap.paused,
      compressedIds: roomSnap.compressedIds,
      ...(roomSnap.summaryConfig ? { summaryConfig: roomSnap.summaryConfig } : {}),
      ...(roomSnap.latestSummary ? { latestSummary: roomSnap.latestSummary } : {}),
      activePacks: filteredActive,
      ...(roomSnap.leitbildMirror ? { leitbildMirror: roomSnap.leitbildMirror } : {}),
    })
    roomMap.set(room.profile.id, room)
  }

  // 2. Restore AI agents (with preserved IDs, no auto-join)
  for (const agentSnap of snapshot.agents) {
    await system.spawnAIAgent(agentSnap.config, { overrideId: agentSnap.id })

    // 3. Silently add agent to their rooms; call join() for history summary
    const agent = system.team?.getAgent(agentSnap.id)
    for (const roomId of agentSnap.roomIds) {
      const room = roomMap.get(roomId)
      if (room) {
        room.addMember(agentSnap.id)
        if (agent) await agent.join(room)
      }
    }
  }

  // 2b. Restore human agents (preserved IDs, no-op transport — clients
  // reattach via the per-Workspace broadcast, not per-agent transport).
  if (system.spawnHumanAgent) {
    for (const humanSnap of snapshot.humans ?? []) {
      await system.spawnHumanAgent(
        { name: humanSnap.name },
        () => { /* no-op default; the UI uses the Workspace broadcast */ },
        { overrideId: humanSnap.id },
      )
      const agent = system.team?.getAgent(humanSnap.id)
      for (const roomId of humanSnap.roomIds) {
        const room = roomMap.get(roomId)
        if (room) {
          room.addMember(humanSnap.id)
          if (agent) await agent.join(room)
        }
      }
      // Restore triggers (lastFiredAt persists; scheduler resumes naturally).
      if (humanSnap.triggers && agent?.addTrigger) {
        for (const t of humanSnap.triggers) agent.addTrigger(t)
      }
    }
  }

  // 4. Restore bookmarks (system-wide)
  system.bookmarks.restore(snapshot.bookmarks ?? [])

  // 5. Restore Ollama URLs
  if (system.ollamaUrls && snapshot.ollamaUrls) {
    for (const url of snapshot.ollamaUrls) system.ollamaUrls.add(url)
    if (snapshot.ollamaUrl) system.ollamaUrls.setCurrent(snapshot.ollamaUrl)
  }

  // 6. Restore Workspace-level customisations. Omitted fields leave the
  //    defaults from createWorkspaceSettings untouched.
  if (snapshot.workspacePrompt !== undefined) system.settings.setPrompt(snapshot.workspacePrompt)
  if (snapshot.responseFormat !== undefined) system.settings.setResponseFormat(snapshot.responseFormat)
}

// --- Auto-saver ---

export interface AutoSaver {
  readonly scheduleSave: () => void
  readonly flush: () => Promise<void>
  readonly dispose: () => void
}

// Hard cap on save deferral: when continuous mutations keep pushing the
// debounce timer forward, force a save once the first deferred mutation has
// waited this long. Without this, a steady trickle of edits at <debounceMs
// intervals would never trigger a save until traffic stops.
const MAX_DEFER_MS = 30_000

// Backoff schedule for transient save failures. Mirrors the eviction-flush
// retry policy in runtime-registry.ts so the same disk-full / perm-flip
// scenario is handled identically by the background path. Total wait if all
// three retries are needed: ~80s before the next mutation re-arms the timer.
const SAVE_RETRY_BACKOFF_MS: ReadonlyArray<number> = [5_000, 15_000, 60_000]

export const createAutoSaver = (
  system: SerializableSystem,
  path: string,
  debounceMs: number = 5000,
): AutoSaver => {
  let timer: Timer | undefined
  let saving = false
  let pendingSave = false
  // Timestamp of the first scheduleSave() call in the current debounce
  // window. Cleared on save start; used by scheduleSave to enforce
  // MAX_DEFER_MS so a continuous trickle can't starve the saver.
  let firstDeferredAt: number | null = null

  const doSave = async (): Promise<void> => {
    saving = true
    pendingSave = false
    firstDeferredAt = null
    try {
      const snapshot = serializeSystem(system)
      // Skip persistence for Workspaces with no real user activity. Prevents
      // cookieless drive-by visits and the seed-only state from leaving an
      // empty dir on disk. First user/AI message flips this and the dir is
      // created via saveSnapshot's mkdir(recursive).
      //
      // A3: when transitioning from non-empty to empty (operator deletes
      // every room + agent) we must also delete any existing snapshot file.
      // Without the rm, the OLD non-empty file lingers and is restored on
      // next reload — state divergence between disk and memory.
      if (isEmptySnapshot(snapshot)) {
        try { await rm(path) } catch { /* may not exist; that's fine */ }
        return
      }
      // Bounded retry on transient errors (disk full, perm flip, etc.).
      // Same policy as eviction flush — see runtime-registry.ts:329.
      let lastErr: unknown = null
      for (let attempt = 0; attempt <= SAVE_RETRY_BACKOFF_MS.length; attempt++) {
        try {
          await saveSnapshot(snapshot, path)
          return
        } catch (err) {
          lastErr = err
          if (attempt < SAVE_RETRY_BACKOFF_MS.length) {
            const reason = err instanceof Error ? err.message : String(err)
            console.warn(`[snapshot] auto-save attempt ${attempt + 1} failed: ${reason} — retrying`)
            await new Promise(resolve => setTimeout(resolve, SAVE_RETRY_BACKOFF_MS[attempt]))
          }
        }
      }
      const reason = lastErr instanceof Error ? lastErr.message : String(lastErr)
      console.error(`[snapshot] auto-save exhausted retries; recent state will retry on next mutation: ${reason}`)
    } catch (err) {
      console.error('Auto-save failed:', err)
    } finally {
      saving = false
      if (pendingSave) {
        timer = setTimeout(doSave, debounceMs)
      }
    }
  }

  const scheduleSave = (): void => {
    if (saving) {
      pendingSave = true
      return
    }
    const now = Date.now()
    if (firstDeferredAt === null) firstDeferredAt = now
    // If we've been deferring beyond MAX_DEFER_MS, fire on the next tick
    // regardless of debounce — break the starvation loop.
    const deferredFor = now - firstDeferredAt
    const delay = deferredFor >= MAX_DEFER_MS ? 0 : debounceMs
    if (timer) clearTimeout(timer)
    timer = setTimeout(doSave, delay)
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
