import { describe,expect,test } from 'bun:test'
import { createDroneFixedStepScheduler } from '../src/packs/drone/native/fixed-step.ts'

describe('drone fixed-step scheduler', () => {
  test('accumulates partial simulation time into fixed simulation steps', () => {
    const scheduler = createDroneFixedStepScheduler({
      stepMs: 20,
      maxCatchUpSteps: 5,
      initialSimulationMs: 1_000,
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
      initialSimulationMs: 1_000,
    })

    const plan = scheduler.advance(1_100)

    expect(plan.accumulatedMs).toBe(0)
    expect(plan.steps).toHaveLength(5)
    expect(plan.steps.map(step => step.dtSeconds)).toEqual([0.02, 0.02, 0.02, 0.02, 0.02])
    expect(plan.steps.map(step => step.nowMs)).toEqual([1_020, 1_040, 1_060, 1_080, 1_100])
  })

  test('bounds per-turn work but retains every step after a long stall', () => {
    const scheduler = createDroneFixedStepScheduler({
      stepMs: 20,
      maxCatchUpSteps: 3,
      initialSimulationMs: 1_000,
    })

    const plan = scheduler.advance(1_200)

    expect(plan.accumulatedMs).toBe(140)
    expect(plan.steps).toEqual([
      { nowMs: 1_020, dtSeconds: 0.02 },
      { nowMs: 1_040, dtSeconds: 0.02 },
      { nowMs: 1_060, dtSeconds: 0.02 },
    ])
    expect(scheduler.advance(1_220).steps).toEqual([
      { nowMs: 1_080, dtSeconds: 0.02 },
      { nowMs: 1_100, dtSeconds: 0.02 },
      { nowMs: 1_120, dtSeconds: 0.02 },
    ])
  })

  test('reset clears partial accumulated time', () => {
    const scheduler = createDroneFixedStepScheduler({
      stepMs: 20,
      maxCatchUpSteps: 5,
      initialSimulationMs: 1_000,
    })

    scheduler.advance(1_010)
    scheduler.reset(2_000)

    expect(scheduler.advance(2_010).steps).toEqual([])
    expect(scheduler.advance(2_020).steps).toEqual([
      { nowMs: 2_020, dtSeconds: 0.02 },
    ])
  })
})
