// ============================================================================
// WebSocket Handler — WS protocol, session management, and broadcasting.
//
// Handles upgrade, message dispatch, reconnection, and inactive agent reclaim.
// Commands mirror REST endpoints but use a simpler JSON message protocol.
//
// Command modules live in ws-commands/: room, agent, message.
// The dispatch loop tries each handler in order; first match wins.
// ============================================================================

import type { AgentsWorkspaceRuntime } from '../workspace-runtime.ts'
import type { Agent } from '../core/types/agent.ts'
import type { AgentProfile } from '../core/types/messaging.ts'
import type { RoomState } from '../core/types/room.ts'
import type { StateValue } from '../core/types/agent.ts'
import type { WSInbound, WSOutbound } from '../core/types/ws-protocol.ts'
import { asAIAgent } from '../agents/shared.ts'
import { handleRoomCommand } from './ws-commands/room-commands.ts'
import { handleAgentCommand } from './ws-commands/agent-commands.ts'
import { handleMessageCommand } from './ws-commands/message-commands.ts'
import { handleBiometricCommand } from './ws-commands/biometric-commands.ts'
import { sendError } from './ws-commands/types.ts'
import { validateWSInbound } from './ws-commands/validate.ts'
import type { LimitMetrics } from '../core/limit-metrics.ts'
import type { WorkspaceId } from '@leitbild/contracts'
import type { ClientSession, WSConnection, WSManager } from './ws-types.ts'

// === Constants ===

// Cap on per-connection queued bytes. Bun's ServerWebSocket exposes
// getBufferedAmount(); a slow consumer that lets this grow eats process
// memory. 8 MB is well above any plausible per-message size (snapshots a
// few hundred KB, deltas a few KB) and below "noticeably degraded".
// On overflow we close the socket (1009 = "message too big"); the client
// reconnects fresh, server state is authoritative so no data lost.
const MAX_WS_BUFFERED_BYTES = 8 * 1024 * 1024

// How long an inactive (closed-WS) human session is preserved for name-based
// reclaim. After this window the agent is removed from the team and the
// session entry deleted. 7 days strikes a balance: covers a long weekend or
// vacation, prevents indefinite accumulation.
const SESSION_STALE_MS = 7 * 24 * 60 * 60 * 1000

// Resolver: given an workspaceId, return the live AgentsWorkspaceRuntime if currently in
// memory, or undefined. WSManager uses this to scope buildSnapshot/state
// subscriptions to the caller's tenant rather than closing over a single
// boot system. The shared Ollama gateway is the same across Workspaces, so
// any live system's ollama field works (callers pass the resolved one in).
export interface WSManagerDeps {
  readonly getRuntime: (workspaceId: WorkspaceId) => AgentsWorkspaceRuntime | undefined
  // Optional — when present, backpressure drops are counted. Tests omit.
  readonly limitMetrics?: LimitMetrics
}

