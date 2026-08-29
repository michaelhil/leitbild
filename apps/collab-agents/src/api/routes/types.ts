import type { CollabAgentsWorkspaceRuntime } from '../../main.ts'
import type { Agent } from '../../core/types/agent.ts'
import type { WSOutbound } from '../../core/types/ws-protocol.ts'
import type { AccessContext, WorkspaceId } from '@leitbild/contracts'

export interface ResetWorkspaceOk {
  readonly ok: true
  readonly workspaceId: WorkspaceId
}
export interface ResetWorkspaceFail {
  readonly ok: false
  readonly reason: string
}
export type ResetWorkspaceResult = ResetWorkspaceOk | ResetWorkspaceFail

// Distinct from reset: evict drops the CollabAgentsWorkspaceRuntime from in-memory state but
// leaves the on-disk snapshot intact. The next request lazy-reloads via
// restoreFromSnapshot, exercising the evict→reload boundary that the
// streaming-probe deploy gate uses to catch unsubscribeAgentState-style
// regressions.
export type EvictWorkspaceResult =
  | { readonly ok: true; readonly workspaceId: WorkspaceId }
  | { readonly ok: false; readonly reason: string }

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
  readonly system: CollabAgentsWorkspaceRuntime
  readonly accessContext: AccessContext
  // Workspace bound to this request by the application URL.
  readonly workspaceId: WorkspaceId
  readonly broadcast: (msg: WSOutbound) => void
  readonly broadcastToWorkspace?: (workspaceId: WorkspaceId, msg: WSOutbound) => void
  readonly subscribeAgentState: (agent: Agent, workspaceId: WorkspaceId) => void
  readonly unsubscribeAgentState?: (agentId: string) => void
  readonly remoteAddress?: string
  // Delete the Leitbild Module state and drop its runtime from memory. The
  // Host-owned Workspace remains and can provision the Modules again.
  readonly resetWorkspace?: (workspaceId: WorkspaceId) => Promise<ResetWorkspaceResult>
  // Drop the URL-scoped Workspace runtime from memory without deleting snapshots —
  // the next WS upgrade lazy-reloads via restoreFromSnapshot. Used by the
  // post-deploy streaming probe to exercise the evict→reload boundary.
  readonly evictWorkspace?: (workspaceId: WorkspaceId) => Promise<EvictWorkspaceResult>
  // Read-only health/wiring snapshot. Wired in bootstrap.
  readonly diagnostics?: DiagnosticsCapability
}

export interface RouteEntry {
  readonly method: string
  readonly pattern: RegExp
  readonly handler: (req: Request, match: RegExpMatchArray, ctx: RouteContext) => Promise<Response> | Response
}
