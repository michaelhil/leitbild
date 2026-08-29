import { describe, expect, test } from 'bun:test'
import type { DroneManualAxes } from '../src/packs/drone/model.ts'
import {
  createDroneManualCommandStream,
  type DroneManualCommandSendInput,
  type DroneManualCommandResultEvent,
} from '../src/ui/drone/drone-manual-command-stream.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

interface RecordedDelivery<T> {
  readonly input: DroneManualCommandSendInput
  readonly deferred: Deferred<T>
}

const axes = (value: Partial<DroneManualAxes>): DroneManualAxes => ({
  forward: value.forward ?? 0,
  right: value.right ?? 0,
  vertical: value.vertical ?? 0,
  yaw: value.yaw ?? 0,
})

const createDeferred = <T>(): Deferred<T> => {
  let resolveValue: (value: T) => void = () => {}
  let rejectValue: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve
    rejectValue = reject
  })
  return {
    promise,
    resolve: resolveValue,
    reject: rejectValue,
  }
}

const flushAsync = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('drone manual command stream', () => {
  test('coalesces pending input to the latest axes while delivery is saturated', async () => {
    let nowMs = 0
    const deliveries: RecordedDelivery<string>[] = []
    const stream = createDroneManualCommandStream<string>({
      sendIntervalMs: 0,
      activeKeepaliveMs: 1_000,
      maxInFlight: 1,
      nowMs: () => nowMs,
      send: async input => {
        const deferred = createDeferred<string>()
        deliveries.push({ input, deferred })
        return await deferred.promise
      },
    })

    stream.update({ axes: axes({ forward: 1 }), sourceKind: 'keyboard', nowMs })
    nowMs = 5
    stream.update({ axes: axes({ right: 1 }), sourceKind: 'keyboard', nowMs })
    nowMs = 10
    stream.update({ axes: axes({ yaw: 1 }), sourceKind: 'keyboard', nowMs })

    expect(deliveries).toHaveLength(1)
    deliveries[0]!.deferred.resolve('first')
    await flushAsync()

    expect(deliveries).toHaveLength(2)
    expect(deliveries[1]!.input.axes).toEqual(axes({ yaw: 1 }))
  })

  test('marks older responses stale when a newer command has already started', async () => {
    let nowMs = 0
    const deliveries: RecordedDelivery<string>[] = []
    const results: DroneManualCommandResultEvent<string>[] = []
    const stream = createDroneManualCommandStream<string>({
      sendIntervalMs: 0,
      activeKeepaliveMs: 1_000,
      maxInFlight: 2,
      nowMs: () => nowMs,
      send: async input => {
        const deferred = createDeferred<string>()
        deliveries.push({ input, deferred })
        return await deferred.promise
      },
      onResult: result => {
        results.push(result)
      },
    })

    stream.update({ axes: axes({ forward: 1 }), sourceKind: 'keyboard', nowMs })
    nowMs = 1
    stream.update({ axes: axes({ yaw: 1 }), sourceKind: 'keyboard', nowMs })

    expect(deliveries).toHaveLength(2)
    nowMs = 20
    deliveries[0]!.deferred.resolve('older')
    await flushAsync()
    nowMs = 25
    deliveries[1]!.deferred.resolve('newer')
    await flushAsync()

    expect(results.map(result => ({ value: result.value, stale: result.stale }))).toEqual([
      { value: 'older', stale: true },
      { value: 'newer', stale: false },
    ])
  })

  test('keeps active controls alive at the configured cadence', async () => {
    const deliveries: DroneManualCommandSendInput[] = []
    const stream = createDroneManualCommandStream<string>({
      sendIntervalMs: 50,
      activeKeepaliveMs: 100,
      maxInFlight: 3,
      send: async input => {
        deliveries.push(input)
        return 'ok'
      },
    })

    stream.update({ axes: axes({ forward: 1 }), sourceKind: 'keyboard', nowMs: 0 })
    await flushAsync()
    stream.update({ axes: axes({ forward: 1 }), sourceKind: 'keyboard', nowMs: 40 })
    await flushAsync()
    stream.update({ axes: axes({ forward: 1 }), sourceKind: 'keyboard', nowMs: 100 })
    await flushAsync()

    expect(deliveries.map(delivery => delivery.startedAtMs)).toEqual([0, 100])
  })

  test('throttles repeated blocked input without enqueueing a command', () => {
    const deliveries: DroneManualCommandSendInput[] = []
    const blocked: string[] = []
    const stream = createDroneManualCommandStream<string>({
      sendIntervalMs: 0,
      activeKeepaliveMs: 100,
      maxInFlight: 1,
      send: async input => {
        deliveries.push(input)
        return 'ok'
      },
      onBlocked: event => {
        blocked.push(`${event.nowMs}:${event.reason}`)
      },
    })

    stream.update({ axes: axes({ forward: 1 }), sourceKind: 'keyboard', nowMs: 0, blockReason: 'selected object is not a drone' })
    stream.update({ axes: axes({ forward: 1 }), sourceKind: 'keyboard', nowMs: 500, blockReason: 'selected object is not a drone' })
    stream.update({ axes: axes({ forward: 1 }), sourceKind: 'keyboard', nowMs: 1_200, blockReason: 'selected object is not a drone' })

    expect(deliveries).toHaveLength(0)
    expect(blocked).toEqual([
      '0:selected object is not a drone',
      '1200:selected object is not a drone',
    ])
  })

  test('sends neutral axes after active controls return to zero', async () => {
    const deliveries: DroneManualCommandSendInput[] = []
    const stream = createDroneManualCommandStream<string>({
      sendIntervalMs: 50,
      activeKeepaliveMs: 100,
      maxInFlight: 2,
      send: async input => {
        deliveries.push(input)
        return 'ok'
      },
    })

    stream.update({ axes: axes({ forward: 1 }), sourceKind: 'keyboard', nowMs: 0 })
    await flushAsync()
    stream.update({ axes: axes({}), sourceKind: 'keyboard', nowMs: 60 })
    await flushAsync()

    expect(deliveries.map(delivery => delivery.axes)).toEqual([
      axes({ forward: 1 }),
      axes({}),
    ])
  })
})
