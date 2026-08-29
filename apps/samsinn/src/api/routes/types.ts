import type { SamsinnWorkspaceRuntime } from '../../main.ts'
import type { Agent } from '../../core/types/agent.ts'
import type { WSOutbound } from '../../core/types/ws-protocol.ts'
import type { AccessContext, WorkspaceId } from '@samsinn-leitbild/platform-contracts'

export interface ResetWorkspaceOk {
  readonly ok: true
  readonly workspaceId: WorkspaceId
}
export interface ResetWorkspaceFail {
  readonly ok: false
  readonly reason: string
}
export type ResetWorkspaceResult = ResetWorkspaceOk | ResetWorkspaceFail

// Distinct from reset: evict drops the SamsinnWorkspaceRuntime from in-memory state but
// leaves the on-disk snapshot intact. The next request lazy-reloads via
// restoreFromSnapshot, exercising the evict→reload boundary that the
// streaming-probe deploy gate uses to catch unsubscribeAgentState-style
// regressions.
export type EvictWorkspaceResult =
  | { readonly ok: true; readonly workspaceId: WorkspaceId }
  | { readonly ok: false; readonly reason: string }

// Capabilities that the Workspace routes need. Wired in bootstrap.ts.
export interface WorkspaceAdmin {
  readonly list: () => Promise<ReadonlyArray<{ id: WorkspaceId; displayName: string; snapshotMtimeMs: number; snapshotSizeBytes: number; isLive: boolean }>>
  readonly create: (displayName?: string) => Promise<{ id: WorkspaceId }>
  // Build a Set-Cookie value pointing at `id`. The route returns it on the response.
  readonly buildSwitchCookie: (id: WorkspaceId, req: Request) => string
}

// Read-only health snapshot used by /system/diagnostics. Walks the
// registry + wsManager to surface per-Workspace broadcast wiring state.
// Catches the silent-skip class of bug fixed in 5d73a8e: zero-broadcast
// Workspaces under live traffic mean the wiring chain is broken somewhere.
export interface DiagnosticsCapability {
  readonly snapshot: () => {
    readonly workspaces: ReadonlyArray<{
      readonly id: WorkspaceId
      readonly wired: boolean
      readonly agentCount: number
      readonly generatingAgentCount: number
      readonly lastBroadcastAt: number | null
    }>
    readonly wsSessions: number
    readonly configuredIdleMs?: number
    readonly maxLoadedWorkspaces?: number
  }
}

export interface RouteContext {
  readonly system: SamsinnWorkspaceRuntime
  readonly accessContext: AccessContext
  // Workspace bound to this request via the cookie (resolved before dispatch).
  readonly workspaceId: WorkspaceId
  readonly broadcast: (msg: WSOutbound) => void
  readonly broadcastToWorkspace?: (workspaceId: WorkspaceId, msg: WSOutbound) => void
  readonly subscribeAgentState: (agent: Agent, workspaceId: WorkspaceId) => void
  readonly unsubscribeAgentState?: (agentId: string) => void
  readonly remoteAddress?: string
  // Per-Workspace reset (Phase F5). Reads the cookie from req, trashes the
  // Workspace directory, drops it from the registry. The same id is kept;
  // the next request from the same cookie lazy-creates a fresh empty RoomDirectory.
  readonly resetWorkspace?: (req: Request) => Promise<ResetWorkspaceResult>
  // Drop the cookie's Workspace from memory without trashing its snapshot —
  // the next WS upgrade lazy-reloads via restoreFromSnapshot. Used by the
  // post-deploy streaming probe to exercise the evict→reload boundary.
  readonly evictWorkspace?: (req: Request) => Promise<EvictWorkspaceResult>
  // Workspace discovery and selection (list / create / switch). Wired in bootstrap.
  readonly workspaces?: WorkspaceAdmin
  // Read-only health/wiring snapshot. Wired in bootstrap.
  readonly diagnostics?: DiagnosticsCapability
  // Leitbild mirror service (process-level singleton). Wired in bootstrap.
  // Absent if the integration was not initialized (e.g. in tests).
  readonly leitbildMirror?: import('../../integrations/leitbild/mirror-service.ts').MirrorService
}

export interface RouteEntry {
  readonly method: string
  readonly pattern: RegExp
  readonly handler: (req: Request, match: RegExpMatchArray, ctx: RouteContext) => Promise<Response> | Response
}
