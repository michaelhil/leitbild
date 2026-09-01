import type { WorkspaceId } from '@leitbild/contracts'
import type { Agent } from '../core/types/agent.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'

export interface WSConnection {
  send: (data: string) => void
  getBufferedAmount: () => number
  close: (code: number, reason?: string) => void
}

export interface ClientSession {
  readonly workspaceId: WorkspaceId
  readonly sessionToken: string
  lastActivity: number
}

export interface WSData {
  sessionToken: string
  workspaceId: WorkspaceId
  terminalClose?: 'workspace-unavailable'
}

export interface WSManager {
  readonly sessions: Map<string, ClientSession>
  readonly wsConnections: Map<string, WSConnection>
  readonly releaseSessionForWorkspaceSwitch: (sessionToken: string, nextWorkspaceId: WorkspaceId) => boolean
  readonly safeSend: (ws: WSConnection, data: string) => boolean
  readonly broadcastAllWorkspaces: (msg: WSOutbound) => void
  readonly broadcastToWorkspace: (workspaceId: WorkspaceId, msg: WSOutbound) => void
  readonly subscribeAgentState: (agent: Agent, workspaceId: WorkspaceId) => void
  readonly unsubscribeAgentState: (agentId: string) => void
  readonly buildSnapshot: (workspaceId: WorkspaceId, sessionToken?: string) => Extract<WSOutbound, { type: 'snapshot' }> | null
  readonly sweepStaleSessions: (now?: number) => number
  readonly markWired: (workspaceId: WorkspaceId) => void
  readonly isWired: (workspaceId: WorkspaceId) => boolean
  readonly lastBroadcastAt: (workspaceId: WorkspaceId) => number | null
  readonly sessionCount: () => number
}
