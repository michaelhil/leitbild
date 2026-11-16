import type { SimulationRunId, SimulationClockState } from '../../core/model/index.ts'
import {
  parseSimulationRunWebSocketMessage,
  type RoleRefusedMessage,
  type SimulationRunEventBatchMessage,
  type RuntimeRealtimeMessageBatch,
} from '../simulation-run-events.ts'
import { createPerspectiveGate, type PerspectiveGate, type RealtimePerspective } from '../roles/perspective.ts'
import { roleSetQueryParameter } from '../roles/role-session.ts'
import { activeWorkspaceId, workspaceApiPath } from '../workspace-context.ts'

export interface RealtimeReadyMessage {
  readonly simulationRunId: SimulationRunId
  readonly scenarioId?: string
  readonly clock?: SimulationClockState
  /** Role Runs: the adopted epoch's role set and the snapshot that replaces every Run store. */
  readonly perspective?: RealtimePerspective
}

/** The reconnect a close the screen did not ask for starts: the attempt that runs next and its wait. */
export interface RealtimeRetry {
  readonly attempt: number
  readonly inMs: number
}

export interface RealtimeConnectionCallbacks {
  readonly onOpen: () => void
  /** The channel closed without the screen asking; it reconnects by itself (at once when the page is visible or online again). */
  readonly onClose: (retry: RealtimeRetry) => void
  readonly onError: (message: string) => void
  readonly onInvalidMessage: (message: string) => void
  /** `resumed`: the first ready of a reconnected channel, so the screen missed what happened while it was down. */
  readonly onReady: (message: RealtimeReadyMessage, resumed: boolean) => void
  readonly onEvent: (message: SimulationRunEventBatchMessage) => void
  readonly onRuntimeRealtime: (message: RuntimeRealtimeMessageBatch) => void
  readonly onRoleRefused: (message: RoleRefusedMessage) => void
}

export interface RealtimeConnectionController {
  /** Opens the Run's channel; a role Run's connection carries the screen's role set. */
  readonly connect: (id: SimulationRunId, callbacks: RealtimeConnectionCallbacks, roleIds: ReadonlyArray<string> | null) => void
  /**
   * Asks the Run to swap this connection's role set in place; a ready message
   * of a new epoch or a role refusal answers. One switch at a time: until it is
   * answered, a second switch is refused.
   */
  readonly setRoles: (id: SimulationRunId, roleIds: ReadonlyArray<string>) => void
  readonly disconnect: () => void
  readonly sendRuntimeInput: (id: SimulationRunId, input: RuntimeInputRequest) => void
}

export interface RuntimeInputRequest {
  readonly type: string
  readonly payload: unknown
}

/** The wait before reconnect attempt `attempt` (from 1): 1 s, doubling, at most 30 s. */
export const reconnectDelayMs = (attempt: number): number => Math.min(30_000, 1_000 * 2 ** (attempt - 1))

interface WantedChannel {
  readonly id: SimulationRunId
  readonly callbacks: RealtimeConnectionCallbacks
  /** The role set to join with: the one connect() named, then the one the Run last adopted. */
  roleIds: ReadonlyArray<string> | null
}

