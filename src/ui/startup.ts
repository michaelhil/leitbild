export type StartupStepId =
  | 'route'
  | 'interface'
  | 'control-instance'
  | 'snapshot'
  | 'map'
  | 'objects'
  | 'realtime'
  | 'ready'

export type StartupStepStatus = 'pending' | 'running' | 'done' | 'failed'

export interface StartupStep {
  readonly id: StartupStepId
  readonly label: string
  readonly status: StartupStepStatus
  readonly startedAtMs?: number
  readonly completedAtMs?: number
  readonly error?: string
}

export const createStartupSteps = (nowMs = performance.now()): ReadonlyArray<StartupStep> => [
  { id: 'route', label: 'Read route', status: 'pending' },
  { id: 'interface', label: 'Prepare interface', status: 'pending' },
  { id: 'control-instance', label: 'Open Control Instance', status: 'pending' },
  { id: 'snapshot', label: 'Load snapshot', status: 'pending' },
  { id: 'map', label: 'Start map', status: 'pending', startedAtMs: nowMs },
  { id: 'objects', label: 'Render operational objects', status: 'pending' },
  { id: 'realtime', label: 'Connect realtime updates', status: 'pending' },
  { id: 'ready', label: 'Ready', status: 'pending' },
]

const updateStep = (
  steps: ReadonlyArray<StartupStep>,
  id: StartupStepId,
  update: (step: StartupStep) => StartupStep,
): ReadonlyArray<StartupStep> =>
  steps.map(step => step.id === id ? update(step) : step)

export const startStartupStep = (
  steps: ReadonlyArray<StartupStep>,
  id: StartupStepId,
  nowMs = performance.now(),
): ReadonlyArray<StartupStep> =>
  updateStep(steps, id, step => {
    const { error: _error, ...stepWithoutError } = step
    return {
      ...stepWithoutError,
      status: step.status === 'done' ? 'done' : 'running',
      startedAtMs: step.startedAtMs ?? nowMs,
    }
  })

export const completeStartupStep = (
  steps: ReadonlyArray<StartupStep>,
  id: StartupStepId,
  nowMs = performance.now(),
): ReadonlyArray<StartupStep> =>
  updateStep(steps, id, step => {
    const { error: _error, ...stepWithoutError } = step
    return {
      ...stepWithoutError,
      status: 'done',
      startedAtMs: step.startedAtMs ?? nowMs,
      completedAtMs: nowMs,
    }
  })

export const failStartupStep = (
  steps: ReadonlyArray<StartupStep>,
  id: StartupStepId,
  error: string,
  nowMs = performance.now(),
): ReadonlyArray<StartupStep> =>
  updateStep(steps, id, step => ({
    ...step,
    status: 'failed',
    startedAtMs: step.startedAtMs ?? nowMs,
    completedAtMs: nowMs,
    error,
  }))

export const resetStartupStepsAfter = (
  steps: ReadonlyArray<StartupStep>,
  firstResetStepId: StartupStepId,
): ReadonlyArray<StartupStep> => {
  const firstResetIndex = steps.findIndex(step => step.id === firstResetStepId)
  if (firstResetIndex < 0) throw new Error(`unknown startup step: ${firstResetStepId}`)
  return steps.map((step, index) => (
    index < firstResetIndex
      ? step
      : {
          id: step.id,
          label: step.label,
          status: 'pending',
        }
  ))
}

export const startupIsReady = (steps: ReadonlyArray<StartupStep>): boolean =>
  steps.every(step => step.status === 'done')

export const startupHasFailed = (steps: ReadonlyArray<StartupStep>): boolean =>
  steps.some(step => step.status === 'failed')

export const startupModalShouldShow = (config: {
  readonly routeMode: 'picker' | 'control-instance'
  readonly dismissed: boolean
  readonly steps: ReadonlyArray<StartupStep>
}): boolean =>
  config.routeMode === 'control-instance'
  && !config.dismissed
