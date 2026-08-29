import type { DroneManualAxes } from '../../packs/drone/model.ts'

export type DroneManualInputSourceKind = 'keyboard' | 'mouse' | 'gamepad'

export interface DroneManualCommandStreamInput {
  readonly axes: DroneManualAxes
  readonly sourceKind: DroneManualInputSourceKind
  readonly nowMs: number
  readonly blockReason?: string | undefined
}

export interface DroneManualCommandSendInput {
  readonly axes: DroneManualAxes
  readonly sourceKind: DroneManualInputSourceKind
  readonly sequence: number
  readonly startedAtMs: number
}

export interface DroneManualCommandSendEvent {
  readonly sequence: number
  readonly startedAtMs: number
}

export interface DroneManualCommandResultEvent<T> {
  readonly sequence: number
  readonly startedAtMs: number
  readonly roundTripMs: number
  readonly value: T
  readonly stale: boolean
}

export interface DroneManualCommandErrorEvent {
  readonly sequence: number
  readonly startedAtMs: number
  readonly roundTripMs: number
  readonly error: unknown
  readonly stale: boolean
}

export interface DroneManualCommandBlockEvent {
  readonly reason: string
  readonly nowMs: number
}

export interface DroneManualCommandStreamSnapshot {
  readonly inFlight: number
  readonly hasPending: boolean
  readonly lastSentAtMs: number
  readonly latestStartedSequence: number
}

export interface DroneManualCommandStreamConfig<T> {
  readonly sendIntervalMs: number
  readonly activeKeepaliveMs: number
  readonly maxInFlight: number
  readonly send: (input: DroneManualCommandSendInput) => Promise<T>
  readonly nowMs?: () => number
  readonly onSend?: (event: DroneManualCommandSendEvent) => void
  readonly onResult?: (event: DroneManualCommandResultEvent<T>) => void
  readonly onError?: (event: DroneManualCommandErrorEvent) => void
  readonly onBlocked?: (event: DroneManualCommandBlockEvent) => void
}

export interface DroneManualCommandStream<T> {
  readonly update: (input: DroneManualCommandStreamInput) => void
  readonly reset: () => void
  readonly snapshot: () => DroneManualCommandStreamSnapshot
}

interface PendingManualCommand {
  readonly axes: DroneManualAxes
  readonly sourceKind: DroneManualInputSourceKind
}

export const droneManualAxesSignature = (axes: DroneManualAxes): string =>
  [axes.forward, axes.right, axes.vertical, axes.yaw].map(value => value.toFixed(2)).join('|')

export const droneManualAxesAreActive = (axes: DroneManualAxes): boolean =>
  Math.abs(axes.forward) > 0
  || Math.abs(axes.right) > 0
  || Math.abs(axes.vertical) > 0
  || Math.abs(axes.yaw) > 0

const defaultNowMs = (): number =>
  typeof performance === 'undefined' ? Date.now() : performance.now()

const clampMaxInFlight = (value: number): number =>
  Math.max(1, Math.min(8, Math.floor(value)))

export const createDroneManualCommandStream = <T>(
  config: DroneManualCommandStreamConfig<T>,
): DroneManualCommandStream<T> => {
  const nowMs = config.nowMs ?? defaultNowMs
  const maxInFlight = clampMaxInFlight(config.maxInFlight)
  const zeroSignature = droneManualAxesSignature({ forward: 0, right: 0, vertical: 0, yaw: 0 })
  const initialLastSentAtMs = -Math.max(0, config.sendIntervalMs)

  let pending: PendingManualCommand | null = null
  let inFlight = 0
  let sequence = 0
  let lastSentAtMs = initialLastSentAtMs
  let lastAxesSignature = zeroSignature
  let latestStartedSequence = 0
  let lastBlockReason = ''
  let lastBlockAtMs = 0

  const emitBlocked = (reason: string, atMs: number): void => {
    if (reason === lastBlockReason && atMs - lastBlockAtMs < 1_000) return
    lastBlockReason = reason
    lastBlockAtMs = atMs
    config.onBlocked?.({ reason, nowMs: atMs })
  }

  const deliveryIsDue = (atMs: number): boolean =>
    atMs - lastSentAtMs >= config.sendIntervalMs

  const runDelivery = async (
    command: PendingManualCommand,
    commandSequence: number,
    startedAtMs: number,
  ): Promise<void> => {
    try {
      const value = await config.send({
        axes: command.axes,
        sourceKind: command.sourceKind,
        sequence: commandSequence,
        startedAtMs,
      })
      const settledAtMs = nowMs()
      config.onResult?.({
        sequence: commandSequence,
        startedAtMs,
        roundTripMs: settledAtMs - startedAtMs,
        value,
        stale: commandSequence < latestStartedSequence,
      })
    } catch (error) {
      const settledAtMs = nowMs()
      config.onError?.({
        sequence: commandSequence,
        startedAtMs,
        roundTripMs: settledAtMs - startedAtMs,
        error,
        stale: commandSequence < latestStartedSequence,
      })
    } finally {
      inFlight = Math.max(0, inFlight - 1)
      pump(nowMs())
    }
  }

  const startDelivery = (command: PendingManualCommand, atMs: number): void => {
    pending = null
    inFlight += 1
    sequence += 1
    latestStartedSequence = sequence
    lastSentAtMs = atMs
    config.onSend?.({ sequence, startedAtMs: atMs })
    void runDelivery(command, sequence, atMs)
  }

  function pump(atMs: number): void {
    if (pending === null || inFlight >= maxInFlight || !deliveryIsDue(atMs)) return
    startDelivery(pending, atMs)
  }

  const update = (input: DroneManualCommandStreamInput): void => {
    const active = droneManualAxesAreActive(input.axes)
    if (active && input.blockReason !== undefined && input.blockReason.trim().length > 0) {
      pending = null
      emitBlocked(input.blockReason, input.nowMs)
      return
    }

    const signature = droneManualAxesSignature(input.axes)
    const changed = signature !== lastAxesSignature
    const keepaliveDue = active && input.nowMs - lastSentAtMs >= config.activeKeepaliveMs
    if (!changed && !keepaliveDue) {
      pump(input.nowMs)
      return
    }

    pending = {
      axes: input.axes,
      sourceKind: input.sourceKind,
    }
    lastAxesSignature = signature
    pump(input.nowMs)
  }

  const reset = (): void => {
    pending = null
    lastAxesSignature = zeroSignature
    lastSentAtMs = initialLastSentAtMs
    lastBlockReason = ''
    lastBlockAtMs = 0
  }

  const snapshot = (): DroneManualCommandStreamSnapshot => ({
    inFlight,
    hasPending: pending !== null,
    lastSentAtMs,
    latestStartedSequence,
  })

  return { update, reset, snapshot }
}