export const createWSManager = (deps: WSManagerDeps): WSManager => {
  const { getRuntime, limitMetrics } = deps
  const sessions = new Map<string, ClientSession>()
  const wsConnections = new Map<string, WSConnection>()
  const stateUnsubs = new Map<string, () => void>()

  const releaseSessionForWorkspaceSwitch = (sessionToken: string, nextWorkspaceId: WorkspaceId): boolean => {
    const existing = sessions.get(sessionToken)
    if (!existing || existing.workspaceId === nextWorkspaceId) return false
    const oldWs = wsConnections.get(sessionToken)
    if (oldWs) {
      try { oldWs.close(4003, 'Workspace switched') } catch { /* already closed */ }
      // Only remove the connection we actually closed. A delayed close
      // callback from an older socket must never delete its replacement.
      if (wsConnections.get(sessionToken) === oldWs) {
        wsConnections.delete(sessionToken)
      }
    }
    sessions.delete(sessionToken)
    return true
  }

  // Single backpressure-checking send. If the kernel send buffer holds more
  // than MAX_WS_BUFFERED_BYTES the consumer is too slow — close the socket
  // (1009) and let the client reconnect. Server state is authoritative;
  // the next snapshot brings them back to current.
  const safeSend = (ws: WSConnection, data: string): boolean => {
    let buffered = 0
    try { buffered = ws.getBufferedAmount() } catch { /* mock without method */ }
    if (buffered > MAX_WS_BUFFERED_BYTES) {
      limitMetrics?.inc('wsBackpressureDropped')
      try { ws.close(1009, 'slow consumer') } catch { /* already closed */ }
      return false
    }
    try { ws.send(data); return true } catch { return false }
  }

  const broadcastAllWorkspaces = (msg: WSOutbound): void => {
    const data = JSON.stringify(msg)
    for (const ws of wsConnections.values()) {
      safeSend(ws, data)
    }
  }

  // Diagnostic state — populated by wireWorkspaceRuntimeEvents (markWired) and
  // every broadcastToWorkspace call (lastBroadcastByWorkspace). Surfaced
  // via /api/system/diagnostics. No effect on hot-path latency.
  const wiredWorkspaces = new Set<WorkspaceId>()
  const lastBroadcastByWorkspace = new Map<WorkspaceId, number>()

  // Per-Workspace broadcast — filters wsConnections by session.workspaceId
  // so events fired in one tenant don't reach another tenant's clients.
  const broadcastToWorkspace = (workspaceId: WorkspaceId, msg: WSOutbound): void => {
    lastBroadcastByWorkspace.set(workspaceId, Date.now())
    const data = JSON.stringify(msg)
    for (const [token, session] of sessions) {
      if (session.workspaceId !== workspaceId) continue
      const ws = wsConnections.get(token)
      if (!ws) continue
      safeSend(ws, data)
    }
  }

  // Room-scoped delivery keeps an embedded focused Room isolated while the
  // standalone Agents surface continues to receive every Room event in its
  // Workspace. A focused connection never receives unrelated Room traffic.
  const broadcastToRoom = (workspaceId: WorkspaceId, roomId: string, msg: WSOutbound): void => {
    lastBroadcastByWorkspace.set(workspaceId, Date.now())
    const data = JSON.stringify(msg)
    for (const [token, session] of sessions) {
      if (session.workspaceId !== workspaceId) continue
      if (session.focusedRoomId && session.focusedRoomId !== roomId) continue
      const ws = wsConnections.get(token)
      if (!ws) continue
      safeSend(ws, data)
    }
  }

  // AgentsWorkspaceRuntime callback wiring (room/membership/agent-activity/provider-events/
  // summary lifecycle/ollama-health) lives in src/api/wire-workspace-runtime-events.ts.
  // Ollama metrics are pulled by the dashboard via GET /api/ollama/metrics
  // (3s polling) — no WS push path.

  const subscribeAgentState = (agent: Agent, workspaceId: WorkspaceId): void => {
    if (agent.kind !== 'ai') return
    if (stateUnsubs.has(agent.id)) return
    const agentName = agent.name
    let lastRoomId: string | undefined = agent.state.getContext()
    const unsub = agent.state.subscribe((state: StateValue, _agentId: string, context?: string, startedAt?: number) => {
      if (context) lastRoomId = context
      const event = {
        type: 'agent_state', agentId: agent.id, agentName, state, context,
        ...(startedAt !== undefined ? { generationStarted: startedAt } : {}),
      } as const
      if (lastRoomId) broadcastToRoom(workspaceId, lastRoomId, event)
      else broadcastToWorkspace(workspaceId, event)
    })
    stateUnsubs.set(agent.id, unsub)
  }

  const unsubscribeAgentState = (agentId: string): void => {
    const unsub = stateUnsubs.get(agentId)
    if (unsub) {
      unsub()
      stateUnsubs.delete(agentId)
    }
  }

  // Existing-agent subscription seeding moved into wireWorkspaceRuntimeEvents so
  // it runs at the right time (after the AgentsWorkspaceRuntime is fully populated by
  // any snapshot restore). Single-tenant boot path calls wireWorkspaceRuntimeEvents
  // immediately after createWSManager, so behavior is preserved.

  const buildSnapshot = (workspaceId: WorkspaceId, sessionToken?: string): Extract<WSOutbound, { type: 'snapshot' }> | null => {
    const sys = getRuntime(workspaceId)
    if (!sys) {
      // Workspace runtime evicted between WS upgrade and snapshot build.
      console.error(`[ws] buildSnapshot for evicted Workspace ${workspaceId} — caller will close socket (4001)`)
      void sessionToken
      return null
    }
    const focusedRoomId = sessionToken ? sessions.get(sessionToken)?.focusedRoomId : undefined
    const visibleRooms = sys.rooms.listAllRooms().filter(profile => !focusedRoomId || profile.id === focusedRoomId)
    const roomStates: Record<string, RoomState> = {}
    for (const profile of visibleRooms) {
      const room = sys.rooms.getRoom(profile.id)
      if (room) roomStates[profile.id] = room.getRoomState()
    }
    const visibleAgentIds = focusedRoomId
      ? new Set(sys.rooms.getRoom(focusedRoomId)?.getParticipantIds() ?? [])
      : null
    const agents: AgentProfile[] = sys.team.listAgents()
      .filter(a => !a.inactive && (!visibleAgentIds || visibleAgentIds.has(a.id)))
      .map(a => {
        const ai = asAIAgent(a)
        const ctx = a.state.getContext()
        const startedAt = a.state.getStartedAt()
        return {
          id: a.id, name: a.name, kind: a.kind, state: a.state.get(),
          ...(ctx ? { context: ctx } : {}),
          ...(startedAt !== undefined ? { generationStarted: startedAt } : {}),
          ...(ai ? { model: ai.getModel() } : {}),
        }
      })
    return {
      type: 'snapshot',
      rooms: visibleRooms,
      agents,
      roomStates,
      ...(sessionToken ? { sessionToken } : {}),
    }
  }

  const sweepStaleSessions = (now: number = Date.now()): number => {
    let dropped = 0
    const cutoff = now - SESSION_STALE_MS
    for (const [token, session] of [...sessions]) {
      // Skip live connections — their lastActivity is fresh anyway.
      if (wsConnections.has(token)) continue
      if (session.lastActivity > cutoff) continue
      // Viewer-session cleanup only removes transport state.
      void session
      sessions.delete(token)
      limitMetrics?.inc('staleSessionsEvicted')
      dropped++
    }
    return dropped
  }

  return {
    sessions, wsConnections, releaseSessionForWorkspaceSwitch,
    safeSend, broadcastAllWorkspaces, broadcastToWorkspace, broadcastToRoom,
    subscribeAgentState, unsubscribeAgentState, buildSnapshot, sweepStaleSessions,
    // --- Diagnostics ---
    markWired: (id: WorkspaceId) => { wiredWorkspaces.add(id) },
    isWired: (id: WorkspaceId) => wiredWorkspaces.has(id),
    lastBroadcastAt: (id: WorkspaceId) => lastBroadcastByWorkspace.get(id) ?? null,
    sessionCount: () => sessions.size,
  }
}

