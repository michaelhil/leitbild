import { describe, expect, test } from 'bun:test'
import { createDroneFixedStepScheduler } from '../src/packs/drone/native/fixed-step.ts'

describe('drone fixed-step scheduler', () => {
  test('accumulates partial wall time into fixed simulation steps', () => {
    const scheduler = createDroneFixedStepScheduler({
      stepMs: 20,
      maxCatchUpSteps: 5,
      initialWallMs: 1_000,
    })

    expect(scheduler.advance(1_010).steps).toEqual([])
    expect(scheduler.advance(1_020).steps).toEqual([
      { nowMs: 1_020, dtSeconds: 0.02 },
    ])
  })

  test('splits delayed ticks into bounded fixed steps', () => {
    const scheduler = createDroneFixedStepScheduler({
      stepMs: 20,
      maxCatchUpSteps: 5,
      initialWallMs: 1_000,
    })

    const plan = scheduler.advance(1_100)

    expect(plan.droppedMs).toBe(0)
    expect(plan.steps).toHaveLength(5)
    expect(plan.steps.map(step => step.dtSeconds)).toEqual([0.02, 0.02, 0.02, 0.02, 0.02])
    expect(plan.steps.map(step => step.nowMs)).toEqual([1_020, 1_040, 1_060, 1_080, 1_100])
  })

  test('drops excess backlog and resynchronizes to current wall time after a long stall', () => {
    const scheduler = createDroneFixedStepScheduler({
      stepMs: 20,
      maxCatchUpSteps: 3,
      initialWallMs: 1_000,
    })

    const plan = scheduler.advance(1_200)

    expect(plan.droppedMs).toBe(140)
    expect(plan.steps).toEqual([
      { nowMs: 1_160, dtSeconds: 0.02 },
      { nowMs: 1_180, dtSeconds: 0.02 },
      { nowMs: 1_200, dtSeconds: 0.02 },
    ])
    expect(scheduler.advance(1_220).steps).toEqual([
      { nowMs: 1_220, dtSeconds: 0.02 },
    ])
  })

  test('reset clears partial accumulated time', () => {
    const scheduler = createDroneFixedStepScheduler({
      stepMs: 20,
      maxCatchUpSteps: 5,
      initialWallMs: 1_000,
    })

    scheduler.advance(1_010)
    scheduler.reset(2_000)

    expect(scheduler.advance(2_010).steps).toEqual([])
    expect(scheduler.advance(2_020).steps).toEqual([
      { nowMs: 2_020, dtSeconds: 0.02 },
    ])
  })
})
