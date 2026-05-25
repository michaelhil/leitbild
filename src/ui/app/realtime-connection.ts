import type { ControlInstanceId, SimulationClockState } from '../../core/model/index.ts'
import {
  parseControlInstanceWebSocketMessage,
  type ControlInstanceEventBatchMessage,
} from '../control-instance-events.ts'

export interface RealtimeReadyMessage {
  readonly controlInstanceId: ControlInstanceId
  readonly scenarioId?: string
  readonly clock?: SimulationClockState
}

export interface RealtimeConnectionCallbacks {
  readonly onOpen: () => void
  readonly onClose: () => void
  readonly onError: (message: string) => void
  readonly onInvalidMessage: (message: string) => void
  readonly onReady: (message: RealtimeReadyMessage) => void
  readonly onEvent: (message: ControlInstanceEventBatchMessage) => void
}

export interface RealtimeConnectionController {
  readonly connect: (id: ControlInstanceId, callbacks: RealtimeConnectionCallbacks) => void
  readonly disconnect: () => void
  readonly canCarry: (id: ControlInstanceId) => boolean
  readonly statusFor: (id: ControlInstanceId) => 'open' | 'connecting' | 'other'
}

export const createRealtimeConnectionController = (): RealtimeConnectionController => {
  let socket: WebSocket | null = null
  let socketId: ControlInstanceId | null = null

  const canCarry = (id: ControlInstanceId): boolean =>
    socket !== null
    && socketId === id
    && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)

  return {
    connect: (id, callbacks): void => {
      if (canCarry(id)) return
      socket?.close()
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const nextSocket = new WebSocket(`${protocol}//${location.host}/ws?controlInstance=${encodeURIComponent(id)}`)
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
        callbacks.onClose()
      }
      nextSocket.onerror = () => {
        if (socket !== nextSocket) return
        callbacks.onError('WebSocket error')
      }
      nextSocket.onmessage = (message) => {
        let parsed
        try {
          parsed = parseControlInstanceWebSocketMessage(message.data as string)
        } catch (err) {
          callbacks.onInvalidMessage(err instanceof Error ? err.message : 'Invalid WebSocket message')
          return
        }
        if (!parsed) return
        if (parsed.type === 'realtime.ready') {
          callbacks.onReady(parsed)
          return
        }
        callbacks.onEvent(parsed)
      }
    },
    disconnect: (): void => {
      socket?.close()
      socket = null
      socketId = null
    },
    canCarry,
    statusFor: (id): 'open' | 'connecting' | 'other' => {
      if (socketId !== id || socket === null) return 'other'
      if (socket.readyState === WebSocket.OPEN) return 'open'
      if (socket.readyState === WebSocket.CONNECTING) return 'connecting'
      return 'other'
    },
  }
}
