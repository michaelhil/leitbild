import { describe, expect, test } from 'bun:test'
import {
  completeStartupStep,
  createStartupSteps,
  failStartupStep,
  resetStartupStepsAfter,
  startupHasFailed,
  startupIsReady,
  startupModalShouldShow,
  startStartupStep,
} from '../src/ui/startup.ts'

describe('startup progress model', () => {
  test('tracks independent step progress without requiring linear completion', () => {
    let steps = createStartupSteps(10)

    steps = completeStartupStep(steps, 'map', 20)
    steps = completeStartupStep(steps, 'route', 30)

    expect(steps.find(step => step.id === 'map')?.status).toBe('done')
    expect(steps.find(step => step.id === 'control-instance')?.status).toBe('pending')
    expect(steps.find(step => step.id === 'route')?.completedAtMs).toBe(30)
  })

  test('preserves earlier work when retrying from a later startup step', () => {
    let steps = createStartupSteps(10)
    steps = completeStartupStep(steps, 'route', 20)
    steps = completeStartupStep(steps, 'interface', 30)
    steps = startStartupStep(steps, 'control-instance', 40)
    steps = failStartupStep(steps, 'control-instance', 'join failed', 50)

    const reset = resetStartupStepsAfter(steps, 'control-instance')

    expect(reset.find(step => step.id === 'route')?.status).toBe('done')
    expect(reset.find(step => step.id === 'interface')?.status).toBe('done')
    expect(reset.find(step => step.id === 'control-instance')?.status).toBe('pending')
    expect(reset.find(step => step.id === 'control-instance')?.error).toBeUndefined()
  })

  test('reports readiness and failure explicitly', () => {
    let steps = createStartupSteps(10)
    for (const step of steps) steps = completeStartupStep(steps, step.id, 20)

    expect(startupIsReady(steps)).toBe(true)
    expect(startupHasFailed(steps)).toBe(false)

    const failed = failStartupStep(steps, 'realtime', 'socket failed', 30)

    expect(startupIsReady(failed)).toBe(false)
    expect(startupHasFailed(failed)).toBe(true)
  })

  test('keeps startup modal visible until the UI lifecycle dismisses it', () => {
    let steps = createStartupSteps(10)
    for (const step of steps) steps = completeStartupStep(steps, step.id, 20)

    expect(startupModalShouldShow({
      routeMode: 'control-instance',
      dismissed: false,
      steps,
    })).toBe(true)

    expect(startupModalShouldShow({
      routeMode: 'control-instance',
      dismissed: true,
      steps,
    })).toBe(false)
  })

  test('does not show startup modal on the picker route', () => {
    const steps = createStartupSteps(10)

    expect(startupModalShouldShow({
      routeMode: 'picker',
      dismissed: false,
      steps,
    })).toBe(false)
  })
})