export const createRealtimeConnectionController = (): RealtimeConnectionController => {
  let socket: WebSocket | null = null
  let socketId: SimulationRunId | null = null
  // What connect() asked for, kept until disconnect(), so a close the screen did not ask for reconnects.
  let wanted: WantedChannel | null = null
  let failedAttempts = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let stopWakeListening: (() => void) | null = null
  let gate: PerspectiveGate = createPerspectiveGate()
  // The epoch a sent `role.set` left; null when no switch awaits its answer.
  let switchFromEpoch: number | null = null
  let inputSequence = 0
  let inputSession: string | undefined
  const canCarry = (id: SimulationRunId): boolean =>
    socket !== null
    && socketId === id
    && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)

  const stopRetrying = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
    stopWakeListening?.()
    stopWakeListening = null
  }
  const retryNow = (): void => {
    if (wanted === null || socket !== null) return
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
    open(wanted, true)
  }
  // Safari closes a locked or hidden tab's sockets: coming back, or back online, tries at once instead of waiting out the backoff.
  const listenForWake = (): (() => void) => {
    const visible = (): void => { if (document.visibilityState === 'visible') retryNow() }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('online', retryNow)
    return () => {
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('online', retryNow)
    }
  }

  const open = (channel: WantedChannel, resumes: boolean): void => {
    const { id, callbacks, roleIds } = channel
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const roleQuery = roleIds === null || roleIds.length === 0 ? '' : `&${roleSetQueryParameter}=${encodeURIComponent(roleIds.join(','))}`
    const nextSocket = new WebSocket(`${protocol}//${location.host}${workspaceApiPath('/ws')}?simulationRun=${encodeURIComponent(id)}${roleQuery}`)
    socket = nextSocket
    socketId = id
    // Epochs count per connection.
    gate = createPerspectiveGate()
    switchFromEpoch = null
    inputSequence = 0
    inputSession = undefined
    const connectionGate = gate
    let resumed = resumes

    nextSocket.onopen = () => {
      if (socket !== nextSocket) return
      callbacks.onOpen()
    }
    nextSocket.onclose = () => {
      if (socket !== nextSocket) return
      socket = null
      socketId = null
      switchFromEpoch = null
      inputSession = undefined
      failedAttempts += 1
      const inMs = reconnectDelayMs(failedAttempts)
      retryTimer = setTimeout(retryNow, inMs)
      stopWakeListening ??= listenForWake()
      callbacks.onClose({ attempt: failedAttempts, inMs })
    }
    nextSocket.onerror = () => {
      if (socket !== nextSocket) return
      callbacks.onError('WebSocket error')
    }
    nextSocket.onmessage = (message) => {
      if (socket !== nextSocket) return
      let parsed
      try {
        parsed = parseSimulationRunWebSocketMessage(message.data as string)
      } catch (err) {
        callbacks.onInvalidMessage(err instanceof Error ? err.message : 'Invalid WebSocket message')
        return
      }
      if (!parsed) return
      if (parsed.workspaceId !== activeWorkspaceId() || parsed.simulationRunId !== id) {
        callbacks.onInvalidMessage('Realtime message scope does not match the active Workspace and Simulation Run')
        return
      }
      if (parsed.type === 'realtime.ready') {
        if (parsed.perspective !== undefined) {
          if (!connectionGate.adopt(parsed.perspective.epoch)) return
          // The first ready of a newer epoch answers the outstanding switch.
          if (switchFromEpoch !== null && parsed.perspective.epoch > switchFromEpoch) switchFromEpoch = null
          channel.roleIds = parsed.perspective.roleIds
        }
        inputSession = parsed.perspective === undefined ? parsed.inputSession : undefined
        failedAttempts = 0
        stopRetrying()
        const answersReconnect = resumed
        resumed = false
        callbacks.onReady(parsed, answersReconnect)
        return
      }
      if (!connectionGate.admits(parsed.epoch)) return
      if (parsed.type === 'role.refused') {
        switchFromEpoch = null
        callbacks.onRoleRefused(parsed)
        return
      }
      if (parsed.type === 'runtime.realtime') {
        callbacks.onRuntimeRealtime(parsed)
        return
      }
      if (parsed.type === 'runtime.input.error') {
        callbacks.onInvalidMessage(`${parsed.inputType ?? 'Runtime input'} rejected: ${parsed.message}`)
        return
      }
      callbacks.onEvent(parsed)
    }
  }

  return {
    connect: (id, callbacks, roleIds): void => {
      if (canCarry(id)) return
      socket?.close()
      stopRetrying()
      failedAttempts = 0
      wanted = { id, callbacks, roleIds }
      open(wanted, false)
    },
    disconnect: (): void => {
      stopRetrying()
      wanted = null
      failedAttempts = 0
      socket?.close()
      socket = null
      socketId = null
      switchFromEpoch = null
      inputSession = undefined
    },
    setRoles: (id, roleIds): void => {
      if (socketId !== id || socket === null || socket.readyState !== WebSocket.OPEN) {
        throw new Error('The realtime channel is not open, so the switch was not sent; this screen keeps its roles')
      }
      if (gate.epoch() === 0) throw new Error('The Run has not answered this screen yet, so the switch was not sent; this screen keeps its roles')
      if (switchFromEpoch !== null) throw new Error('A role switch is already under way')
      socket.send(JSON.stringify({ type: 'role.set', roles: roleIds }))
      switchFromEpoch = gate.epoch()
    },
    sendRuntimeInput: (id, input): void => {
      if (inputSession === undefined || socketId !== id || socket === null || socket.readyState !== WebSocket.OPEN) {
        throw new Error('Steering requires a connected open Run')
      }
      if (socket.bufferedAmount > 0) throw new Error('Steering connection is busy')
      socket.send(JSON.stringify({
        type: 'runtime.input',
        input: { type: input.type, session: inputSession, sequence: ++inputSequence, payload: input.payload },
      }))
    },
  }
}
