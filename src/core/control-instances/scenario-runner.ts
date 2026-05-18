import type { ScenarioInstanceState, ScenarioScript, ScenarioScriptStep } from '../model/index.ts'

export interface ScenarioDueStepConfig {
  readonly script: ScenarioScript
  readonly state: ScenarioInstanceState
  readonly nowMs: number
}

export interface ScenarioScriptRunner {
  readonly start: () => void
  readonly close: () => void
}

const timeMs = (iso: string): number => {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) throw new Error(`invalid scenario script timestamp: ${iso}`)
  return parsed
}

const stepDueAtMs = (step: ScenarioScriptStep, scenarioStartedAtMs: number): number => {
  if (step.at.kind === 'after_scenario_start') return scenarioStartedAtMs + step.at.seconds * 1000
  throw new Error(`unsupported scenario script time reference: ${(step.at as { readonly kind: string }).kind}`)
}

export const dueScenarioScriptSteps = (config: ScenarioDueStepConfig): ReadonlyArray<ScenarioScriptStep> => {
  const scriptState = config.state.script
  if (!scriptState) return []
  const scenarioStartedAtMs = timeMs(scriptState.startedAt)
  const firedStepIds = new Set(scriptState.firedStepIds)
  return config.script.steps
    .filter(step => !firedStepIds.has(step.id))
    .filter(step => stepDueAtMs(step, scenarioStartedAtMs) <= config.nowMs)
    .sort((left, right) =>
      stepDueAtMs(left, scenarioStartedAtMs) - stepDueAtMs(right, scenarioStartedAtMs)
      || left.id.localeCompare(right.id))
}

export const createScenarioScriptRunner = (config: {
  readonly script: ScenarioScript
  readonly state: ScenarioInstanceState
  readonly nowMs: () => number
  readonly delayMs?: (dueAtMs: number, nowMs: number) => number
  readonly onStepDue: (step: ScenarioScriptStep) => Promise<void>
}): ScenarioScriptRunner => {
  const timeoutIds = new Set<ReturnType<typeof setTimeout>>()
  let closed = false

  const clearTimers = (): void => {
    for (const timeoutId of timeoutIds) clearTimeout(timeoutId)
    timeoutIds.clear()
  }

  const runStep = async (step: ScenarioScriptStep): Promise<void> => {
    if (closed) return
    try {
      await config.onStepDue(step)
    } catch (err) {
      console.error(err)
    }
  }

  const start = (): void => {
    clearTimers()
    const scriptState = config.state.script
    if (!scriptState) return
    const scenarioStartedAtMs = timeMs(scriptState.startedAt)
    const firedStepIds = new Set(scriptState.firedStepIds)
    for (const step of config.script.steps) {
      if (firedStepIds.has(step.id)) continue
      const nowMs = config.nowMs()
      const dueAtMs = stepDueAtMs(step, scenarioStartedAtMs)
      const delayMs = config.delayMs
        ? config.delayMs(dueAtMs, nowMs)
        : Math.max(0, dueAtMs - nowMs)
      const timeoutId = setTimeout(() => {
        timeoutIds.delete(timeoutId)
        void runStep(step)
      }, delayMs)
      timeoutIds.add(timeoutId)
    }
  }

  return {
    start,
    close: (): void => {
      closed = true
      clearTimers()
    },
  }
}
