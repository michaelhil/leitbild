import { describe, expect, test } from 'bun:test'
import {
  completeStartupStep,
  createStartupSteps,
  failStartupStep,
  resetStartupStepsAfter,
  setStartupStepDetails,
  startupHasFailed,
  startupIsReady,
  startupModalShouldShow,
  startupStepsAwaited,
  startStartupStep,
} from '../src/ui/startup.ts'

describe('startup progress model', () => {
  test('tracks independent step progress without requiring linear completion', () => {
    let steps = createStartupSteps(10)

    steps = completeStartupStep(steps, 'map', 20)
    steps = completeStartupStep(steps, 'route', 30)

    expect(steps.find(step => step.id === 'map')?.status).toBe('done')
    expect(steps.find(step => step.id === 'simulation-run')?.status).toBe('pending')
    expect(steps.find(step => step.id === 'route')?.completedAtMs).toBe(30)
  })

  test('preserves earlier work when retrying from a later startup step', () => {
    let steps = createStartupSteps(10)
    steps = completeStartupStep(steps, 'route', 20)
    steps = completeStartupStep(steps, 'interface', 30)
    steps = startStartupStep(steps, 'simulation-run', 40)
    steps = failStartupStep(steps, 'simulation-run', 'join failed', 50)

    const reset = resetStartupStepsAfter(steps, 'simulation-run')

    expect(reset.find(step => step.id === 'route')?.status).toBe('done')
    expect(reset.find(step => step.id === 'interface')?.status).toBe('done')
    expect(reset.find(step => step.id === 'simulation-run')?.status).toBe('pending')
    expect(reset.find(step => step.id === 'simulation-run')?.error).toBeUndefined()
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

  test('does not create a new startup step array when diagnostic details are unchanged', () => {
    let steps = createStartupSteps(10)
    const details = [{ label: 'base', value: 'ready' }]
    steps = setStartupStepDetails(steps, 'map', details)

    const unchanged = setStartupStepDetails(steps, 'map', details)

    expect(unchanged).toBe(steps)
  })

  test('does not report readiness after a map failure', () => {
    let steps = createStartupSteps(10)
    for (const step of steps.filter(step => step.id !== 'map')) {
      steps = completeStartupStep(steps, step.id, 20)
    }

    expect(startupIsReady(steps)).toBe(true)

    const mapFailed = failStartupStep(steps, 'map', 'map failed', 30)
    expect(startupIsReady(mapFailed)).toBe(false)
    expect(startupHasFailed(mapFailed)).toBe(true)

    const realtimeFailed = failStartupStep(steps, 'realtime', 'socket failed', 30)
    expect(startupIsReady(realtimeFailed)).toBe(false)
  })

  test('shows the startup checklist while steps run or one failed, never once every step succeeded', () => {
    let steps = createStartupSteps(10)
    steps = completeStartupStep(steps, 'route', 20)
    expect(startupModalShouldShow({ routeMode: 'simulation-run', dismissed: false, steps })).toBe(true)
    expect(startupModalShouldShow({ routeMode: 'simulation-run', dismissed: true, steps })).toBe(false)

    expect(startupModalShouldShow({ routeMode: 'simulation-run', dismissed: false, steps: failStartupStep(steps, 'map', 'map failed', 30) })).toBe(true)

    for (const step of steps) steps = completeStartupStep(steps, step.id, 20)
    expect(startupModalShouldShow({ routeMode: 'simulation-run', dismissed: false, steps })).toBe(false)
  })

  test('a surface page\'s startup neither waits for the base map nor fails with it; every other failure still counts', () => {
    let steps = createStartupSteps(10)
    expect(startupStepsAwaited(steps, { map: true })).toBe(steps)
    expect(startupStepsAwaited(steps, { map: false }).map(step => step.id)).toEqual(['route', 'interface', 'simulation-run', 'snapshot', 'objects', 'realtime', 'ready'])

    // The map still starting: the Run page waits behind its checklist, the surface page is ready.
    for (const step of steps.filter(step => step.id !== 'map')) steps = completeStartupStep(steps, step.id, 20)
    steps = startStartupStep(steps, 'map', 25)
    const surface = (list: typeof steps) => startupStepsAwaited(list, { map: false })
    expect(startupIsReady(surface(steps))).toBe(true)
    expect(startupModalShouldShow({ routeMode: 'simulation-run', dismissed: false, steps: surface(steps) })).toBe(false)

    // The map failed ("Base map did not become ready"): the Run page says so, the surface page is neither failed nor covered.
    const mapFailed = failStartupStep(steps, 'map', 'Base map did not become ready', 30)
    expect(startupHasFailed(mapFailed)).toBe(true)
    expect(startupModalShouldShow({ routeMode: 'simulation-run', dismissed: false, steps: mapFailed })).toBe(true)
    expect(startupHasFailed(surface(mapFailed))).toBe(false)
    expect(startupIsReady(surface(mapFailed))).toBe(true)
    expect(startupModalShouldShow({ routeMode: 'simulation-run', dismissed: false, steps: surface(mapFailed) })).toBe(false)
    // The failure itself is kept for the page's status and diagnostics.
    expect(mapFailed.find(step => step.id === 'map')).toMatchObject({ status: 'failed', error: 'Base map did not become ready' })

    // A refused join or a failed realtime channel keeps today's dialog on a surface page too.
    for (const id of ['simulation-run', 'snapshot', 'objects', 'realtime'] as const) {
      const failed = failStartupStep(mapFailed, id, `${id} failed`, 40)
      expect(startupHasFailed(surface(failed))).toBe(true)
      expect(startupIsReady(surface(failed))).toBe(false)
      expect(startupModalShouldShow({ routeMode: 'simulation-run', dismissed: false, steps: surface(failed) })).toBe(true)
    }
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
