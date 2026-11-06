import { expect, test } from 'bun:test'
import type { DroneManualAxes } from '../src/packs/drone/model.ts'
import { createDroneManualInputStream } from '../src/ui/drone/drone-manual-command-stream.ts'

const axes = (forward = 0): DroneManualAxes => ({ forward, right: 0, vertical: 0, yaw: 0 })
const sample = (nowMs: number, forward = 0) => ({ axes: axes(forward), sourceKind: 'keyboard' as const, nowMs })

test('sends current changes and active keepalives at the configured cadence', () => {
  const deliveries: Array<ReturnType<typeof sample>> = []
  const stream = createDroneManualInputStream({ sendIntervalMs: 50, activeKeepaliveMs: 100,
    send: input => deliveries.push({ ...input, sourceKind: 'keyboard' }), onError: error => { throw error } })
  for (const input of [sample(0, 1), sample(15, -1), sample(50, 0.5), sample(100, 0.5), sample(150, 0.5), sample(200)]) stream.update(input)
  expect(deliveries).toEqual([sample(0, 1), sample(50, 0.5), sample(150, 0.5), sample(200)])
})

test('drops a failed sample and releases active axes immediately on blur or close', () => {
  const deliveries: DroneManualAxes[] = []
  const errors: unknown[] = []
  let connected = false
  const stream = createDroneManualInputStream({ sendIntervalMs: 50, activeKeepaliveMs: 100,
    send: ({ axes }) => { if (!connected) throw new Error('disconnected'); deliveries.push(axes) },
    onError: error => errors.push(error) })
  stream.update(sample(0, 1))
  connected = true
  stream.update(sample(60))
  expect(deliveries).toEqual([])
  stream.update(sample(65, -1))
  stream.release(66)
  stream.release(67)
  expect(deliveries).toEqual([axes(-1), axes()])
  expect(errors).toHaveLength(1)
})
