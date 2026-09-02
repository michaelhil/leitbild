export interface DroneFixedStepSchedulerConfig {
  readonly stepMs: number
  readonly maxCatchUpSteps: number
  readonly initialSimulationMs: number
}

export interface DroneFixedStep {
  readonly nowMs: number
  readonly dtSeconds: number
}

export interface DroneFixedStepPlan {
  readonly steps: ReadonlyArray<DroneFixedStep>
  readonly accumulatedMs: number
}

export interface DroneFixedStepScheduler {
  readonly advance: (simulationNowMs: number) => DroneFixedStepPlan
  readonly reset: (simulationNowMs: number) => void
}

const positiveFinite = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? value : fallback

export const createDroneFixedStepScheduler = (
  config: DroneFixedStepSchedulerConfig,
): DroneFixedStepScheduler => {
  const stepMs = positiveFinite(config.stepMs, 20)
  const maxCatchUpSteps = Math.max(1, Math.floor(positiveFinite(config.maxCatchUpSteps, 5)))
  let lastTargetMs = config.initialSimulationMs
  let simulatedMs = config.initialSimulationMs
  let accumulatedMs = 0

  const reset = (simulationNowMs: number): void => {
    lastTargetMs = simulationNowMs
    simulatedMs = simulationNowMs
    accumulatedMs = 0
  }

  const advance = (simulationNowMs: number): DroneFixedStepPlan => {
    const elapsedMs = Math.max(0, simulationNowMs - lastTargetMs)
    lastTargetMs = Math.max(lastTargetMs, simulationNowMs)
    accumulatedMs += elapsedMs

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
      accumulatedMs,
    }
  }

  return { advance, reset }
}
