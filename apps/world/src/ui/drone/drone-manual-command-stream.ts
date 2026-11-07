import type { DroneManualAxes } from '../../packs/drone/model.ts'

export type DroneManualInputSourceKind = 'keyboard' | 'mouse' | 'gamepad'

interface ManualInput {
  readonly axes: DroneManualAxes
  readonly sourceKind: DroneManualInputSourceKind
  readonly nowMs: number
}

const zeroAxes: DroneManualAxes = { forward: 0, right: 0, vertical: 0, yaw: 0 }
export const droneManualAxesSignature = (axes: DroneManualAxes): string =>
  [axes.forward, axes.right, axes.vertical, axes.yaw].map(value => value.toFixed(2)).join('|')

const neutral = droneManualAxesSignature(zeroAxes)

/** Send current input only. A failed send never leaves a sample to replay. */
export const createDroneManualInputStream = (config: {
  readonly sendIntervalMs: number
  readonly activeKeepaliveMs: number
  readonly send: (input: ManualInput) => void
  readonly onError: (error: unknown) => void
}) => {
  let lastAxes = neutral
  let lastSource: DroneManualInputSourceKind = 'keyboard'
  let lastAttemptAt = Number.NEGATIVE_INFINITY
  let lastSentAt = Number.NEGATIVE_INFINITY

  const send = (input: ManualInput, signature: string): void => {
    lastAttemptAt = input.nowMs
    try {
      config.send(input)
      lastAxes = signature
      lastSource = input.sourceKind
      lastSentAt = input.nowMs
    } catch (error) {
      config.onError(error)
    }
  }

  return {
    update: (input: ManualInput): void => {
      const signature = droneManualAxesSignature(input.axes)
      if (input.nowMs - lastAttemptAt < config.sendIntervalMs) return
      if (signature !== lastAxes || (signature !== neutral && input.nowMs - lastSentAt >= config.activeKeepaliveMs)) {
        send(input, signature)
      }
    },
    release: (nowMs: number): void => {
      if (lastAxes !== neutral) send({ axes: zeroAxes, sourceKind: lastSource, nowMs }, neutral)
      lastAxes = neutral
      lastAttemptAt = Number.NEGATIVE_INFINITY
      lastSentAt = Number.NEGATIVE_INFINITY
    },
  }
}
