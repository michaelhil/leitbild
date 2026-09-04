// Room domain types — message delivery, membership, mode, and Room state.

import type {
  Message,
  RoomProfile,
  PostParams,
  DeliveryMode,
} from './messaging.ts'
import type { SummaryConfig } from './summary.ts'
import type { GenerationQuery } from './llm.ts'

// === Room event callbacks ===

export type OnMessagePosted = (roomId: string, message: Message) => void
export type OnDeliveryModeChanged = (roomId: string, mode: DeliveryMode) => void
export type OnTurnChanged = (roomId: string, agentId?: string, waitingForHuman?: boolean) => void
export type OnRoomCreated = (profile: RoomProfile) => void
export type OnRoomDeleted = (roomId: string, roomName: string) => void
export type OnMembershipChanged = (roomId: string, roomName: string, agentId: string, agentName: string, action: 'added' | 'removed') => void
export interface RemoveAgentFromRoomOptions {
  readonly deleteRoomIfEmpty?: boolean
}
// Fired by the API/MCP layer after agent settings (persona, model, tools,
// triggers, name, etc.) are mutated. Bookmarks-style: argless, "something
// changed". Wire-system-events triggers a snapshot save so config edits
// don't sit in memory until the next message-post.
export type OnAgentSettingsChanged = () => void
// Fired when a room auto-switches Broadcast → Manual on the second AI join.
// UI toasts a one-off hint so the user can flip back to Broadcast if desired.
export type OnModeAutoSwitched = (roomId: string, toMode: DeliveryMode, reason: 'second-ai-joined') => void
// Fired when a room's summary config changes.
export type OnSummaryConfigChanged = (roomId: string, config: SummaryConfig) => void
// Fired when a summary or compression output is persisted to the room.
export type SummaryTarget = 'summary' | 'compression'
export type OnSummaryUpdated = (roomId: string, target: SummaryTarget) => void

// === Room state snapshot (for UI sync on connect/reconnect) ===

export interface RoomState {
  readonly mode: DeliveryMode
  readonly paused: boolean
  readonly muted: ReadonlyArray<string>
  readonly members: ReadonlyArray<string>
  readonly summaryConfig?: SummaryConfig
  readonly latestSummary?: string
  // Pack ids activated in this Room — the complete truth.
  // No implicit augmentation at read time. Empty means that no Pack-owned
  // contributions are active; built-in and authored contributions are separate.
  readonly activePacks: ReadonlyArray<string>
}

// === Room — self-contained component: stores messages and delivers to members ===

export interface Room {
  readonly profile: RoomProfile
  readonly post: (params: PostParams) => Message
  readonly getRecent: (n: number) => ReadonlyArray<Message>
  readonly getParticipantIds: () => ReadonlyArray<string>
  readonly addMember: (id: string) => void
  readonly removeMember: (id: string) => void
  readonly hasMember: (id: string) => boolean
  readonly getMessageCount: () => number
  readonly setRoomPrompt: (prompt: string) => void
  readonly deleteMessage: (messageId: string) => boolean
  readonly clearMessages: () => void
  readonly setGenerationQuery: (messageId: string, traceId: string, query: GenerationQuery) => void
  readonly getGenerationQuery: (messageId: string) => GenerationQueryRecord | undefined
  readonly getGenerationQueries: () => ReadonlyArray<GenerationQueryRecord>
  readonly injectGenerationQueries: (records: ReadonlyArray<GenerationQueryRecord>) => void

  // Delivery mode
  readonly deliveryMode: DeliveryMode
  readonly setDeliveryMode: (mode: DeliveryMode) => void
  // System-initiated auto-switch to manual (fires onModeAutoSwitched in addition
  // to the usual onDeliveryModeChanged + onManualModeEntered). No-op if already manual.
  readonly autoSwitchToManual: (reason: 'second-ai-joined') => void

  // Pause — room-level, prevents all delivery (join/leave and addressing still work)
  readonly paused: boolean
  readonly setPaused: (paused: boolean) => void

  // Room state snapshot (for UI sync)
  readonly getRoomState: () => RoomState

  // Muting — user-controlled, persistent, mode-independent
  readonly setMuted: (agentId: string, muted: boolean) => void
  readonly isMuted: (agentId: string) => boolean
  readonly getMutedIds: () => ReadonlySet<string>

  // Compression tracking — IDs of messages subsumed by the single evolving
  // `room_summary` message at the top of the stream. Populated only by
  // replaceCompression(); no cap-based pruning.
  readonly getCompressedIds: () => ReadonlySet<string>

  // Summary & compression state (per-room feature).
  readonly summaryConfig: SummaryConfig
  readonly setSummaryConfig: (config: SummaryConfig) => void
  readonly getLatestSummary: () => string | undefined
  readonly setLatestSummary: (text: string) => void
  // Replace the single evolving compression at the top of the stream.
  // Removes the prior `room_summary` message (if any), flags oldestIds as
  // compressed (tombstones), and inserts a fresh `room_summary` at position 0.
  // Returns the inserted message.
  readonly replaceCompression: (oldestIds: ReadonlyArray<string>, newText: string) => Message
  // Current `room_summary` at top of stream, if any.
  readonly getCurrentCompressionMessage: () => Message | undefined

  // Active Packs — the complete Pack-id list whose contributions are
  // available in this Room. Built-in and authored contributions are not Packs.
  readonly getActivePacks: () => ReadonlyArray<string>
  readonly setActivePacks: (packIds: ReadonlyArray<string>) => void

  // Snapshot restore — bypass delivery, populate state directly
  readonly injectMessages: (msgs: ReadonlyArray<Message>) => void
  readonly restoreState: (state: RoomRestoreParams) => void
}

export interface GenerationQueryRecord {
  readonly messageId: string
  readonly traceId: string
  readonly query: GenerationQuery
}

export interface RoomRestoreParams {
  readonly members: ReadonlyArray<string>
  readonly muted: ReadonlyArray<string>
  readonly mode: DeliveryMode
  readonly paused: boolean
  readonly compressedIds?: ReadonlyArray<string>
  readonly summaryConfig?: SummaryConfig
  readonly latestSummary?: string
  readonly activePacks: ReadonlyArray<string>
}

// === CreateResult — returned when name uniqueness is enforced ===

export interface CreateResult<T> {
  readonly value: T
  readonly requestedName: string
  readonly assignedName: string
}

export interface RoomConfig {
  readonly companionOf?: RoomProfile['companionOf']
  readonly name: string
  readonly roomPrompt?: string
  readonly createdBy: string
  readonly sourceDefinition?: {
    readonly id: string
    readonly revisionId: string
  }
}
