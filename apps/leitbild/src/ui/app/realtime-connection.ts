import type { SimulationRunId, SimulationClockState } from '../../core/model/index.ts'
import {
  parseSimulationRunWebSocketMessage,
  type SimulationRunEventBatchMessage,
  type RuntimeRealtimeMessageBatch,
} from '../simulation-run-events.ts'
import type { SimulationRunCommandRequest } from '../simulation-run-client.ts'
import type { CommandResponse } from '../types.ts'
import { workspaceApiPath } from '../workspace-context.ts'
import { activeWorkspaceId } from '../workspace-context.ts'

export interface RealtimeReadyMessage {
  readonly simulationRunId: SimulationRunId
  readonly scenarioId?: string
  readonly clock?: SimulationClockState
}

export interface RealtimeConnectionCallbacks {
  readonly onOpen: () => void
  readonly onClose: () => void
  readonly onError: (message: string) => void
  readonly onInvalidMessage: (message: string) => void
  readonly onReady: (message: RealtimeReadyMessage) => void
  readonly onEvent: (message: SimulationRunEventBatchMessage) => void
  readonly onRuntimeRealtime: (message: RuntimeRealtimeMessageBatch) => void
}

export interface RealtimeConnectionController {
  readonly connect: (id: SimulationRunId, callbacks: RealtimeConnectionCallbacks) => void
  readonly disconnect: () => void
  readonly canCarry: (id: SimulationRunId) => boolean
  readonly statusFor: (id: SimulationRunId) => 'open' | 'connecting' | 'other'
  readonly sendCommand: (id: SimulationRunId, command: SimulationRunCommandRequest) => Promise<CommandResponse>
  readonly sendRuntimeInput: (id: SimulationRunId, input: RuntimeInputRequest) => void
}

export interface RuntimeInputRequest {
  readonly type: string
  readonly actorId?: string
  readonly clientId?: string
  readonly payload: unknown
}

export const createRealtimeConnectionController = (): RealtimeConnectionController => {
  let socket: WebSocket | null = null
  let socketId: SimulationRunId | null = null
  const pendingCommands = new Map<string, {
    readonly resolve: (response: CommandResponse) => void
    readonly reject: (err: Error) => void
    readonly timeoutId: number
  }>()

  const canCarry = (id: SimulationRunId): boolean =>
    socket !== null
    && socketId === id
    && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)

  const rejectPendingCommands = (message: string): void => {
    for (const [requestId, pending] of pendingCommands) {
      clearTimeout(pending.timeoutId)
      pending.reject(new Error(message))
      pendingCommands.delete(requestId)
    }
  }

  const resolveCommand = (requestId: string, response: CommandResponse): void => {
    const pending = pendingCommands.get(requestId)
    if (!pending) return
    clearTimeout(pending.timeoutId)
    pendingCommands.delete(requestId)
    pending.resolve(response)
  }

  const rejectCommand = (requestId: string | undefined, message: string): void => {
    if (requestId === undefined) {
      rejectPendingCommands(message)
      return
    }
    const pending = pendingCommands.get(requestId)
    if (!pending) return
    clearTimeout(pending.timeoutId)
    pendingCommands.delete(requestId)
    pending.reject(new Error(message))
  }

  return {
    connect: (id, callbacks): void => {
      if (canCarry(id)) return
      socket?.close()
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const nextSocket = new WebSocket(`${protocol}//${location.host}${workspaceApiPath('/ws')}?simulationRun=${encodeURIComponent(id)}`)
      socket = nextSocket
      socketId = id

      nextSocket.onopen = () => {
        if (socket !== nextSocket) return
        callbacks.onOpen()
      }
      nextSocket.onclose = () => {
        if (socket !== nextSocket) return
        socket = null
        socketId = null
        rejectPendingCommands('Realtime command channel closed')
        callbacks.onClose()
      }
      nextSocket.onerror = () => {
        if (socket !== nextSocket) return
        callbacks.onError('WebSocket error')
      }
      nextSocket.onmessage = (message) => {
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
          callbacks.onReady(parsed)
          return
        }
        if (parsed.type === 'command.result') {
          resolveCommand(parsed.requestId, { result: parsed.result })
          return
        }
        if (parsed.type === 'command.error') {
          rejectCommand(parsed.requestId, parsed.message)
          return
        }
        if (parsed.type === 'runtime.realtime') {
          callbacks.onRuntimeRealtime(parsed)
          return
        }
        if (parsed.type === 'runtime.input.error') {
          callbacks.onError(`${parsed.inputType ?? 'Runtime input'} rejected: ${parsed.message}`)
          return
        }
        callbacks.onEvent(parsed)
      }
    },
    disconnect: (): void => {
      socket?.close()
      socket = null
      socketId = null
      rejectPendingCommands('Realtime command channel disconnected')
    },
    canCarry,
    statusFor: (id): 'open' | 'connecting' | 'other' => {
      if (socketId !== id || socket === null) return 'other'
      if (socket.readyState === WebSocket.OPEN) return 'open'
      if (socket.readyState === WebSocket.CONNECTING) return 'connecting'
      return 'other'
    },
    sendCommand: async (id, command): Promise<CommandResponse> => {
      if (socketId !== id || socket === null || socket.readyState !== WebSocket.OPEN) {
        throw new Error('Realtime command channel is not open')
      }
      const activeSocket = socket
      const requestId = `rtcmd:${crypto.randomUUID()}`
      return await new Promise<CommandResponse>((resolve, reject): void => {
        const timeoutId = window.setTimeout(() => {
          pendingCommands.delete(requestId)
          reject(new Error('Realtime command timed out'))
        }, 2_500)
        pendingCommands.set(requestId, {
          resolve,
          reject,
          timeoutId,
        })
        activeSocket.send(JSON.stringify({
          type: 'command',
          requestId,
          command,
        }))
      })
    },
    sendRuntimeInput: (id, input): void => {
      if (socketId !== id || socket === null || socket.readyState !== WebSocket.OPEN) {
        throw new Error('Realtime input channel is not open')
      }
      socket.send(JSON.stringify({
        type: 'runtime.input',
        input,
      }))
    },
  }
}