// === Command dispatch order — first handler that returns true wins ===

const commandHandlers = [
  handleMessageCommand,
  handleRoomCommand,
  handleAgentCommand,
  handleBiometricCommand,
]

// === Message Handler ===

export const handleWSMessage = async (
  ws: WSConnection,
  session: ClientSession,
  raw: string,
  system: AgentsWorkspaceRuntime,
  wsManager: WSManager,
): Promise<void> => {
  let msg: WSInbound
  try {
    const parsed = JSON.parse(raw) as unknown
    const valid = validateWSInbound(parsed)
    if (!valid.ok) {
      sendError(wsManager, ws, `Invalid message: ${valid.error}`)
      return
    }
    msg = valid.value
  } catch (err) {
    // Surface to operator so a misbehaving client (browser bug, dev-tools
    // injection, plugin) is distinguishable from a server bug. Session token
    // is redacted to its first 8 chars to keep the log line useful without
    // leaking the full identifier. Counter bump surfaces aggregate in
    // /api/system/health without journalctl grep.
    console.warn(`[ws] invalid JSON from session ${session.sessionToken.slice(0, 8)}…:`,
      err instanceof Error ? err.message : String(err))
    system.limitMetrics.inc('wsInvalidJson')
    sendError(wsManager, ws, 'Invalid JSON')
    return
  }

  const ctx = { ws, session, system, wsManager }

  try {
    for (const handler of commandHandlers) {
      if (await handler(msg, ctx)) return
    }
    sendError(wsManager, ws, `Unknown message type: ${(msg as Record<string, unknown>).type}`)
  } catch (err) {
    sendError(wsManager, ws, err instanceof Error ? err.message : 'Command failed')
  }
}
