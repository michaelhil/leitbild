export interface DroneFixedStepSchedulerConfig {
  readonly stepMs: number
  readonly maxCatchUpSteps: number
  readonly initialWallMs: number
}

export interface DroneFixedStep {
  readonly nowMs: number
  readonly dtSeconds: number
}

export interface DroneFixedStepPlan {
  readonly steps: ReadonlyArray<DroneFixedStep>
  readonly droppedMs: number
  readonly accumulatedMs: number
}

export interface DroneFixedStepScheduler {
  readonly advance: (wallNowMs: number) => DroneFixedStepPlan
  readonly reset: (wallNowMs: number) => void
}

const positiveFinite = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? value : fallback

export const createDroneFixedStepScheduler = (
  config: DroneFixedStepSchedulerConfig,
): DroneFixedStepScheduler => {
  const stepMs = positiveFinite(config.stepMs, 20)
  const maxCatchUpSteps = Math.max(1, Math.floor(positiveFinite(config.maxCatchUpSteps, 5)))
  const maxCatchUpMs = stepMs * maxCatchUpSteps
  let lastWallMs = config.initialWallMs
  let simulatedMs = config.initialWallMs
  let accumulatedMs = 0

  const reset = (wallNowMs: number): void => {
    lastWallMs = wallNowMs
    simulatedMs = wallNowMs
    accumulatedMs = 0
  }

  const advance = (wallNowMs: number): DroneFixedStepPlan => {
    const elapsedMs = Math.max(0, wallNowMs - lastWallMs)
    lastWallMs = wallNowMs

    let droppedMs = 0
    if (elapsedMs > maxCatchUpMs) {
      droppedMs = elapsedMs - maxCatchUpMs
      accumulatedMs = 0
      simulatedMs = wallNowMs - maxCatchUpMs
      accumulatedMs += maxCatchUpMs
    } else {
      accumulatedMs += elapsedMs
    }

    const steps: DroneFixedStep[] = []
    while (accumulatedMs + Number.EPSILON >= stepMs && steps.length < maxCatchUpSteps) {
      simulatedMs += stepMs
      accumulatedMs -= stepMs
      steps.push({
        nowMs: simulatedMs,
        dtSeconds: stepMs / 1_000,
      })
    }

    return {
      steps,
      droppedMs,
      accumulatedMs,
    }
  }

  return { advance, reset }
}
