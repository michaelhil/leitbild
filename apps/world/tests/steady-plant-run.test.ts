import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { createSteadyPlantRun } from './steady-plant-run.ts'

test('steady Plant fixture owns its runtime until shutdown, including a queued idle-close race', async () => {
  const timers: Array<{ close: () => Promise<void>; disarmed: boolean }> = []
  const plant = await createSteadyPlantRun({ idleRuntimeCloseTimer: close => {
    const timer = { close, disarmed: false }
    timers.push(timer)
    return () => { timer.disarmed = true }
  } })
  try {
    expect(timers.length).toBeGreaterThan(0)
    expect(timers.every(timer => timer.disarmed)).toBe(true)
    // A timer callback already queued before disarm must still observe the
    // active registry lease. No wall-time waiting or changed TTL is involved.
    for (const timer of [...timers]) await timer.close()
    await plant.runTo(1_000)
    expect(plant.unit().id).toBe(plant.plantId)
    await plant.shutdown()
    expect(timers.every(timer => timer.disarmed)).toBe(true)
  } finally { await plant.remove() }
  expect(existsSync(plant.dataDir)).toBe(false)
})
