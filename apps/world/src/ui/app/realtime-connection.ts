import type { SimulationRunId, SimulationClockState } from '../../core/model/index.ts'
import {
  parseSimulationRunWebSocketMessage,
  type SimulationRunEventBatchMessage,
  type RuntimeRealtimeMessageBatch,
} from '../simulation-run-events.ts'
import type { SimulationRunCapabilityRequest } from '../simulation-run-client.ts'
import type { CapabilityInvocationResponse } from '../types.ts'
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
  readonly invokeCapability: (id: SimulationRunId, invocation: SimulationRunCapabilityRequest) => Promise<CapabilityInvocationResponse>
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
  const pendingInvocations = new Map<string, {
    readonly resolve: (response: CapabilityInvocationResponse) => void
    readonly reject: (err: Error) => void
    readonly timeoutId: number
  }>()

  const canCarry = (id: SimulationRunId): boolean =>
    socket !== null
    && socketId === id
    && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)

  const rejectPendingInvocations = (message: string): void => {
    for (const [requestId, pending] of pendingInvocations) {
      clearTimeout(pending.timeoutId)
      pending.reject(new Error(message))
      pendingInvocations.delete(requestId)
    }
  }

  const resolveInvocation = (requestId: string, response: CapabilityInvocationResponse): void => {
    const pending = pendingInvocations.get(requestId)
    if (!pending) return
    clearTimeout(pending.timeoutId)
    pendingInvocations.delete(requestId)
    pending.resolve(response)
  }

  const rejectInvocation = (requestId: string | undefined, message: string): void => {
    if (requestId === undefined) {
      rejectPendingInvocations(message)
      return
    }
    const pending = pendingInvocations.get(requestId)
    if (!pending) return
    clearTimeout(pending.timeoutId)
    pendingInvocations.delete(requestId)
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
        rejectPendingInvocations('Realtime capability channel closed')
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
        if (parsed.type === 'capability.result') {
          resolveInvocation(parsed.requestId, parsed.outcome)
          return
        }
        if (parsed.type === 'capability.error') {
          rejectInvocation(parsed.requestId, parsed.message)
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
      rejectPendingInvocations('Realtime capability channel disconnected')
    },
    canCarry,
    statusFor: (id): 'open' | 'connecting' | 'other' => {
      if (socketId !== id || socket === null) return 'other'
      if (socket.readyState === WebSocket.OPEN) return 'open'
      if (socket.readyState === WebSocket.CONNECTING) return 'connecting'
      return 'other'
    },
    invokeCapability: async (id, invocation): Promise<CapabilityInvocationResponse> => {
      if (socketId !== id || socket === null || socket.readyState !== WebSocket.OPEN) {
        throw new Error('Realtime capability channel is not open')
      }
      const activeSocket = socket
      const requestId = `rtcmd:${crypto.randomUUID()}`
      return await new Promise<CapabilityInvocationResponse>((resolve, reject): void => {
        const timeoutId = window.setTimeout(() => {
          pendingInvocations.delete(requestId)
          reject(new Error('Realtime capability invocation timed out'))
        }, 2_500)
        pendingInvocations.set(requestId, {
          resolve,
          reject,
          timeoutId,
        })
        activeSocket.send(JSON.stringify({
          type: 'capability.invoke',
          requestId,
          capabilityId: invocation.capabilityId,
          invocation: {
            input: invocation.input,
            ...(invocation.expectedRevision === undefined ? {} : { expectedRevision: invocation.expectedRevision }),
            ...(invocation.idempotencyKey === undefined ? {} : { idempotencyKey: invocation.idempotencyKey }),
          },
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
