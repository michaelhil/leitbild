import type { SimulationRunId, SimulationClockState } from '../../core/model/index.ts'
import {
  parseSimulationRunWebSocketMessage,
  type RoleRefusedMessage,
  type SimulationRunEventBatchMessage,
  type RuntimeRealtimeMessageBatch,
} from '../simulation-run-events.ts'
import { createPerspectiveGate, type PerspectiveGate, type RealtimePerspective } from '../roles/perspective.ts'
import { roleSetQueryParameter } from '../roles/role-session.ts'
import { workspaceApiPath } from '../workspace-context.ts'
import { activeWorkspaceId } from '../workspace-context.ts'

export interface RealtimeReadyMessage {
  readonly simulationRunId: SimulationRunId
  readonly scenarioId?: string
  readonly clock?: SimulationClockState
  /** Role Runs: the adopted epoch's role set and the snapshot that replaces every Run store. */
  readonly perspective?: RealtimePerspective
}

export interface RealtimeConnectionCallbacks {
  readonly onOpen: () => void
  readonly onClose: () => void
  readonly onError: (message: string) => void
  readonly onInvalidMessage: (message: string) => void
  readonly onReady: (message: RealtimeReadyMessage) => void
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
  readonly canCarry: (id: SimulationRunId) => boolean
  readonly statusFor: (id: SimulationRunId) => 'open' | 'connecting' | 'other'
  readonly sendRuntimeInput: (id: SimulationRunId, input: RuntimeInputRequest) => void
}

export interface RuntimeInputRequest {
  readonly type: string
  readonly payload: unknown
}

export const createRealtimeConnectionController = (): RealtimeConnectionController => {
  let socket: WebSocket | null = null
  let socketId: SimulationRunId | null = null
  let gate: PerspectiveGate = createPerspectiveGate()
  // The epoch a sent `role.set` left; null when no switch awaits its answer.
  let switchFromEpoch: number | null = null
  let inputSequence = 0
  let inputSession: string | undefined
  const canCarry = (id: SimulationRunId): boolean =>
    socket !== null
    && socketId === id
    && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)

  return {
    connect: (id, callbacks, roleIds): void => {
      if (canCarry(id)) return
      socket?.close()
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
        callbacks.onClose()
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
          }
          inputSession = parsed.perspective === undefined ? parsed.inputSession : undefined
          callbacks.onReady(parsed)
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
    },
    disconnect: (): void => {
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
    canCarry,
    statusFor: (id): 'open' | 'connecting' | 'other' => {
      if (socketId !== id || socket === null) return 'other'
      if (socket.readyState === WebSocket.OPEN) return 'open'
      if (socket.readyState === WebSocket.CONNECTING) return 'connecting'
      return 'other'
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
